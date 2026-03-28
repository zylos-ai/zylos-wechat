#!/usr/bin/env node
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { config, ensureDirs, paths } from './lib/config.js';
import { createLogger } from './lib/logger.js';
import { sendToC4 } from './lib/bridge.js';
import { AccountManager } from './lib/account-manager.js';
import { ContextTokenStore } from './lib/context-tokens.js';
import { TypingManager } from './lib/typing.js';
import { downloadMedia } from './lib/media-upload.js';
import { decodeAesKey } from './lib/media-crypto.js';

const logger = createLogger(config.logLevel);

if (!config.enabled) {
  logger.info('component disabled by config');
  process.exit(0);
}

ensureDirs();

// --- Core state ---

const dataDir = paths.dataDir;
const manager = new AccountManager(dataDir);
const contextTokens = new ContextTokenStore({
  persistPath: join(dataDir, 'context-tokens.json'),
});
const typingManagers = new Map(); // normalizedId → TypingManager

// In-memory dedupe set (msg_id + account, with max size)
let seenMessages = new Set();
const DEDUPE_MAX = 10_000;

function markSeen(key) {
  seenMessages.add(key);
  if (seenMessages.size > DEDUPE_MAX) {
    const arr = [...seenMessages];
    seenMessages = new Set(arr.slice(-DEDUPE_MAX + 1000));
  }
}

// --- Message handling ---

/** Media dir for inbound downloads */
const MEDIA_DIR = join(paths.dataDir, 'media');

/** Item type constants (matching WeChat API) */
const ITEM_TYPE = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 };

/** Type label for C4 message format */
const TYPE_LABEL = {
  [ITEM_TYPE.IMAGE]: 'image',
  [ITEM_TYPE.VOICE]: 'voice',
  [ITEM_TYPE.FILE]: 'file',
  [ITEM_TYPE.VIDEO]: 'video',
};

function isMediaItem(item) {
  return [ITEM_TYPE.IMAGE, ITEM_TYPE.VOICE, ITEM_TYPE.FILE, ITEM_TYPE.VIDEO].includes(item.type);
}

/**
 * Extract text body from item_list, handling ref_msg (quoted messages)
 * and voice-to-text transcription.
 *
 * Returns { text, quotedContext } where quotedContext is null or
 * { sender, text } for <replying-to> formatting.
 */
function extractBody(msg) {
  if (!msg.item_list || msg.item_list.length === 0) return { text: '', quotedContext: null };

  for (const item of msg.item_list) {
    if (item.type === ITEM_TYPE.TEXT && item.text_item?.text != null) {
      const text = String(item.text_item.text);
      const ref = item.ref_msg;
      if (!ref) return { text, quotedContext: null };

      // Quoted media — just use the current text as body (media passed separately)
      if (ref.message_item && isMediaItem(ref.message_item)) {
        return { text, quotedContext: null };
      }

      // Build quoted context from title and message_item content
      const parts = [];
      if (ref.title) parts.push(ref.title);
      if (ref.message_item) {
        const refBody = extractBodyFromItems([ref.message_item]);
        if (refBody) parts.push(refBody);
      }

      if (!parts.length) return { text, quotedContext: null };

      const quotedText = parts.join(' | ');
      return {
        text,
        quotedContext: {
          sender: ref.title || 'unknown',
          text: quotedText,
        },
      };
    }

    // Voice-to-text: if voice message has text transcription, use it directly
    if (item.type === ITEM_TYPE.VOICE && item.voice_item?.text) {
      return { text: item.voice_item.text, quotedContext: null };
    }
  }

  return { text: '', quotedContext: null };
}

/** Helper: extract text from a sub-list of items (used for ref_msg.message_item) */
function extractBodyFromItems(items) {
  for (const item of items) {
    if (item.type === ITEM_TYPE.TEXT && item.text_item?.text != null) {
      return String(item.text_item.text);
    }
  }
  return '';
}

/**
 * Find the highest-priority media item from the message.
 * Priority: IMAGE > VIDEO > FILE > VOICE (matching OpenClaw).
 *
 * Returns null if no downloadable media item found. Skips voice items
 * that have text transcription (we use the text instead).
 */
function findMediaItem(msg) {
  if (!msg.item_list || msg.item_list.length === 0) return null;

  const priority = [ITEM_TYPE.IMAGE, ITEM_TYPE.VIDEO, ITEM_TYPE.FILE, ITEM_TYPE.VOICE];

  for (const targetType of priority) {
    for (const item of msg.item_list) {
      if (item.type !== targetType) continue;

      // Skip voice if it has text transcription — we use the text directly
      if (item.type === ITEM_TYPE.VOICE && item.voice_item?.text) continue;

      return item;
    }
  }

  return null;
}

/**
 * Extract CDN params and AES key from a media item.
 * Returns { encryptQueryParam, aesKey, ext, typeLabel } or null.
 */
function extractMediaParams(item) {
  let mediaObj, aesKeyRawHex, ext;

  switch (item.type) {
    case ITEM_TYPE.IMAGE: {
      const img = item.image_item;
      if (!img?.media?.encrypt_query_param && !img?.media?.full_url) return null;
      mediaObj = img.media;
      // For images: prefer image_item.aeskey (hex) over media.aes_key (base64)
      aesKeyRawHex = img.aeskey || null;
      ext = 'png';
      break;
    }
    case ITEM_TYPE.VOICE: {
      const voice = item.voice_item;
      if (!voice?.media?.encrypt_query_param && !voice?.media?.full_url) return null;
      if (!voice?.media?.aes_key) return null;
      mediaObj = voice.media;
      ext = 'silk';
      break;
    }
    case ITEM_TYPE.FILE: {
      const file = item.file_item;
      if (!file?.media?.encrypt_query_param && !file?.media?.full_url) return null;
      if (!file?.media?.aes_key) return null;
      mediaObj = file.media;
      const fileName = file.file_name || '';
      ext = fileName.includes('.') ? fileName.split('.').pop() : 'bin';
      break;
    }
    case ITEM_TYPE.VIDEO: {
      const video = item.video_item;
      if (!video?.media?.encrypt_query_param && !video?.media?.full_url) return null;
      if (!video?.media?.aes_key) return null;
      mediaObj = video.media;
      ext = 'mp4';
      break;
    }
    default:
      return null;
  }

  const encryptQueryParam = mediaObj.encrypt_query_param || mediaObj.full_url || '';
  if (!encryptQueryParam) return null;

  const aesKey = decodeAesKey(mediaObj.aes_key || '', aesKeyRawHex || undefined);
  const typeLabel = TYPE_LABEL[item.type] || 'file';

  return { encryptQueryParam, aesKey, ext, typeLabel };
}

/**
 * Download, decrypt, and save an inbound media file.
 * Returns the local file path on success, or null on failure.
 */
async function downloadInboundMedia(client, item) {
  const params = extractMediaParams(item);
  if (!params) return null;

  const { encryptQueryParam, aesKey, ext, typeLabel } = params;

  try {
    await mkdir(MEDIA_DIR, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const hex = randomBytes(4).toString('hex');
    const localPath = join(MEDIA_DIR, `wechat-${timestamp}-${hex}.${ext}`);

    const decrypted = await downloadMedia(client, encryptQueryParam, aesKey);
    await writeFile(localPath, decrypted);

    logger.info(`inbound ${typeLabel} saved: ${localPath} (${decrypted.length} bytes)`);
    return localPath;
  } catch (err) {
    logger.error(`inbound ${typeLabel} download/decrypt failed: ${err.message}`);
    return null;
  }
}

/**
 * Format the C4 content string for a WeChat DM.
 *
 * Follows the Feishu/Telegram pattern:
 * - Quoted messages use <replying-to> tags
 * - Current message wrapped in <current-message> tags
 * - Media path appended as ---- file: /path/to/media
 */
function formatC4Content(fromUserId, text, mediaPath, quotedContext, mediaTypeLabel) {
  const parts = [];

  parts.push(`[WeChat DM] ${fromUserId} said: `);

  // Quoted message
  if (quotedContext) {
    parts.push(`<replying-to>\n[${quotedContext.sender}]: ${quotedContext.text}\n</replying-to>\n\n`);
  }

  // Current message body
  const bodyText = mediaTypeLabel && !text
    ? `[${mediaTypeLabel}]`
    : mediaTypeLabel && text
      ? `[${mediaTypeLabel}] ${text}`
      : text;

  parts.push(`<current-message>\n${bodyText}\n</current-message>`);

  let content = parts.join('');

  if (mediaPath) {
    content += ` ---- file: ${mediaPath}`;
  }

  return content;
}

async function handleMessages(msgs, accountId, normalizedId) {
  // Get the API client for media downloads
  const client = manager.getClient(normalizedId);

  for (const msg of msgs) {
    // Skip bot messages (message_type 2 = bot)
    if (msg.message_type === 2) continue;

    // Skip non-finished messages (message_state 2 = finish)
    if (msg.message_state !== undefined && msg.message_state !== 2) continue;

    const msgId = String(msg.message_id || msg.seq || '');
    if (!msgId) continue;

    const dedupeKey = `${accountId}:${msgId}`;
    if (seenMessages.has(dedupeKey)) continue;

    const fromUserId = msg.from_user_id || '';

    // Update context token cache (keyed by normalizedId for send.js compat)
    if (msg.context_token && fromUserId) {
      contextTokens.set(normalizedId, fromUserId, msg.context_token);
    }

    // DM allowlist check
    if (config.dmAllowlist.length > 0 && !config.dmAllowlist.includes(fromUserId)) {
      logger.debug('drop from non-allowlisted user:', fromUserId);
      markSeen(dedupeKey);
      continue;
    }

    // Extract text and quoted context
    const { text, quotedContext } = extractBody(msg);

    // Download inbound media (if any)
    let mediaPath = null;
    let mediaTypeLabel = null;
    const mediaItem = findMediaItem(msg);
    if (mediaItem && client) {
      mediaTypeLabel = TYPE_LABEL[mediaItem.type] || 'file';
      mediaPath = await downloadInboundMedia(client, mediaItem);
    }

    // Use normalizedId as endpoint — send.js uses this to load credentials
    const endpoint = normalizedId;

    // Format for C4 dispatch
    const content = formatC4Content(fromUserId, text, mediaPath, quotedContext, mediaTypeLabel);

    // Start typing indicator (non-blocking — indicates processing to sender)
    const typingMgr = typingManagers.get(accountId);
    if (typingMgr && fromUserId) {
      typingMgr.startTyping(fromUserId, msg.context_token).catch(() => {});
    }

    try {
      await sendToC4({
        scriptPath: config.c4ReceiveScript,
        channel: 'wechat',
        endpoint,
        content,
        logger,
      });
    } catch (err) {
      logger.error('C4 dispatch failed:', err.message);
      // Stop typing on dispatch failure
      if (typingMgr && fromUserId) {
        typingMgr.stopTyping(fromUserId).catch(() => {});
      }
    }

    markSeen(dedupeKey);
  }
}

// --- Lifecycle ---

async function main() {
  logger.info('zylos-wechat starting...');
  logger.info('data dir:', dataDir);

  await manager.init();

  manager.on('error', (err, acctId) => {
    logger.error(`[${acctId}] error:`, err.message);
  });

  manager.on('session-expired', (acctId) => {
    logger.warn(`[${acctId}] session expired — paused for 60 minutes`);
  });

  manager.on('connected', (acctId, normalizedId) => {
    logger.info(`[${acctId}] polling started`);
    // Create TypingManager keyed by raw accountId (matches handleMessages)
    const client = manager.getClient(normalizedId);
    if (client) {
      typingManagers.set(acctId, new TypingManager(client));
    }
  });

  manager.on('disconnected', (acctId, normalizedId) => {
    logger.info(`[${acctId}] polling stopped`);
    const typingMgr = typingManagers.get(acctId);
    if (typingMgr) {
      typingMgr.stopAll();
      typingManagers.delete(acctId);
    }
  });

  // Start all saved accounts
  await manager.startAll(handleMessages);

  const accounts = manager.listAccounts();
  if (accounts.length === 0) {
    logger.info('no accounts configured — waiting for QR login via admin CLI');
  } else {
    logger.info(`${accounts.length} account(s) active`);
  }
}

function shutdown(sig) {
  logger.info(`received ${sig}, shutting down...`);
  try {
    contextTokens.flush();
  } catch (err) {
    logger.error('flush failed during shutdown:', err.message);
  }
  manager.stopAll().then(() => {
    logger.info('all pollers stopped');
    process.exit(0);
  }).catch(() => {
    process.exit(1);
  });

  // Force exit after 5s
  setTimeout(() => process.exit(0), 5_000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch(err => {
  logger.error('fatal:', err.message);
  process.exit(1);
});

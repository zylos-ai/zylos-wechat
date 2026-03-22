#!/usr/bin/env node
import { join } from 'node:path';
import { config, ensureDirs, paths } from './lib/config.js';
import { createLogger } from './lib/logger.js';
import { sendToC4 } from './lib/bridge.js';
import { AccountManager } from './lib/account-manager.js';
import { ContextTokenStore } from './lib/context-tokens.js';

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

// In-memory dedupe set (msg_id + account, with max size)
const seenMessages = new Set();
const DEDUPE_MAX = 10_000;

function markSeen(key) {
  seenMessages.add(key);
  if (seenMessages.size > DEDUPE_MAX) {
    // Evict oldest entries (Sets iterate in insertion order)
    const iter = seenMessages.values();
    for (let i = 0; i < 1000; i++) iter.next();
    const keep = new Set();
    for (const v of seenMessages) {
      if (keep.size >= seenMessages.size - 1000) break;
      // skip first 1000
    }
    // Simpler: just rebuild from array tail
    const arr = [...seenMessages];
    seenMessages.clear();
    for (const v of arr.slice(-DEDUPE_MAX + 1000)) {
      seenMessages.add(v);
    }
  }
}

// --- Message handling ---

function extractText(msg) {
  if (!msg.item_list || msg.item_list.length === 0) return '';
  for (const item of msg.item_list) {
    if (item.type === 1 && item.text_item?.text) {
      return item.text_item.text;
    }
  }
  return '';
}

function detectMessageType(msg) {
  if (!msg.item_list || msg.item_list.length === 0) return 'text';
  for (const item of msg.item_list) {
    if (item.type === 2 && item.image_item) return 'image';
    if (item.type === 5 && item.video_item) return 'video';
    if (item.type === 4 && item.file_item) return 'file';
    if (item.type === 3 && item.voice_item) return 'voice';
  }
  return 'text';
}

async function handleMessages(msgs, accountId) {
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

    // Update context token cache
    if (msg.context_token && fromUserId) {
      contextTokens.set(accountId, fromUserId, msg.context_token);
    }

    // DM allowlist check
    if (config.dmAllowlist.length > 0 && !config.dmAllowlist.includes(fromUserId)) {
      logger.debug('drop from non-allowlisted user:', fromUserId);
      markSeen(dedupeKey);
      continue;
    }

    const text = extractText(msg);
    const rawType = detectMessageType(msg);
    const endpoint = accountId;

    // Format for C4 dispatch
    const content = `[WeChat DM] ${fromUserId} said: ${text}`;

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

  manager.on('connected', (acctId) => {
    logger.info(`[${acctId}] polling started`);
  });

  manager.on('disconnected', (acctId) => {
    logger.info(`[${acctId}] polling stopped`);
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
  contextTokens.flush();
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

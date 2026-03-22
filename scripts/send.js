#!/usr/bin/env node
/**
 * Outbound send script for zylos-wechat.
 *
 * Called by C4 comm-bridge via c4-send.js:
 *   echo "message" | node scripts/send.js <endpoint_id>
 *
 * Or directly:
 *   node scripts/send.js --to <wechat_id> --text <message> --context-token <token> [--account <normalized_id>]
 *
 * Media send (C4 format):
 *   echo "[MEDIA:image]/path/to/image.png" | node scripts/send.js <endpoint_id>
 *   echo "[MEDIA:file]/path/to/doc.pdf" | node scripts/send.js <endpoint_id>
 *
 * The endpoint_id format from C4: "<normalized_account_id>|to:<wechat_user_id>"
 * Context token is loaded from the account's token cache if available.
 */

import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { WeChatApiClient } from '../src/lib/api-client.js';
import { AccountStore } from '../src/lib/account-store.js';
import { ContextTokenStore } from '../src/lib/context-tokens.js';
import { uploadMedia, MEDIA_TYPE } from '../src/lib/media-upload.js';
import { TypingManager } from '../src/lib/typing.js';

// --- Resolve data dir ---
const DATA_DIR = process.env.ZYLOS_WECHAT_DATA_DIR
  || join(process.env.HOME || '', 'zylos/components/wechat');

// --- Parse arguments ---
function arg(name) {
  const i = process.argv.indexOf(name);
  if (i < 0) return '';
  return process.argv[i + 1] || '';
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function main() {
  let to, text, contextToken, accountId;

  // Mode 1: C4 comm-bridge style — endpoint_id as argv[2], message on stdin
  const endpointArg = process.argv[2];
  const hasFlags = process.argv.includes('--to') || process.argv.includes('--text');

  if (endpointArg && !hasFlags && !endpointArg.startsWith('-')) {
    // Parse endpoint: "normalizedAccountId|to:wechatUserId" or just "wechatUserId"
    const parts = endpointArg.split('|');
    if (parts.length >= 2) {
      accountId = parts[0];
      const toPart = parts.find(p => p.startsWith('to:'));
      to = toPart ? toPart.slice(3) : parts[1];
    } else {
      to = endpointArg;
    }

    // Read message from stdin
    text = await readStdin();
    if (!text) {
      console.error('No message on stdin');
      process.exit(1);
    }
  } else {
    // Mode 2: Direct CLI flags
    to = arg('--to');
    text = arg('--text');
    contextToken = arg('--context-token');
    accountId = arg('--account');
  }

  if (!to || !text) {
    console.error('Usage:');
    console.error('  echo "message" | node scripts/send.js <endpoint_id>');
    console.error('  node scripts/send.js --to <wechat_id> --text <message> --context-token <token>');
    process.exit(1);
  }

  // --- Load account credentials ---
  const store = new AccountStore(DATA_DIR);
  await store.init();

  // Find account to send from
  let creds;
  if (accountId) {
    creds = await store.loadCredentials(accountId);
  } else {
    // Default: use first account
    const accounts = await store.loadAllAccounts();
    if (accounts.length > 0) {
      creds = accounts[0];
      accountId = accounts[0].normalizedId;
    }
  }

  if (!creds || !creds.token) {
    console.error('ERR_WECHAT_AUTH: No account credentials found');
    process.exit(1);
  }

  // --- Resolve context token ---
  if (!contextToken) {
    // Load from persisted context token cache (written by the running service)
    const tokenCachePath = join(DATA_DIR, 'context-tokens.json');
    const tokenStore = ContextTokenStore.fromDisk(tokenCachePath);
    const resolvedAccountId = creds.accountId || accountId;
    contextToken = tokenStore.get(resolvedAccountId, to);

    if (!contextToken) {
      console.error('ERR_CONTEXT_TOKEN_MISSING: No context_token found for this user');
      console.error('The user must send a message first so the service can cache their context_token.');
      console.error('Or provide --context-token explicitly.');
      process.exit(1);
    }
  }

  // --- Build and send ---
  const client = new WeChatApiClient({
    token: creds.token,
    baseUrl: creds.baseUrl,
  });

  // Check for media prefix: [MEDIA:type]/path/to/file
  const mediaMatch = text.match(/^\[MEDIA:(\w+)\](.+)$/);

  if (mediaMatch) {
    // --- Media send ---
    const mediaTypeStr = mediaMatch[1].toLowerCase();
    const mediaPath = mediaMatch[2].trim();

    // Map explicit type to MEDIA_TYPE constant
    const typeMap = {
      image: MEDIA_TYPE.IMAGE,
      video: MEDIA_TYPE.VIDEO,
      file: MEDIA_TYPE.FILE,
      voice: MEDIA_TYPE.VOICE,
    };
    const mediaType = typeMap[mediaTypeStr];
    if (!mediaType) {
      console.error(`Unknown media type: "${mediaTypeStr}". Use: image, video, file, voice`);
      process.exit(1);
    }

    const mediaItem = await uploadMedia(client, {
      filePath: mediaPath,
      toUserId: to,
      mediaType,
    });

    const clientId = `zylos-wechat:${Date.now()}-${randomBytes(4).toString('hex')}`;
    const resp = await client.sendMessage({
      from_user_id: '',
      to_user_id: to,
      client_id: clientId,
      message_type: 2,
      message_state: 2,
      context_token: contextToken,
      item_list: [mediaItem],
    });

    if (resp.ret !== undefined && resp.ret !== 0) {
      console.error(`WeChat API error: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg}`);
      process.exit(1);
    }
  } else {
    // --- Text send ---
    const clientId = `zylos-wechat:${Date.now()}-${randomBytes(4).toString('hex')}`;

    // Split long messages (4000 char limit)
    const MAX_CHARS = 4000;
    const chunks = [];
    for (let i = 0; i < text.length; i += MAX_CHARS) {
      chunks.push(text.slice(i, i + MAX_CHARS));
    }

    for (let i = 0; i < chunks.length; i++) {
      const resp = await client.sendMessage({
        from_user_id: '',
        to_user_id: to,
        client_id: `${clientId}-${i}`,
        message_type: 2,
        message_state: 2,
        context_token: contextToken,
        item_list: [{ type: 1, text_item: { text: chunks[i] } }],
      });

      if (resp.ret !== undefined && resp.ret !== 0) {
        console.error(`WeChat API error: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg}`);
        process.exit(1);
      }
    }
  }

  // Cancel typing indicator after successful send
  const typing = new TypingManager(client);
  typing.stopTyping(to).catch(() => {});

  console.log('OK');
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});

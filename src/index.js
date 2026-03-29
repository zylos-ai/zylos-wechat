#!/usr/bin/env node
import { join } from 'node:path';
import { ensureDirs, getConfig, paths, stopWatching, watchConfig } from './lib/config.js';
import { createLogger } from './lib/logger.js';
import { sendToC4 } from './lib/bridge.js';
import { AccountManager } from './lib/account-manager.js';
import { ContextTokenStore } from './lib/context-tokens.js';
import { TypingManager } from './lib/typing.js';

let runtimeConfig = getConfig();
let logger = createLogger(runtimeConfig.logLevel);

if (!runtimeConfig.enabled) {
  logger.info('component disabled by config');
  process.exit(0);
}

ensureDirs();

const dataDir = paths.dataDir;
const manager = new AccountManager(dataDir);
const contextTokens = new ContextTokenStore({
  persistPath: join(dataDir, 'context-tokens.json'),
});
const typingManagers = new Map(); // raw accountId -> TypingManager

const seenMessages = new Set();
const DEDUPE_MAX = 10_000;
const ACCOUNT_RECONCILE_INTERVAL_MS = 10_000;
let shuttingDown = false;
let reconcileTimer = null;

function markSeen(key) {
  seenMessages.add(key);
  if (seenMessages.size > DEDUPE_MAX) {
    const recent = [...seenMessages].slice(-Math.floor(DEDUPE_MAX * 0.9));
    seenMessages.clear();
    for (const value of recent) {
      seenMessages.add(value);
    }
  }
}

function isDmAllowed(userId) {
  if (runtimeConfig.dmPolicy !== 'allowlist') return true;
  return runtimeConfig.dmAllowFrom.includes(userId);
}

function extractText(msg) {
  if (!msg.item_list || msg.item_list.length === 0) return '';
  for (const item of msg.item_list) {
    if (item.type === 1 && item.text_item?.text) {
      return item.text_item.text;
    }
  }
  return '';
}

async function handleMessages(msgs, accountId, normalizedId) {
  for (const msg of msgs) {
    if (msg.message_type === 2) continue;
    if (msg.message_state !== undefined && msg.message_state !== 2) continue;

    const msgId = String(msg.message_id || msg.seq || '');
    if (!msgId) continue;

    const dedupeKey = `${accountId}:${msgId}`;
    if (seenMessages.has(dedupeKey)) continue;

    const fromUserId = msg.from_user_id || '';

    if (msg.context_token && fromUserId) {
      contextTokens.set(normalizedId, fromUserId, msg.context_token);
    }

    if (!isDmAllowed(fromUserId)) {
      logger.debug('drop from non-allowlisted user:', fromUserId);
      markSeen(dedupeKey);
      continue;
    }

    const text = extractText(msg);
    const endpoint = fromUserId ? `${normalizedId}|to:${fromUserId}` : normalizedId;
    const content = `[WeChat DM] ${fromUserId} said: ${text}`;

    const typingMgr = typingManagers.get(accountId);
    if (typingMgr && fromUserId) {
      typingMgr.startTyping(fromUserId, msg.context_token).catch(() => {});
    }

    try {
      await sendToC4({
        scriptPath: runtimeConfig.c4ReceiveScript,
        channel: 'wechat',
        endpoint,
        content,
        logger,
      });
    } catch (err) {
      logger.error('C4 dispatch failed:', err.message);
      if (typingMgr && fromUserId) {
        typingMgr.stopTyping(fromUserId).catch(() => {});
      }
    }

    markSeen(dedupeKey);
  }
}

async function main() {
  logger.info('zylos-wechat starting...');
  logger.info('data dir:', dataDir);

  watchConfig((nextConfig) => {
    runtimeConfig = nextConfig;
    logger = createLogger(runtimeConfig.logLevel);
    logger.info('config reloaded');

    if (!runtimeConfig.enabled) {
      logger.info('component disabled in config, shutting down');
      shutdown('CONFIG_DISABLED');
    }
  });

  await manager.init();

  manager.on('error', (err, acctId) => {
    logger.error(`[${acctId}] error:`, err.message);
  });

  manager.on('session-expired', (acctId) => {
    logger.warn(`[${acctId}] session expired - paused for 60 minutes`);
  });

  manager.on('connected', (acctId, normalizedId) => {
    logger.info(`[${acctId}] polling started`);
    const client = manager.getClient(normalizedId);
    if (client) {
      typingManagers.set(acctId, new TypingManager(client));
    }
  });

  manager.on('disconnected', (acctId) => {
    logger.info(`[${acctId}] polling stopped`);
    const typingMgr = typingManagers.get(acctId);
    if (typingMgr) {
      typingMgr.stopAll();
      typingManagers.delete(acctId);
    }
  });

  await manager.startAll(handleMessages);

  reconcileTimer = setInterval(() => {
    if (shuttingDown) return;

    manager.reconcile(handleMessages).catch((err) => {
      logger.error('account reconcile failed:', err.message);
    });
  }, ACCOUNT_RECONCILE_INTERVAL_MS);
  reconcileTimer.unref?.();

  const accounts = manager.listAccounts();
  if (accounts.length === 0) {
    logger.info('no accounts configured - waiting for QR login via admin CLI');
  } else {
    logger.info(`${accounts.length} account(s) active`);
  }
}

function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info(`received ${sig}, shutting down...`);
  stopWatching();
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
  contextTokens.flush();

  for (const typingMgr of typingManagers.values()) {
    typingMgr.stopAll();
  }

  manager.stopAll().then(() => {
    logger.info('all pollers stopped');
    process.exit(0);
  }).catch(() => {
    process.exit(1);
  });

  setTimeout(() => process.exit(0), 5_000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((err) => {
  logger.error('fatal:', err.message);
  process.exit(1);
});

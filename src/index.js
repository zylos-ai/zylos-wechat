#!/usr/bin/env node
import { config, ensureDirs, paths, loadJson, saveJson } from './lib/config.js';
import { createLogger } from './lib/logger.js';
import { sendToC4 } from './lib/bridge.js';
import { WeChatClient } from './lib/wechat-client.js';

const logger = createLogger(config.logLevel);

if (!config.enabled) {
  logger.info('component disabled by config');
  process.exit(0);
}

ensureDirs();

const state = loadJson(paths.stateFile, {
  accounts: {}
});

const dedupe = loadJson(paths.dedupeFile, {
  seen: []
});

const client = new WeChatClient({
  apiBase: config.wechat.apiBase,
  accessToken: config.wechat.accessToken,
  uin: config.wechat.uin,
  deviceId: config.wechat.deviceId,
  timeoutMs: config.wechat.pollTimeoutMs
});

function markSeen(key) {
  dedupe.seen.push(key);
  if (dedupe.seen.length > 5000) dedupe.seen = dedupe.seen.slice(-5000);
  saveJson(paths.dedupeFile, dedupe);
}

function isSeen(key) {
  return dedupe.seen.includes(key);
}

function extractInboundItems(payload) {
  if (!payload) return [];
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.updates)) return payload.updates;
  return [];
}

async function handleInbound(item) {
  const accountUin = String(config.wechat.uin || item.uin || 'default');
  const msgId = String(item.msgId || item.id || '');
  if (!msgId) return;

  const dedupeKey = `${accountUin}:${msgId}`;
  if (isSeen(dedupeKey)) return;

  const from = item.from || item.sender || '';
  if (config.dmAllowlist.length > 0 && !config.dmAllowlist.includes(from)) {
    logger.debug('drop inbound from non-allowlisted user', from);
    markSeen(dedupeKey);
    return;
  }

  const text = item.text || item.content || '';
  const endpoint = accountUin;
  const content = `[WeChat DM] ${from} said: ${text}`;

  await sendToC4({
    scriptPath: config.c4ReceiveScript,
    channel: 'wechat',
    endpoint,
    content,
    logger
  });

  markSeen(dedupeKey);
}

async function pollLoop() {
  const accountUin = String(config.wechat.uin || 'default');
  if (!state.accounts[accountUin]) state.accounts[accountUin] = { offset: 0, lastOkAt: null };

  const accountState = state.accounts[accountUin];

  try {
    const payload = await client.getUpdates({
      offset: accountState.offset,
      timeoutMs: config.wechat.pollTimeoutMs
    });

    const items = extractInboundItems(payload);
    for (const item of items) {
      await handleInbound(item);
      const nextOffset = Number(item.offset || item.seq || accountState.offset);
      if (!Number.isNaN(nextOffset) && nextOffset >= accountState.offset) {
        accountState.offset = nextOffset + 1;
      }
    }

    accountState.lastOkAt = new Date().toISOString();
    saveJson(paths.stateFile, state);
  } catch (error) {
    logger.warn('poll failed', error.message);
  } finally {
    setTimeout(pollLoop, config.wechat.pollIntervalMs);
  }
}

function shutdown(sig) {
  logger.info(`received ${sig}, flushing state...`);
  saveJson(paths.stateFile, state);
  saveJson(paths.dedupeFile, dedupe);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

logger.info('zylos-wechat starting...');
logger.info('api base:', config.wechat.apiBase);
pollLoop();

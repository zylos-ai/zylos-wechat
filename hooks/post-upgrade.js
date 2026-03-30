#!/usr/bin/env node
/**
 * Post-upgrade hook for zylos-wechat.
 * Migrates config schema if needed.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const C4_RECEIVE_RELATIVE = '.claude/skills/comm-bridge/scripts/c4-receive.js';

function resolveHomePath(p) {
  if (!p) return p;
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

function detectC4ReceiveScript() {
  const candidates = [
    join(homedir(), C4_RECEIVE_RELATIVE),
    join(homedir(), 'zylos', C4_RECEIVE_RELATIVE),
    join(process.cwd(), C4_RECEIVE_RELATIVE),
    join(process.cwd(), '..', C4_RECEIVE_RELATIVE),
    join(process.cwd(), '..', '..', C4_RECEIVE_RELATIVE),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return candidates[0];
}

function resolveC4ReceiveScript(value) {
  const preferred = resolveHomePath(value);
  if (preferred && existsSync(preferred)) return preferred;
  return detectC4ReceiveScript();
}

const DATA_DIR = resolveHomePath(
  process.env.ZYLOS_WECHAT_DATA_DIR || join(homedir(), 'zylos/components/wechat')
);
const configPath = join(DATA_DIR, 'config.json');
const DEFAULT_API_BASE = 'https://ilinkai.weixin.qq.com';
const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
const DEFAULT_C4_RECEIVE_SCRIPT = detectC4ReceiveScript();

if (existsSync(configPath)) {
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    let changed = false;

    if (config.logLevel === undefined) {
      config.logLevel = 'info';
      changed = true;
    }

    if (config.dmAllowFrom === undefined) {
      const legacyAllow = Array.isArray(config.dmAllowlist)
        ? config.dmAllowlist
        : typeof config.dmAllowlist === 'string'
          ? config.dmAllowlist.split(',').map((s) => s.trim()).filter(Boolean)
          : [];
      config.dmAllowFrom = legacyAllow;
      changed = true;
    }

    if (config.dmPolicy === undefined) {
      config.dmPolicy = config.dmAllowFrom.length > 0 ? 'allowlist' : 'open';
      changed = true;
    }

    if (!config.wechat || typeof config.wechat !== 'object') {
      config.wechat = {};
      changed = true;
    }

    if (config.wechat.apiBase === undefined) {
      config.wechat.apiBase = DEFAULT_API_BASE;
      changed = true;
    }

    if (config.wechat.cdnBaseUrl === undefined) {
      config.wechat.cdnBaseUrl = DEFAULT_CDN_BASE_URL;
      changed = true;
    }

    if (!config.c4 || typeof config.c4 !== 'object') {
      config.c4 = {};
      changed = true;
    }

    if (config.c4.receiveScript === undefined) {
      config.c4.receiveScript = config.c4ReceiveScript || DEFAULT_C4_RECEIVE_SCRIPT;
      changed = true;
    }
    const currentReceiveScript = resolveC4ReceiveScript(config.c4.receiveScript);
    if (config.c4.receiveScript !== currentReceiveScript) {
      config.c4.receiveScript = currentReceiveScript;
      changed = true;
    }

    if (config.dmAllowlist !== undefined) {
      delete config.dmAllowlist;
      changed = true;
    }

    if (config.c4ReceiveScript !== undefined) {
      delete config.c4ReceiveScript;
      changed = true;
    }

    if (changed) {
      writeFileSync(configPath, JSON.stringify(config, null, 2));
      console.log('  ✓ config.json migrated with new fields');
    } else {
      console.log('  ○ config.json already up to date');
    }
  } catch (err) {
    console.error('  ✗ config migration failed:', err.message);
  }
} else {
  console.log('  ○ no config.json found');
}

console.log('  Post-upgrade complete.');

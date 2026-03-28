import fs from 'fs';
import path from 'path';
import os from 'os';
import dotenv from 'dotenv';

dotenv.config();

function resolveHomePath(p) {
  if (!p) return p;
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

const dataDir = process.env.ZYLOS_WECHAT_DATA_DIR || './data';

export const config = {
  enabled: process.env.ZYLOS_WECHAT_ENABLED !== 'false',
  logLevel: process.env.ZYLOS_WECHAT_LOG_LEVEL || 'info',
  dataDir,

  wechat: {
    apiBase: process.env.WECHAT_API_BASE || 'https://ilinkai.weixin.qq.com',
    pollTimeoutMs: Number(process.env.WECHAT_POLL_TIMEOUT_MS || 35000),
    pollIntervalMs: Number(process.env.WECHAT_POLL_INTERVAL_MS || 300)
  },

  dmAllowlist: (process.env.ZYLOS_WECHAT_DM_ALLOWLIST || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  c4ReceiveScript: resolveHomePath(
    process.env.C4_RECEIVE_SCRIPT || '~/.claude/skills/comm-bridge/scripts/c4-receive.js'
  )
};

export const paths = {
  dataDir: path.resolve(config.dataDir),
  stateFile: path.resolve(config.dataDir, 'state.json'),
  dedupeFile: path.resolve(config.dataDir, 'dedupe.json')
};

export function ensureDirs() {
  fs.mkdirSync(paths.dataDir, { recursive: true });
}

export function loadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return fallback;
  }
}

export function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

#!/usr/bin/env node
import { config } from '../src/lib/config.js';
import { WeChatClient } from '../src/lib/wechat-client.js';

function arg(name) {
  const i = process.argv.indexOf(name);
  if (i < 0) return '';
  return process.argv[i + 1] || '';
}

const to = arg('--to');
const text = arg('--text');
const contextToken = arg('--context-token');

if (!to || !text || !contextToken) {
  console.error('Usage: node scripts/send.js --to <wechat_id> --text <message> --context-token <token>');
  process.exit(1);
}

const client = new WeChatClient({
  apiBase: config.wechat.apiBase,
  accessToken: config.wechat.accessToken,
  uin: config.wechat.uin,
  deviceId: config.wechat.deviceId,
  timeoutMs: config.wechat.pollTimeoutMs
});

try {
  const resp = await client.sendMessage({ to, content: text, contextToken });
  console.log(JSON.stringify(resp, null, 2));
} catch (error) {
  console.error(error.response?.data || error.message);
  process.exit(1);
}

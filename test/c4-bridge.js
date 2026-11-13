#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  GENERIC_REJECT_REPLY,
  UNCERTAIN_REPLY,
  buildC4ReceiveArgs,
  c4ReceiveSupportsOption,
  sendToC4,
} from '../src/lib/bridge.js';
import { dispatchInbound, sendTextNotice } from '../src/lib/inbound-dispatch.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-wechat-c4-bridge-'));
const scriptPath = path.join(tmp, 'c4-receive.js');
const manifestPath = path.join(tmp, 'c4-receive-options.json');
const callLog = path.join(tmp, 'calls.jsonl');

// Fake c4-receive: logs its argv, then answers according to FAKE_C4_MODE.
fs.writeFileSync(scriptPath, `
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(callLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const mode = process.env.FAKE_C4_MODE;
const reject = (persisted) => {
  const error = { code: 'SESSION_GROUP_INVALID', message: 'internal core text' };
  if (persisted !== undefined) error.persisted = persisted;
  process.stdout.write(JSON.stringify({ ok: false, error }));
  process.exit(1);
};
if (mode === 'ok') process.stdout.write(JSON.stringify({ ok: true }));
else if (mode === 'committed') reject(['row-1']);
else if (mode === 'not_stored') reject([]);
else if (mode === 'unknown_persisted') reject(null);
else if (mode === 'no_persisted') reject(undefined);
else if (mode === 'crash') { process.stderr.write('boom'); process.exit(3); }
`);

const ENDPOINT = 'abc123-im-bot|to:o9cq80xyz@im.wechat';
const GROUP = 'dm-abc123-im-bot:o9cq80xyz:im.wechat';
const BASE_ARGS = [scriptPath, '--channel', 'wechat', '--endpoint', ENDPOINT, '--json', '--content', 'hi'];

function setManifest(value) {
  if (value === undefined) fs.rmSync(manifestPath, { force: true });
  else fs.writeFileSync(manifestPath, typeof value === 'string' ? value : JSON.stringify(value));
}

function calls() {
  if (!fs.existsSync(callLog)) return [];
  return fs.readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function send(mode, extra = {}) {
  fs.rmSync(callLog, { force: true });
  process.env.FAKE_C4_MODE = mode;
  return sendToC4({ scriptPath, endpoint: ENDPOINT, content: 'hi', sessionGroup: GROUP, retryDelayMs: 10, ...extra });
}

const SUPPORTED = { options: { '--session-group': { takesValue: true } } };

test('manifest gates --session-group; anything but an own key means unsupported', () => {
  for (const value of [undefined, 'not json', '[]', 'null', { options: [] }, { options: { '--channel': {} } }]) {
    setManifest(value);
    assert.equal(c4ReceiveSupportsOption(scriptPath, '--session-group'), false, JSON.stringify(value));
    assert.deepEqual(buildC4ReceiveArgs({ scriptPath, channel: 'wechat', endpoint: ENDPOINT, content: 'hi', sessionGroup: GROUP }), BASE_ARGS);
  }
  setManifest(SUPPORTED);
  assert.equal(c4ReceiveSupportsOption(scriptPath, '--session-group'), true);
  assert.deepEqual(buildC4ReceiveArgs({ scriptPath, channel: 'wechat', endpoint: ENDPOINT, content: 'hi', sessionGroup: GROUP }),
    [...BASE_ARGS, '--session-group', GROUP]);
});

test('older Core receives exactly the pre-change arguments', async () => {
  setManifest(undefined);
  assert.deepEqual(await send('ok'), { outcome: 'sent', notice: null });
  assert.deepEqual(calls(), [BASE_ARGS.slice(1)]);
});

test('multi-session Core receives the group', async () => {
  setManifest(SUPPORTED);
  assert.deepEqual(await send('ok'), { outcome: 'sent', notice: null });
  assert.deepEqual(calls(), [[...BASE_ARGS.slice(1), '--session-group', GROUP]]);
});

test('rejections are classified by persisted, never resent, Core text never shown', async () => {
  setManifest(SUPPORTED);
  const cases = [
    ['committed', { outcome: 'committed', notice: null }],
    ['not_stored', { outcome: 'not_stored', notice: GENERIC_REJECT_REPLY }],
    ['unknown_persisted', { outcome: 'uncertain', notice: UNCERTAIN_REPLY }],
    ['no_persisted', { outcome: 'uncertain', notice: UNCERTAIN_REPLY }],
  ];
  for (const [mode, expected] of cases) {
    assert.deepEqual(await send(mode), expected, mode);
    const argv = calls();
    assert.equal(argv.length, 1, `${mode}: called once`);
    assert.ok(argv[0].includes('--session-group'), `${mode}: group never dropped`);
  }
});

test('a process that ran but failed without a result is not retried', async () => {
  setManifest(SUPPORTED);
  assert.deepEqual(await send('crash'), { outcome: 'uncertain', notice: UNCERTAIN_REPLY });
  assert.equal(calls().length, 1);
});

test('a process that never started is retried once, then reported uncertain', async () => {
  setManifest(SUPPORTED);
  const savedPath = process.env.PATH;
  process.env.PATH = path.join(tmp, 'no-node-here');
  try {
    assert.deepEqual(await send('ok'), { outcome: 'uncertain', notice: UNCERTAIN_REPLY });
  } finally {
    process.env.PATH = savedPath;
  }
  assert.equal(calls().length, 0);
});

test('a retry after a failed spawn delivers the message once', async () => {
  setManifest(SUPPORTED);
  const savedPath = process.env.PATH;
  process.env.PATH = path.join(tmp, 'no-node-here');
  const warnings = [];
  const logger = { warn: (...args) => { warnings.push(args.join(' ')); process.env.PATH = savedPath; } };
  try {
    assert.deepEqual(await send('ok', { logger }), { outcome: 'sent', notice: null });
  } finally {
    process.env.PATH = savedPath;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /did not start/);
  assert.deepEqual(calls(), [[...BASE_ARGS.slice(1), '--session-group', GROUP]]);
});

async function dispatch(mode, endpoint = ENDPOINT) {
  fs.rmSync(callLog, { force: true });
  process.env.FAKE_C4_MODE = mode;
  const events = [];
  const result = await dispatchInbound({
    scriptPath,
    endpoint,
    content: 'hi',
    stopTyping: () => events.push('stopTyping'),
    sendNotice: async (text) => events.push(`notice:${text}`),
  });
  return { result, events, argv: calls() };
}

test('dispatch: delivered message leaves typing on and sends no notice', async () => {
  setManifest(SUPPORTED);
  const { result, events, argv } = await dispatch('ok');
  assert.equal(result.outcome, 'sent');
  assert.deepEqual(events, []);
  assert.deepEqual(argv, [[...BASE_ARGS.slice(1), '--session-group', GROUP]]);
});

test('dispatch: unmappable endpoint on multi-session Core is never sent', async () => {
  setManifest(SUPPORTED);
  const { result, events, argv } = await dispatch('ok', 'abc123-im-bot|to:no-at-sign');
  assert.equal(result.outcome, 'not_stored');
  assert.deepEqual(events, ['stopTyping', `notice:${GENERIC_REJECT_REPLY}`]);
  assert.deepEqual(argv, []);
});

test('dispatch: unmappable endpoint on older Core is delivered as before', async () => {
  setManifest(undefined);
  const endpoint = 'abc123-im-bot|to:no-at-sign';
  const { result, events, argv } = await dispatch('ok', endpoint);
  assert.equal(result.outcome, 'sent');
  assert.deepEqual(events, []);
  assert.deepEqual(argv, [['--channel', 'wechat', '--endpoint', endpoint, '--json', '--content', 'hi']]);
});

test('dispatch: rejections stop typing; only uncommitted ones notify the user', async () => {
  setManifest(SUPPORTED);
  const cases = [
    ['committed', ['stopTyping']],
    ['not_stored', ['stopTyping', `notice:${GENERIC_REJECT_REPLY}`]],
    ['no_persisted', ['stopTyping', `notice:${UNCERTAIN_REPLY}`]],
    ['crash', ['stopTyping', `notice:${UNCERTAIN_REPLY}`]],
  ];
  for (const [mode, expected] of cases) {
    const { events } = await dispatch(mode);
    assert.deepEqual(events, expected, mode);
  }
});

test('sendTextNotice sends a text reply with the context token and never throws', async () => {
  const sent = [];
  const warnings = [];
  const logger = { warn: (...args) => warnings.push(args.join(' ')) };
  const client = { sendMessage: async (msg) => { sent.push(msg); return { ret: 0 }; } };
  await sendTextNotice({ client, toUserId: 'u@im.wechat', contextToken: 'ctx', text: 'hello', logger });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to_user_id, 'u@im.wechat');
  assert.equal(sent[0].context_token, 'ctx');
  assert.equal(sent[0].message_type, 2);
  assert.deepEqual(sent[0].item_list, [{ type: 1, text_item: { text: 'hello' } }]);
  assert.deepEqual(warnings, []);

  await sendTextNotice({ client: { sendMessage: async () => ({ ret: -1, errcode: 7 }) }, toUserId: 'u', text: 'x', logger });
  await sendTextNotice({ client: { sendMessage: async () => { throw new Error('net down'); } }, toUserId: 'u', text: 'x', logger });
  assert.equal(warnings.length, 2);
  assert.match(warnings[1], /net down/);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

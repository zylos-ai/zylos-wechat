#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isValidSessionGroup, sessionGroupFromEndpoint } from '../src/lib/session-group.js';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '../scripts/session-group.js');

const MAPPED = [
  ['abc123-im-bot|to:o9cq80xyz@im.wechat', 'dm-abc123-im-bot:o9cq80xyz:im.wechat'],
  ['abc123-im-bot|to:o9cq80_x-y.z@im.wechat', 'dm-abc123-im-bot:o9cq80_x-y.z:im.wechat'],
  // a second bot account talking to the same user is a separate conversation
  ['def456-im-bot|to:o9cq80xyz@im.wechat', 'dm-def456-im-bot:o9cq80xyz:im.wechat'],
  // per-message or unknown endpoint parts never affect the group
  ['abc123-im-bot|msg:42|to:o9cq80xyz@im.wechat', 'dm-abc123-im-bot:o9cq80xyz:im.wechat'],
];

const INVALID = [
  '',
  'abc123-im-bot',                          // no to: part
  'abc123-im-bot|o9cq80xyz@im.wechat',      // user without to:
  'abc123@im.bot|to:o9cq80xyz@im.wechat',   // raw (not normalized) account id
  '|to:o9cq80xyz@im.wechat',                // empty account
  'abc123-im-bot|to:',                       // empty user
  'abc123-im-bot|to:o9cq80xyz',             // no '@'
  'abc123-im-bot|to:a@b@im.wechat',         // two '@'
  'abc123-im-bot|to:a:b@im.wechat',         // ':' would break reversibility
  'abc123-im-bot|to:xxx@chatroom ',         // stray whitespace
  `abc123-im-bot|to:${'x'.repeat(80)}@im.wechat`, // over 95 characters, never truncated
];

/** Inverse of the mapping, to prove it is one-to-one. */
function endpointFromGroup(group) {
  const rest = group.slice('dm-'.length);
  const first = rest.indexOf(':');
  const second = rest.indexOf(':', first + 1);
  return `${rest.slice(0, first)}|to:${rest.slice(first + 1, second)}@${rest.slice(second + 1)}`;
}

test('maps each private chat to dm-<account>:<user> with a Core-valid name', () => {
  for (const [endpoint, group] of MAPPED) {
    const actual = sessionGroupFromEndpoint(endpoint);
    assert.equal(actual, group, endpoint);
    assert.equal(isValidSessionGroup(actual), true, actual);
  }
});

test('mapping is reversible', () => {
  for (const [endpoint] of MAPPED.slice(0, 3)) {
    assert.equal(endpointFromGroup(sessionGroupFromEndpoint(endpoint)), endpoint);
  }
});

test('invalid endpoints throw instead of falling back to the overall group', () => {
  for (const endpoint of [...INVALID, null, undefined]) {
    assert.throws(() => sessionGroupFromEndpoint(endpoint), Error, String(endpoint));
  }
});

test('isValidSessionGroup matches Core syntax', () => {
  for (const name of ['dm-a:b:c', 'a', 'x'.repeat(95)]) assert.equal(isValidSessionGroup(name), true, name);
  for (const name of ['', '-a', ':a', 'a@b', 'a b', 'x'.repeat(96), null, 42]) {
    assert.equal(isValidSessionGroup(name), false, String(name));
  }
});

test('CLI prints the same group the receiver sends', () => {
  for (const [endpoint, group] of MAPPED) {
    assert.equal(execFileSync(process.execPath, [script, endpoint], { encoding: 'utf8' }), `${group}\n`);
  }
});

test('CLI failure exits 1 with nothing on stdout', () => {
  for (const args of [[], ['a', 'b'], [''], ['abc123-im-bot|to:nobody']]) {
    assert.throws(() => execFileSync(process.execPath, [script, ...args], { stdio: 'pipe' }),
      (err) => err.status === 1 && err.stdout.toString() === '' && err.stderr.toString() !== '');
  }
});

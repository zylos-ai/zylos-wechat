#!/usr/bin/env node
/**
 * Tests for getUploadUrl response handling in media-upload.js.
 *
 * The server may answer with only `upload_full_url`, only `upload_param`, or neither.
 * These cover all three, plus the precedence rule when both are present.
 */

import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uploadMedia, MEDIA_TYPE } from '../src/lib/media-upload.js';

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

const dir = mkdtempSync(join(tmpdir(), 'wechat-upload-test-'));
const filePath = join(dir, 'report.xlsx');
writeFileSync(filePath, Buffer.from('test-payload'));

/** Minimal client stub recording what cdnUpload was called with. */
function makeClient(uploadResponse) {
  const calls = [];
  return {
    calls,
    async getUploadUrl() {
      return uploadResponse;
    },
    async cdnUpload(uploadParam, filekey, encryptedData, opts = {}) {
      calls.push({ uploadParam, filekey, uploadFullUrl: opts.uploadFullUrl, timeoutMs: opts.timeoutMs });
      return 'download-param-stub';
    },
  };
}

const opts = { filePath, toUserId: 'user@im.wechat', mediaType: MEDIA_TYPE.FILE };

console.log('Test 1: response with only upload_full_url');
{
  const client = makeClient({ upload_full_url: 'https://cdn.example/upload?a=1&taskid=xyz' });
  let item;
  let error = null;
  try {
    item = await uploadMedia(client, opts);
  } catch (err) {
    error = err;
  }
  assert(error === null, `upload succeeds (got ${error?.message ?? 'no error'})`);
  assert(client.calls.length === 1, 'cdnUpload was called');
  assert(
    client.calls[0]?.uploadFullUrl === 'https://cdn.example/upload?a=1&taskid=xyz',
    'full URL forwarded to cdnUpload',
  );
  assert(item?.file_item?.media?.encrypt_query_param === 'download-param-stub', 'message item built');
}

console.log('Test 2: response with only upload_param');
{
  const client = makeClient({ upload_param: 'param-abc' });
  let error = null;
  try {
    await uploadMedia(client, opts);
  } catch (err) {
    error = err;
  }
  assert(error === null, `upload succeeds (got ${error?.message ?? 'no error'})`);
  assert(client.calls[0]?.uploadParam === 'param-abc', 'upload param forwarded to cdnUpload');
  assert(client.calls[0]?.uploadFullUrl === undefined, 'no full URL forwarded');
}

console.log('Test 3: full URL wins when both are present');
{
  const client = makeClient({ upload_param: 'param-abc', upload_full_url: 'https://cdn.example/full' });
  await uploadMedia(client, opts);
  assert(client.calls[0]?.uploadFullUrl === 'https://cdn.example/full', 'full URL forwarded');
}

console.log('Test 4: blank full URL falls back to upload_param');
{
  const client = makeClient({ upload_param: 'param-abc', upload_full_url: '   ' });
  await uploadMedia(client, opts);
  assert(client.calls[0]?.uploadFullUrl === undefined, 'blank full URL ignored');
  assert(client.calls[0]?.uploadParam === 'param-abc', 'fell back to upload param');
}

console.log('Test 5: neither field present throws with the full response body');
{
  const client = makeClient({ some_unexpected_field: 42 });
  let error = null;
  try {
    await uploadMedia(client, opts);
  } catch (err) {
    error = err;
  }
  assert(error?.code === 'ERR_WECHAT_UPLOAD_URL', 'throws ERR_WECHAT_UPLOAD_URL');
  assert(error?.message.includes('some_unexpected_field'), 'error message includes the raw response');
  assert(!error?.message.includes('undefined'), 'error message has no undefined placeholders');
}

console.log('Test 6: retries share one budget instead of one timeout each');
{
  const budgets = [];
  let attempts = 0;
  const client = {
    async getUploadUrl() {
      return { upload_full_url: 'https://cdn.example/full' };
    },
    async cdnUpload(uploadParam, filekey, encryptedData, opts) {
      attempts++;
      budgets.push(opts.timeoutMs);
      await new Promise((r) => setTimeout(r, 30)); // burn budget like a real attempt
      throw new Error('network reset'); // no statusCode -> treated as retryable
    },
  };
  let error = null;
  try {
    await uploadMedia(client, opts);
  } catch (err) {
    error = err;
  }
  assert(error?.code === 'ERR_WECHAT_CDN_UPLOAD', 'gives up with a CDN upload error');
  assert(attempts === 3, `retried 3 times (got ${attempts})`);
  assert(budgets.every((b) => b <= 300_000), 'no attempt is granted more than the total budget');
  assert(
    budgets[1] < budgets[0] && budgets[2] < budgets[1],
    `remaining budget shrinks across attempts (got ${budgets.join(', ')})`,
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

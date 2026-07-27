#!/usr/bin/env node
/**
 * Tests that the C4 send path (scripts/send.js) honours the configured CDN base.
 *
 * The lower-level client/upload helpers were already covered, but send.js built its
 * WeChatApiClient without cdnBaseUrl, so media sends always used the compiled-in default
 * CDN regardless of wechat.cdnBaseUrl. Test 1 runs the real script against local stub
 * servers and asserts the upload lands on the configured host.
 *
 * Test 2 is a cheap drift guard for the other places that construct clients from config.
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

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

/**
 * Run a command to completion. Must stay async: the stub servers live in this process,
 * so a blocking spawnSync would stall their event loop and every request would time out.
 */
function run(cmd, argv, opts) {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

/** Start an HTTP server on an ephemeral port, recording every request. */
function startServer(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url });
      handler(req, res, Buffer.concat(chunks));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, requests, port: server.address().port });
    });
  });
}

console.log('Test 1: media send uploads to the configured CDN base');
{
  const api = await startServer((req, res, body) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/ilink/bot/getuploadurl') {
      // No upload_full_url: forces the URL to be built from the client's cdnBaseUrl.
      res.end(JSON.stringify({ ret: 0, upload_param: 'stub-upload-param' }));
    } else {
      res.end(JSON.stringify({ ret: 0 }));
    }
  });

  const cdn = await startServer((req, res) => {
    res.setHeader('x-encrypted-param', 'stub-download-param');
    res.end('');
  });

  const dataDir = mkdtempSync(join(tmpdir(), 'wechat-send-cdn-'));
  mkdirSync(join(dataDir, 'accounts'), { recursive: true });
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    admin: { enabled: false },
    wechat: {
      apiBase: `http://127.0.0.1:${api.port}`,
      cdnBaseUrl: `http://127.0.0.1:${cdn.port}/c2c`,
    },
  }));

  const { AccountStore } = await import('../src/lib/account-store.js');
  const store = new AccountStore(dataDir);
  await store.init();
  await store.saveCredentials({
    normalizedId: 'acct1',
    accountId: 'acct1',
    token: 'stub-token',
    baseUrl: `http://127.0.0.1:${api.port}`,
    userId: 'bot@im.wechat',
    savedAt: 0,
  });

  const filePath = join(dataDir, 'report.txt');
  writeFileSync(filePath, Buffer.from('test-payload'));

  const result = await run(process.execPath, [
    join(repoRoot, 'scripts/send.js'),
    '--to', 'user@im.wechat',
    '--text', `[MEDIA:file]${filePath}`,
    '--context-token', 'stub-context-token',
    '--account', 'acct1',
  ], {
    env: { ...process.env, ZYLOS_WECHAT_DATA_DIR: dataDir },
  });

  api.server.close();
  cdn.server.close();

  assert(result.status === 0, `send.js exits 0 (got ${result.status}, stderr: ${result.stderr.trim()})`);
  assert(cdn.requests.length === 1, `configured CDN received the upload (got ${cdn.requests.length} requests)`);
  assert(
    cdn.requests[0]?.url.startsWith('/c2c/upload?'),
    `upload path built from cdnBaseUrl (got ${cdn.requests[0]?.url})`
  );
  assert(
    api.requests.some((r) => r.url === '/ilink/bot/sendmessage'),
    'message was sent after upload'
  );
}

console.log('Test 2: config-driven client construction sites pass cdnBaseUrl');
{
  for (const file of ['scripts/send.js', 'src/index.js', 'src/admin.js']) {
    const source = readFileSync(join(repoRoot, file), 'utf8');
    assert(source.includes('cdnBaseUrl'), `${file} wires cdnBaseUrl from config`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

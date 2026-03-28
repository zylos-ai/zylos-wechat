#!/usr/bin/env node
/**
 * WeChat Admin CLI
 *
 * Manage WeChat accounts and service status.
 *
 * Commands:
 *   login              Trigger QR login flow
 *   accounts           List all registered accounts
 *   remove <accountId> Remove an account by normalized ID
 *   status             Show service status
 *
 * Usage: node src/admin.js <command> [args]
 */

import { join } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { AccountStore } from './lib/account-store.js';
import { WeChatApiClient } from './lib/api-client.js';
import { qrLogin } from './lib/qr-login.js';

// --- Resolve data dir ---
const DATA_DIR = process.env.ZYLOS_WECHAT_DATA_DIR
  || join(process.env.HOME || '', 'zylos/components/wechat');

// --- Commands ---

async function cmdLogin() {
  // Dynamic import — qrcode-terminal is only needed for login
  const qrcode = await import('qrcode-terminal');

  const store = new AccountStore(DATA_DIR);
  await store.init();

  const client = new WeChatApiClient();

  console.log('WeChat QR Login\n');

  const credentials = await qrLogin(client, {
    onQrUrl(url) {
      console.log('Scan this QR code with WeChat:\n');
      qrcode.default.generate(url, { small: true });
      console.log();
    },
    onStatus(status) {
      console.log(`  [status] ${status}`);
    },
  });

  await store.saveCredentials(credentials);

  console.log('\nLogin successful!');
  console.log(`  Account ID: ${credentials.accountId}`);
  console.log(`  Normalized: ${credentials.normalizedId}`);
}

async function cmdAccounts() {
  const store = new AccountStore(DATA_DIR);
  await store.init();

  const accounts = await store.loadAllAccounts();

  if (accounts.length === 0) {
    console.log('No accounts registered. Run: node src/admin.js login');
    return;
  }

  console.log(`Registered accounts (${accounts.length}):\n`);

  for (const acct of accounts) {
    console.log(`  ${acct.normalizedId}`);
    if (acct.accountId) console.log(`    Raw ID:   ${acct.accountId}`);
    if (acct.userId)    console.log(`    User ID:  ${acct.userId}`);
    if (acct.baseUrl)   console.log(`    Base URL: ${acct.baseUrl}`);
    if (acct.savedAt)   console.log(`    Saved:    ${acct.savedAt}`);
    console.log();
  }
}

async function cmdRemove(normalizedId) {
  if (!normalizedId) {
    console.error('Usage: node src/admin.js remove <accountId>');
    console.error('\nRun "node src/admin.js accounts" to see available IDs.');
    process.exit(1);
  }

  const store = new AccountStore(DATA_DIR);
  await store.init();

  // Verify account exists
  const creds = await store.loadCredentials(normalizedId);
  if (!creds) {
    console.error(`Account not found: ${normalizedId}`);
    console.error('Run "node src/admin.js accounts" to see available IDs.');
    process.exit(1);
  }

  await store.removeAccount(normalizedId);
  console.log(`Removed account: ${normalizedId}`);
}

async function cmdStatus() {
  const store = new AccountStore(DATA_DIR);
  await store.init();

  const accounts = await store.loadAllAccounts();

  console.log('WeChat Component Status\n');
  console.log(`  Data dir:  ${DATA_DIR}`);
  console.log(`  Accounts:  ${accounts.length}`);

  // Check if PM2 process is running
  try {
    const { execSync } = await import('node:child_process');
    const pm2Output = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf8' });
    const processes = JSON.parse(pm2Output);
    const wechatProc = processes.find(p => p.name === 'zylos-wechat');
    if (wechatProc) {
      console.log(`  Service:   ${wechatProc.pm2_env?.status || 'unknown'}`);
      if (wechatProc.pm2_env?.pm_uptime) {
        const uptime = Date.now() - wechatProc.pm2_env.pm_uptime;
        const hours = Math.floor(uptime / 3_600_000);
        const mins = Math.floor((uptime % 3_600_000) / 60_000);
        console.log(`  Uptime:    ${hours}h ${mins}m`);
      }
    } else {
      console.log('  Service:   not registered in PM2');
    }
  } catch {
    console.log('  Service:   unknown (PM2 not available)');
  }

  // Check state file for last message time
  const stateFile = join(DATA_DIR, 'state.json');
  try {
    const stateData = await readFile(stateFile, 'utf8');
    const state = JSON.parse(stateData);
    if (state.lastMessageAt) {
      console.log(`  Last msg:  ${state.lastMessageAt}`);
    }
  } catch {
    // No state file — check if data dir exists at all
    try {
      await stat(DATA_DIR);
    } catch {
      console.log(`\n  Data directory does not exist yet.`);
      console.log(`  Run "node src/admin.js login" to set up.`);
    }
  }

  // List account summaries
  if (accounts.length > 0) {
    console.log('\n  Accounts:');
    for (const acct of accounts) {
      const label = acct.accountId || acct.normalizedId;
      console.log(`    - ${label} (saved ${acct.savedAt || 'unknown'})`);
    }
  }
}

// --- Dispatch ---

function printUsage() {
  console.log('WeChat Admin CLI\n');
  console.log('Usage: node src/admin.js <command> [args]\n');
  console.log('Commands:');
  console.log('  login              Trigger QR login flow');
  console.log('  accounts           List all registered accounts');
  console.log('  remove <accountId> Remove an account by normalized ID');
  console.log('  status             Show service status');
}

const command = process.argv[2];

switch (command) {
  case 'login':
    cmdLogin().catch(err => {
      console.error(`Login failed: ${err.message}`);
      process.exit(1);
    });
    break;
  case 'accounts':
    cmdAccounts().catch(err => {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    });
    break;
  case 'remove':
    cmdRemove(process.argv[3]).catch(err => {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    });
    break;
  case 'status':
    cmdStatus().catch(err => {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    });
    break;
  default:
    printUsage();
    if (command && command !== '--help' && command !== '-h') {
      console.error(`\nUnknown command: ${command}`);
      process.exit(1);
    }
    break;
}

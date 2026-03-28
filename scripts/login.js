#!/usr/bin/env node
/**
 * WeChat QR Login Script
 *
 * Performs QR code login from the command line.
 * Displays a QR code in the terminal — scan with WeChat to authenticate.
 * On success, saves account credentials to the account store.
 *
 * Usage: node scripts/login.js
 */

import { join } from 'node:path';
import qrcode from 'qrcode-terminal';
import { WeChatApiClient } from '../src/lib/api-client.js';
import { AccountStore } from '../src/lib/account-store.js';
import { qrLogin } from '../src/lib/qr-login.js';

// --- Resolve data dir ---
const DATA_DIR = process.env.ZYLOS_WECHAT_DATA_DIR
  || join(process.env.HOME || '', 'zylos/components/wechat');

async function main() {
  console.log('WeChat QR Login');
  console.log('===============\n');

  // Initialize account store
  const store = new AccountStore(DATA_DIR);
  await store.init();

  // Create unauthenticated API client (no token needed for QR login)
  const client = new WeChatApiClient();

  // Run QR login flow
  const credentials = await qrLogin(client, {
    onQrUrl(url) {
      console.log('Scan this QR code with WeChat:\n');
      qrcode.generate(url, { small: true });
      console.log();
    },
    onStatus(status) {
      console.log(`  [status] ${status}`);
    },
  });

  // Save credentials
  await store.saveCredentials(credentials);

  console.log('\nLogin successful!');
  console.log(`  Account ID: ${credentials.accountId}`);
  console.log(`  Normalized: ${credentials.normalizedId}`);
  console.log(`  Saved to:   ${DATA_DIR}/accounts/`);
}

main().catch(err => {
  console.error(`\nLogin failed: ${err.message}`);
  process.exit(1);
});

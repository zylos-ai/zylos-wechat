#!/usr/bin/env node
/**
 * Post-upgrade hook for zylos-wechat.
 * Migrates config schema if needed.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DATA_DIR = join(homedir(), 'zylos/components/wechat');
const configPath = join(DATA_DIR, 'config.json');

if (existsSync(configPath)) {
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));

    // Add any new config fields with defaults
    let changed = false;

    if (config.dmPolicy === undefined) {
      config.dmPolicy = 'open';
      changed = true;
    }
    if (config.dmAllowFrom === undefined) {
      config.dmAllowFrom = [];
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
    // Non-fatal — don't exit(1) for config migration
  }
} else {
  console.log('  ○ no config.json found');
}

console.log('  Post-upgrade complete.');

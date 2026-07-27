#!/usr/bin/env node
/**
 * Test runner.
 *
 * Runs every test file even if an earlier one fails, then exits non-zero if any failed.
 * A `&&` chain hides the state of every test after the first failure, which is how a
 * newly added test can sit in the suite without ever executing.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(testDir)
  .filter((f) => f.endsWith('.js') && f !== 'run-all.js')
  .sort();

const failures = [];

for (const file of files) {
  console.log(`\n──── ${file} ────`);
  const { status } = spawnSync(process.execPath, [join(testDir, file)], { stdio: 'inherit' });
  if (status !== 0) failures.push(file);
}

console.log(`\n──── syntax check ────`);
const check = spawnSync('npm', ['run', 'check'], { stdio: 'inherit' });
if (check.status !== 0) failures.push('npm run check');

console.log(`\n${files.length + 1} suites run, ${failures.length} failed`);
if (failures.length > 0) {
  console.error(`Failed: ${failures.join(', ')}`);
  process.exit(1);
}

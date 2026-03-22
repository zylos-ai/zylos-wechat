/**
 * Account Store
 *
 * Manages WeChat account credentials and sync state on disk.
 * Each account has:
 * - credentials file: token, baseUrl, userId, savedAt
 * - sync state file: get_updates_buf (long-poll cursor)
 */

import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';

export class AccountStore {
  #dataDir;
  #accountsDir;

  /**
   * @param {string} dataDir - Component data directory (~/zylos/components/wechat)
   */
  constructor(dataDir) {
    this.#dataDir = dataDir;
    this.#accountsDir = join(dataDir, 'accounts');
  }

  async init() {
    await mkdir(this.#accountsDir, { recursive: true });
  }

  // --- Account Index ---

  #indexPath() {
    return join(this.#dataDir, 'accounts.json');
  }

  /**
   * List all registered account IDs (normalized).
   * @returns {Promise<string[]>}
   */
  async listAccounts() {
    try {
      const data = await readFile(this.#indexPath(), 'utf8');
      return JSON.parse(data);
    } catch {
      return [];
    }
  }

  /**
   * Add account to index if not already present.
   * @param {string} normalizedId
   */
  async #addToIndex(normalizedId) {
    const accounts = await this.listAccounts();
    if (!accounts.includes(normalizedId)) {
      accounts.push(normalizedId);
      await writeFile(this.#indexPath(), JSON.stringify(accounts, null, 2));
    }
  }

  /**
   * Remove account from index.
   * @param {string} normalizedId
   */
  async #removeFromIndex(normalizedId) {
    const accounts = await this.listAccounts();
    const filtered = accounts.filter(id => id !== normalizedId);
    await writeFile(this.#indexPath(), JSON.stringify(filtered, null, 2));
  }

  // --- Account Credentials ---

  #credPath(normalizedId) {
    return join(this.#accountsDir, `${normalizedId}.json`);
  }

  /**
   * Save account credentials (token, baseUrl, etc.).
   * File is chmod 0600 for security.
   * @param {import('./qr-login.js').AccountCredentials} creds
   */
  async saveCredentials(creds) {
    const path = this.#credPath(creds.normalizedId);
    const data = {
      accountId: creds.accountId, // raw ID (e.g. "hex@im.bot") — preserved for runtime use
      token: creds.token,
      baseUrl: creds.baseUrl,
      userId: creds.userId,
      savedAt: creds.savedAt,
    };
    await writeFile(path, JSON.stringify(data, null, 2));
    await chmod(path, 0o600);
    await this.#addToIndex(creds.normalizedId);
  }

  /**
   * Load account credentials.
   * @param {string} normalizedId
   * @returns {Promise<{token: string, baseUrl: string, userId: string, savedAt: string} | null>}
   */
  async loadCredentials(normalizedId) {
    try {
      const data = await readFile(this.#credPath(normalizedId), 'utf8');
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  /**
   * Remove account and its state files.
   * @param {string} normalizedId
   */
  async removeAccount(normalizedId) {
    const { unlink } = await import('node:fs/promises');
    const paths = [
      this.#credPath(normalizedId),
      this.#syncPath(normalizedId),
    ];
    for (const p of paths) {
      try { await unlink(p); } catch { /* ignore */ }
    }
    await this.#removeFromIndex(normalizedId);
  }

  // --- Sync State ---

  #syncPath(normalizedId) {
    return join(this.#accountsDir, `${normalizedId}.sync.json`);
  }

  /**
   * Load the long-poll cursor for an account.
   * @param {string} normalizedId
   * @returns {Promise<string>} get_updates_buf (empty string if not found)
   */
  async loadSyncState(normalizedId) {
    try {
      const data = await readFile(this.#syncPath(normalizedId), 'utf8');
      const parsed = JSON.parse(data);
      return parsed.get_updates_buf || '';
    } catch {
      return '';
    }
  }

  /**
   * Save the long-poll cursor.
   * @param {string} normalizedId
   * @param {string} getUpdatesBuf
   */
  async saveSyncState(normalizedId, getUpdatesBuf) {
    const path = this.#syncPath(normalizedId);
    await writeFile(path, JSON.stringify({ get_updates_buf: getUpdatesBuf }));
  }

  /**
   * Load all accounts with their credentials.
   * @returns {Promise<Array<{normalizedId: string, token: string, baseUrl: string, userId: string, savedAt: string}>>}
   */
  async loadAllAccounts() {
    const ids = await this.listAccounts();
    const accounts = [];
    for (const id of ids) {
      const creds = await this.loadCredentials(id);
      if (creds) {
        accounts.push({ normalizedId: id, ...creds });
      }
    }
    return accounts;
  }
}

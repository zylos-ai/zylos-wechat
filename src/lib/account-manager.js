/**
 * Multi-Account Manager
 *
 * Manages the lifecycle of multiple WeChat accounts:
 * login → active → disconnected → re-auth
 *
 * Each account gets its own API client and poller instance.
 */

import { EventEmitter } from 'node:events';
import { WeChatApiClient } from './api-client.js';
import { AccountStore } from './account-store.js';
import { Poller } from './poller.js';
import { qrLogin } from './qr-login.js';

/**
 * @typedef {'idle'|'logging-in'|'active'|'disconnected'|'session-expired'} AccountState
 */

export class AccountManager extends EventEmitter {
  #store;
  #accounts = new Map(); // normalizedId → { client, poller, state, accountId }

  /**
   * @param {string} dataDir - Component data directory
   */
  constructor(dataDir) {
    super();
    this.#store = new AccountStore(dataDir);
  }

  get store() { return this.#store; }

  /**
   * Initialize store and load existing accounts.
   * Does NOT start polling — call startAll() after init.
   */
  async init() {
    await this.#store.init();
  }

  /**
   * Load and start all saved accounts.
   * @param {(msgs: object[], accountId: string) => void} onMessages - Message handler
   */
  async startAll(onMessages) {
    const accounts = await this.#store.loadAllAccounts();

    for (const acct of accounts) {
      const client = new WeChatApiClient({
        token: acct.token,
        baseUrl: acct.baseUrl,
      });

      // Use raw accountId if persisted, otherwise fall back to normalizedId
      const rawAccountId = acct.accountId || acct.normalizedId;
      const poller = this.#createPoller(client, rawAccountId, acct.normalizedId, onMessages);

      this.#accounts.set(acct.normalizedId, {
        client,
        poller,
        state: 'active',
        accountId: rawAccountId,
      });

      // Start polling (don't await — runs in background)
      poller.start().catch(err => {
        console.error(`[account:${acct.normalizedId}] Poll loop crashed:`, err.message);
      });
    }

    console.log(`[account-manager] Started ${accounts.length} account(s)`);
  }

  /**
   * Stop all account pollers.
   */
  async stopAll() {
    for (const [id, entry] of this.#accounts) {
      entry.poller.stop();
      entry.state = 'disconnected';
    }
  }

  /**
   * Add a new account via QR login.
   * @param {object} opts
   * @param {(url: string) => void} [opts.onQrUrl]
   * @param {(status: string) => void} [opts.onStatus]
   * @param {(msgs: object[], accountId: string) => void} opts.onMessages
   * @param {AbortSignal} [opts.signal]
   * @returns {Promise<string>} normalizedId of the new account
   */
  async addAccount(opts) {
    const client = new WeChatApiClient();

    opts.onStatus?.('Starting QR login...');

    const creds = await qrLogin(client, {
      onQrUrl: opts.onQrUrl,
      onStatus: opts.onStatus,
      signal: opts.signal,
    });

    // Update client with authenticated credentials
    client.setToken(creds.token);
    client.setBaseUrl(creds.baseUrl);

    // Save to disk
    await this.#store.saveCredentials(creds);

    // Create and start poller
    const poller = this.#createPoller(client, creds.accountId, creds.normalizedId, opts.onMessages);

    this.#accounts.set(creds.normalizedId, {
      client,
      poller,
      state: 'active',
      accountId: creds.accountId,
    });

    poller.start().catch(err => {
      console.error(`[account:${creds.normalizedId}] Poll loop crashed:`, err.message);
    });

    return creds.normalizedId;
  }

  /**
   * Remove an account.
   * @param {string} normalizedId
   */
  async removeAccount(normalizedId) {
    const entry = this.#accounts.get(normalizedId);
    if (entry) {
      entry.poller.stop();
      this.#accounts.delete(normalizedId);
    }
    await this.#store.removeAccount(normalizedId);
  }

  /**
   * Get the API client for an account (for sending messages).
   * @param {string} normalizedId
   * @returns {WeChatApiClient | null}
   */
  getClient(normalizedId) {
    return this.#accounts.get(normalizedId)?.client || null;
  }

  /**
   * Get the state of an account.
   * @param {string} normalizedId
   * @returns {AccountState | null}
   */
  getState(normalizedId) {
    return this.#accounts.get(normalizedId)?.state || null;
  }

  /**
   * List all accounts with their state.
   * @returns {Array<{normalizedId: string, accountId: string, state: AccountState}>}
   */
  listAccounts() {
    return Array.from(this.#accounts.entries()).map(([id, entry]) => ({
      normalizedId: id,
      accountId: entry.accountId,
      state: entry.state,
    }));
  }

  /**
   * Get the context token map for message sending.
   * Context tokens are managed externally (in the bridge layer)
   * since they come from inbound messages.
   */

  #createPoller(client, accountId, normalizedId, onMessages) {
    const poller = new Poller({
      client,
      accountStore: this.#store,
      accountId,
      normalizedId,
    });

    poller.on('messages', (msgs, acctId) => {
      onMessages(msgs, acctId, normalizedId);
    });

    poller.on('error', (err, acctId) => {
      console.error(`[account:${acctId}] Poll error:`, err.message);
      this.emit('error', err, acctId);
    });

    poller.on('session-expired', (acctId) => {
      console.warn(`[account:${acctId}] Session expired — pausing for 60 minutes`);
      const entry = this.#accounts.get(normalizedId);
      if (entry) entry.state = 'session-expired';
      this.emit('session-expired', acctId);
    });

    poller.on('connected', (acctId) => {
      const entry = this.#accounts.get(normalizedId);
      if (entry) entry.state = 'active';
      this.emit('connected', acctId, normalizedId);
    });

    poller.on('disconnected', (acctId) => {
      const entry = this.#accounts.get(normalizedId);
      if (entry && entry.state !== 'session-expired') {
        entry.state = 'disconnected';
      }
      this.emit('disconnected', acctId, normalizedId);
    });

    return poller;
  }
}

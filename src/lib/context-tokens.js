/**
 * Context Token Manager
 *
 * In-memory store for WeChat context tokens with optional disk persistence.
 * Each inbound message carries a context_token that MUST be echoed
 * in every outbound reply to that user. Tokens are stored per
 * accountId:userId pair and updated on every inbound message.
 *
 * When persistPath is set, tokens are written to disk on every set()
 * so that scripts/send.js (a separate process) can read them.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_TTL_MS = 24 * 60 * 60_000; // 24 hours

export class ContextTokenStore {
  #tokens = new Map(); // "accountId:userId" → { token, updatedAt }
  #maxEntries;
  #ttlMs;
  #persistPath;
  #persistTimer = null;

  /**
   * @param {object} [opts]
   * @param {number} [opts.maxEntries=10000]
   * @param {number} [opts.ttlMs=86400000] - TTL in ms (24h default)
   * @param {string} [opts.persistPath] - File path to persist tokens for cross-process reads
   */
  constructor(opts = {}) {
    this.#maxEntries = opts.maxEntries || DEFAULT_MAX_ENTRIES;
    this.#ttlMs = opts.ttlMs || DEFAULT_TTL_MS;
    this.#persistPath = opts.persistPath || null;

    // Load from disk if persist path exists
    if (this.#persistPath) {
      this.#loadFromDisk();
    }
  }

  /**
   * Build the key for a token entry.
   * @param {string} accountId - Normalized account ID
   * @param {string} userId - WeChat user ID
   * @returns {string}
   */
  #key(accountId, userId) {
    return `${accountId}:${userId}`;
  }

  /**
   * Update context token from an inbound message.
   * @param {string} accountId
   * @param {string} userId - from_user_id of the inbound message
   * @param {string} contextToken
   */
  set(accountId, userId, contextToken) {
    if (!contextToken) return;

    const key = this.#key(accountId, userId);
    this.#tokens.set(key, {
      token: contextToken,
      updatedAt: Date.now(),
    });

    // Evict oldest if over capacity
    if (this.#tokens.size > this.#maxEntries) {
      this.#evictOldest();
    }

    // Debounced persist to disk
    this.#schedulePersist();
  }

  /**
   * Get context token for sending a message to a user.
   * @param {string} accountId
   * @param {string} userId - to_user_id for the outbound message
   * @returns {string | null} context_token or null if not available
   */
  get(accountId, userId) {
    const key = this.#key(accountId, userId);
    const entry = this.#tokens.get(key);

    if (!entry) return null;

    // Check TTL
    if (Date.now() - entry.updatedAt > this.#ttlMs) {
      this.#tokens.delete(key);
      return null;
    }

    return entry.token;
  }

  /**
   * Check if a context token exists for a user.
   * @param {string} accountId
   * @param {string} userId
   * @returns {boolean}
   */
  has(accountId, userId) {
    return this.get(accountId, userId) !== null;
  }

  /**
   * Remove expired entries.
   */
  cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.#tokens) {
      if (now - entry.updatedAt > this.#ttlMs) {
        this.#tokens.delete(key);
      }
    }
  }

  /**
   * Get store size.
   */
  get size() {
    return this.#tokens.size;
  }

  /**
   * Force flush to disk immediately (call on shutdown).
   */
  flush() {
    if (this.#persistTimer) {
      clearTimeout(this.#persistTimer);
      this.#persistTimer = null;
    }
    this.#writeToDisk();
  }

  /**
   * Load tokens from a persist file (for cross-process reads like send.js).
   * @param {string} filePath
   * @returns {ContextTokenStore}
   */
  static fromDisk(filePath) {
    return new ContextTokenStore({ persistPath: filePath });
  }

  // --- Disk persistence ---

  #loadFromDisk() {
    if (!this.#persistPath) return;
    try {
      const raw = readFileSync(this.#persistPath, 'utf8');
      const data = JSON.parse(raw);
      if (data && typeof data === 'object') {
        for (const [key, entry] of Object.entries(data)) {
          if (entry.token && entry.updatedAt) {
            // Skip expired entries on load
            if (Date.now() - entry.updatedAt <= this.#ttlMs) {
              this.#tokens.set(key, entry);
            }
          }
        }
      }
    } catch {
      // File doesn't exist or is corrupt — start fresh
    }
  }

  #schedulePersist() {
    if (!this.#persistPath) return;

    // Debounce: write at most every 500ms
    if (this.#persistTimer) return;
    this.#persistTimer = setTimeout(() => {
      this.#persistTimer = null;
      this.#writeToDisk();
    }, 500);
  }

  #writeToDisk() {
    if (!this.#persistPath) return;
    try {
      mkdirSync(dirname(this.#persistPath), { recursive: true });
      const obj = {};
      for (const [key, entry] of this.#tokens) {
        obj[key] = entry;
      }
      writeFileSync(this.#persistPath, JSON.stringify(obj));
    } catch (err) {
      console.error('[context-tokens] persist failed:', err.message);
    }
  }

  #evictOldest() {
    let oldestKey = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.#tokens) {
      if (entry.updatedAt < oldestTime) {
        oldestTime = entry.updatedAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.#tokens.delete(oldestKey);
    }
  }
}

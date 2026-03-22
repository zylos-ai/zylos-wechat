/**
 * Context Token Manager
 *
 * In-memory store for WeChat context tokens.
 * Each inbound message carries a context_token that MUST be echoed
 * in every outbound reply to that user. Tokens are stored per
 * accountId:userId pair and updated on every inbound message.
 */

const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_TTL_MS = 24 * 60 * 60_000; // 24 hours

export class ContextTokenStore {
  #tokens = new Map(); // "accountId:userId" → { token, updatedAt }
  #maxEntries;
  #ttlMs;

  /**
   * @param {object} [opts]
   * @param {number} [opts.maxEntries=10000]
   * @param {number} [opts.ttlMs=86400000] - TTL in ms (24h default)
   */
  constructor(opts = {}) {
    this.#maxEntries = opts.maxEntries || DEFAULT_MAX_ENTRIES;
    this.#ttlMs = opts.ttlMs || DEFAULT_TTL_MS;
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

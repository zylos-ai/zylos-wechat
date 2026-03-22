/**
 * Typing Indicator Manager
 *
 * Manages typing indicators for WeChat conversations.
 * Handles getConfig (to obtain typing_ticket), sendTyping lifecycle,
 * and automatic refresh every 5 seconds.
 */

const CONFIG_CACHE_TTL = 24 * 60 * 60_000; // 24 hours
const TYPING_REFRESH_INTERVAL = 5_000; // 5 seconds
const CONFIG_RETRY_BASE = 2_000; // 2s initial retry
const CONFIG_RETRY_MAX = 60 * 60_000; // 1h max retry

export class TypingManager {
  #client;
  #configCache = new Map(); // userId → { typingTicket, expiresAt, retryDelay }
  #activeTimers = new Map(); // userId → intervalId

  /**
   * @param {import('./api-client.js').WeChatApiClient} client
   */
  constructor(client) {
    this.#client = client;
  }

  /**
   * Get typing ticket for a user (with caching).
   * @param {string} userId
   * @param {string} [contextToken]
   * @returns {Promise<string|null>} typing_ticket or null on failure
   */
  async getTypingTicket(userId, contextToken) {
    const cached = this.#configCache.get(userId);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.typingTicket;
    }

    try {
      const resp = await this.#client.getConfig(userId, contextToken);
      if (resp.ret === 0 || resp.ret === undefined) {
        const ticket = resp.typing_ticket;
        if (ticket) {
          // Randomize TTL within 24h window to avoid thundering herd
          const jitter = Math.random() * 60 * 60_000; // up to 1h jitter
          this.#configCache.set(userId, {
            typingTicket: ticket,
            expiresAt: Date.now() + CONFIG_CACHE_TTL - jitter,
            retryDelay: CONFIG_RETRY_BASE,
          });
          return ticket;
        }
      }
      return null;
    } catch (err) {
      // Exponential backoff on failure
      const entry = this.#configCache.get(userId);
      const retryDelay = entry?.retryDelay || CONFIG_RETRY_BASE;
      this.#configCache.set(userId, {
        typingTicket: null,
        expiresAt: Date.now() + retryDelay,
        retryDelay: Math.min(retryDelay * 2, CONFIG_RETRY_MAX),
      });
      return null;
    }
  }

  /**
   * Start typing indicator for a user.
   * Sends initial typing and refreshes every 5 seconds.
   * @param {string} userId
   * @param {string} [contextToken]
   */
  async startTyping(userId, contextToken) {
    // Stop any existing typing for this user
    this.stopTyping(userId);

    const ticket = await this.getTypingTicket(userId, contextToken);
    if (!ticket) return;

    // Send initial typing
    try {
      await this.#client.sendTyping(userId, ticket, 1);
    } catch {
      // Non-critical — don't block on typing failures
    }

    // Set up refresh interval
    const timer = setInterval(async () => {
      try {
        const t = await this.getTypingTicket(userId, contextToken);
        if (t) {
          await this.#client.sendTyping(userId, t, 1);
        }
      } catch {
        // Silent failure for typing refresh
      }
    }, TYPING_REFRESH_INTERVAL);

    this.#activeTimers.set(userId, timer);
  }

  /**
   * Stop typing indicator for a user.
   * @param {string} userId
   */
  async stopTyping(userId) {
    const timer = this.#activeTimers.get(userId);
    if (timer) {
      clearInterval(timer);
      this.#activeTimers.delete(userId);
    }

    // Send cancel typing
    const ticket = this.#configCache.get(userId)?.typingTicket;
    if (ticket) {
      try {
        await this.#client.sendTyping(userId, ticket, 2);
      } catch {
        // Non-critical
      }
    }
  }

  /**
   * Stop all active typing indicators.
   */
  stopAll() {
    for (const [userId] of this.#activeTimers) {
      this.stopTyping(userId);
    }
  }
}

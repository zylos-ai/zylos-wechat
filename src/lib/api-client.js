/**
 * WeChat iLink Bot API Client
 *
 * Low-level HTTP client for the WeChat iLink Bot API.
 * Handles headers, timeouts, and base_info injection.
 */

import { randomBytes } from 'node:crypto';

const PACKAGE_VERSION = '1.0.2';
const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const DEFAULT_CDN_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

const TIMEOUT_LONGPOLL = 35_000;
const TIMEOUT_REGULAR = 15_000;
const TIMEOUT_LIGHTWEIGHT = 10_000;

/**
 * Generate a random X-WECHAT-UIN header value.
 * Format: base64(decimal-string(random-uint32))
 */
function generateUin() {
  const buf = randomBytes(4);
  const num = buf.readUInt32BE(0);
  return Buffer.from(String(num)).toString('base64');
}

export class WeChatApiClient {
  #token;
  #baseUrl;
  #cdnBaseUrl;
  #uin;

  /**
   * @param {object} opts
   * @param {string} [opts.token] - Bearer token from QR login
   * @param {string} [opts.baseUrl] - API base URL (per-account override)
   * @param {string} [opts.cdnBaseUrl] - CDN base URL
   */
  constructor(opts = {}) {
    this.#token = opts.token || null;
    this.#baseUrl = opts.baseUrl || DEFAULT_BASE_URL;
    this.#cdnBaseUrl = opts.cdnBaseUrl || DEFAULT_CDN_URL;
    this.#uin = generateUin();
  }

  get baseUrl() { return this.#baseUrl; }
  get cdnBaseUrl() { return this.#cdnBaseUrl; }
  get hasToken() { return !!this.#token; }

  setToken(token) { this.#token = token; }
  setBaseUrl(url) { this.#baseUrl = url; }
  setCdnBaseUrl(url) { this.#cdnBaseUrl = url; }

  /**
   * Build common headers for API requests.
   * @param {object} [opts]
   * @param {boolean} [opts.noAuth] - Skip Authorization header
   * @param {Record<string, string>} [opts.extra] - Additional headers
   */
  #headers(opts = {}) {
    const h = {
      'Content-Type': 'application/json',
      'AuthorizationType': 'ilink_bot_token',
      'X-WECHAT-UIN': this.#uin,
    };
    if (this.#token && !opts.noAuth) {
      h['Authorization'] = `Bearer ${this.#token}`;
    }
    if (opts.extra) {
      Object.assign(h, opts.extra);
    }
    return h;
  }

  /**
   * Make an API POST request.
   * @param {string} path - API path (e.g. '/ilink/bot/sendmessage')
   * @param {object} body - Request body (base_info is auto-injected)
   * @param {object} [opts]
   * @param {number} [opts.timeout] - Request timeout in ms
   * @param {AbortSignal} [opts.signal] - External abort signal
   * @returns {Promise<object>} Parsed JSON response
   */
  async post(path, body, opts = {}) {
    const timeout = opts.timeout || TIMEOUT_REGULAR;
    const url = `${this.#baseUrl}${path}`;

    const payload = {
      ...body,
      base_info: { channel_version: PACKAGE_VERSION },
    };
    const jsonBody = JSON.stringify(payload);

    const headers = this.#headers();
    headers['Content-Length'] = String(Buffer.byteLength(jsonBody, 'utf8'));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    // Chain external signal if provided
    if (opts.signal) {
      if (opts.signal.aborted) {
        controller.abort();
      } else {
        opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
      }
    }

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: jsonBody,
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new ApiError(`HTTP ${res.status}: ${text}`, res.status);
      }

      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Make a GET request (used for QR login flow).
   * @param {string} path
   * @param {object} [opts]
   * @param {number} [opts.timeout]
   * @param {Record<string, string>} [opts.extraHeaders]
   */
  async get(path, opts = {}) {
    const timeout = opts.timeout || TIMEOUT_REGULAR;
    const url = `${this.#baseUrl}${path}`;

    const headers = {
      'X-WECHAT-UIN': this.#uin,
    };
    if (opts.extraHeaders) {
      Object.assign(headers, opts.extraHeaders);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const res = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new ApiError(`HTTP ${res.status}: ${text}`, res.status);
      }

      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // --- Convenience methods ---

  /**
   * Long-poll for updates.
   * @param {string} getUpdatesBuf - Opaque cursor (empty string on first call)
   * @param {AbortSignal} [signal]
   */
  async getUpdates(getUpdatesBuf, signal) {
    return this.post('/ilink/bot/getupdates', {
      get_updates_buf: getUpdatesBuf || '',
    }, { timeout: TIMEOUT_LONGPOLL + 5_000, signal }); // extra 5s beyond server timeout
  }

  /**
   * Send a message.
   * @param {object} msg - Full message object
   */
  async sendMessage(msg) {
    return this.post('/ilink/bot/sendmessage', { msg });
  }

  /**
   * Get config (typing ticket).
   * @param {string} userId
   * @param {string} [contextToken]
   */
  async getConfig(userId, contextToken) {
    const body = { ilink_user_id: userId };
    if (contextToken) body.context_token = contextToken;
    return this.post('/ilink/bot/getconfig', body, { timeout: TIMEOUT_LIGHTWEIGHT });
  }

  /**
   * Send typing indicator.
   * @param {string} userId
   * @param {string} typingTicket - From getConfig response
   * @param {number} [status=1] - 1=typing, 2=cancel
   */
  async sendTyping(userId, typingTicket, status = 1) {
    return this.post('/ilink/bot/sendtyping', {
      ilink_user_id: userId,
      typing_ticket: typingTicket,
      status,
    }, { timeout: TIMEOUT_LIGHTWEIGHT });
  }

  /**
   * Get upload URL for media.
   * @param {object} params
   */
  async getUploadUrl(params) {
    return this.post('/ilink/bot/getuploadurl', params);
  }

  // --- QR Login ---

  /**
   * Get QR code for login.
   */
  async getQrCode() {
    return this.get('/ilink/bot/get_bot_qrcode?bot_type=3');
  }

  /**
   * Poll QR code status.
   * @param {string} qrcodeToken
   * @param {AbortSignal} [signal]
   */
  async getQrCodeStatus(qrcodeToken, signal) {
    const encoded = encodeURIComponent(qrcodeToken);
    return this.get(`/ilink/bot/get_qrcode_status?qrcode=${encoded}`, {
      timeout: TIMEOUT_LONGPOLL + 5_000,
      extraHeaders: { 'iLink-App-ClientVersion': '1' },
    });
  }

  // --- CDN ---

  /**
   * Upload encrypted file to CDN.
   * @param {string} uploadParam - From getUploadUrl response
   * @param {string} filekey - 32-char hex
   * @param {Buffer} encryptedData - AES-128-ECB encrypted data
   * @returns {Promise<string>} downloadParam (x-encrypted-param header)
   */
  async cdnUpload(uploadParam, filekey, encryptedData) {
    const url = `${this.#cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_REGULAR);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: encryptedData,
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new ApiError(`CDN upload failed: HTTP ${res.status}`, res.status);
      }

      const downloadParam = res.headers.get('x-encrypted-param');
      if (!downloadParam) {
        throw new ApiError('CDN upload: missing x-encrypted-param header', 0);
      }

      return downloadParam;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Download encrypted file from CDN.
   * @param {string} encryptQueryParam
   * @returns {Promise<Buffer>} Encrypted data
   */
  async cdnDownload(encryptQueryParam) {
    const url = `${this.#cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_REGULAR);

    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        throw new ApiError(`CDN download failed: HTTP ${res.status}`, res.status);
      }
      return Buffer.from(await res.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }
  }
}

export class ApiError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
  }
}

export {
  DEFAULT_BASE_URL,
  DEFAULT_CDN_URL,
  TIMEOUT_LONGPOLL,
  TIMEOUT_REGULAR,
  TIMEOUT_LIGHTWEIGHT,
};

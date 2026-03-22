import axios from 'axios';

/**
 * Minimal WeChat API client wrapper.
 * Endpoint details will be finalized with real traffic verification.
 */
export class WeChatClient {
  constructor({ apiBase, accessToken, uin, deviceId, timeoutMs = 35000 }) {
    this.http = axios.create({
      baseURL: apiBase,
      timeout: timeoutMs
    });
    this.accessToken = accessToken;
    this.uin = uin;
    this.deviceId = deviceId;
  }

  buildHeaders(extra = {}) {
    return {
      Authorization: this.accessToken ? `Bearer ${this.accessToken}` : undefined,
      'X-WECHAT-UIN': this.uin || undefined,
      'X-WECHAT-DEVICE-ID': this.deviceId || undefined,
      ...extra
    };
  }

  async getUpdates({ offset, timeoutMs = 35000 }) {
    // TODO(zylos0t): verify exact query/body contract with live endpoint
    const resp = await this.http.get('/cgi-bin/mmll-bin/getupdate', {
      headers: this.buildHeaders(),
      params: { offset, timeout: Math.floor(timeoutMs / 1000) }
    });
    return resp.data;
  }

  async sendMessage({ to, content, contextToken, type = 'text' }) {
    const resp = await this.http.post(
      '/cgi-bin/mmll-bin/sendmsg',
      {
        to,
        type,
        content,
        contextToken
      },
      { headers: this.buildHeaders() }
    );
    return resp.data;
  }

  async sendTyping({ to, contextToken }) {
    const resp = await this.http.post(
      '/cgi-bin/mmll-bin/sendtyping',
      { to, contextToken },
      { headers: this.buildHeaders() }
    );
    return resp.data;
  }

  async getConfig() {
    const resp = await this.http.get('/cgi-bin/mmll-bin/getconfig', {
      headers: this.buildHeaders()
    });
    return resp.data;
  }

  async createQrLoginSession() {
    const resp = await this.http.post(
      '/cgi-bin/mmll-bin/login/qrcode/create',
      {},
      { headers: this.buildHeaders() }
    );
    return resp.data;
  }
}

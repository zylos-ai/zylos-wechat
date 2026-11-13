import { randomBytes } from 'node:crypto';
import { GENERIC_REJECT_REPLY, c4ReceiveSupportsOption, sendToC4 } from './bridge.js';
import { sessionGroupFromEndpoint } from './session-group.js';

/**
 * Deliver one inbound WeChat message to Core and handle the outcome.
 *
 * The session group is derived only on a multi-session Core, so older Cores
 * get exactly the same arguments (and the same delivery) as before. An
 * endpoint that cannot be mapped is not sent: it never falls back to the
 * overall group. Whenever the agent will not answer, typing is stopped; the
 * user gets a notice unless Core already stored the message.
 *
 * @param {object} opts
 * @param {string} opts.scriptPath - c4-receive.js path
 * @param {string} opts.endpoint
 * @param {string} opts.content
 * @param {object} [opts.logger]
 * @param {() => void} [opts.stopTyping]
 * @param {(text: string) => Promise<void>} [opts.sendNotice] - must not throw
 * @returns {Promise<{ outcome: string, notice: string|null }>}
 */
export async function dispatchInbound({ scriptPath, endpoint, content, logger, stopTyping, sendNotice }) {
  let result;
  let sessionGroup;
  try {
    if (c4ReceiveSupportsOption(scriptPath, '--session-group')) {
      sessionGroup = sessionGroupFromEndpoint(endpoint);
    }
  } catch (err) {
    logger?.error?.(`no session group for ${endpoint}:`, err.message);
    result = { outcome: 'not_stored', notice: GENERIC_REJECT_REPLY };
  }

  if (!result) {
    result = await sendToC4({ scriptPath, channel: 'wechat', endpoint, content, sessionGroup, logger });
  }

  if (result.outcome !== 'sent') {
    stopTyping?.();
    if (result.notice && sendNotice) await sendNotice(result.notice);
  }
  return result;
}

/**
 * Send a plain-text notice to a WeChat user. Never throws: a failed notice is
 * only logged.
 * @param {object} opts
 * @param {object} opts.client - WeChatApiClient
 * @param {string} opts.toUserId
 * @param {string} [opts.contextToken]
 * @param {string} opts.text
 * @param {object} [opts.logger]
 */
export async function sendTextNotice({ client, toUserId, contextToken, text, logger }) {
  try {
    const resp = await client.sendMessage({
      from_user_id: '',
      to_user_id: toUserId,
      client_id: `zylos-wechat:${Date.now()}-${randomBytes(4).toString('hex')}`,
      message_type: 2,
      message_state: 2,
      context_token: contextToken,
      item_list: [{ type: 1, text_item: { text } }],
    });
    if (resp?.ret !== undefined && resp.ret !== 0) {
      logger?.warn?.(`notice to ${toUserId} failed: ret=${resp.ret} errcode=${resp.errcode}`);
    }
  } catch (err) {
    logger?.warn?.(`notice to ${toUserId} failed:`, err.message);
  }
}

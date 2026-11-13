/**
 * Session-group mapping for zylos-core multi-session mode.
 *
 * The group name is derived only from the reply endpoint, so the inbound
 * `--session-group` value and `scripts/session-group.js <endpoint>` always
 * agree. Rules (fixed once live; changing them needs a migration with Core):
 *   private chat `<account>|to:<user>` -> dm-<account>:<user with '@' as ':'>
 *   e.g. `abc123-im-bot|to:o9cq80xyz@im.wechat` -> dm-abc123-im-bot:o9cq80xyz:im.wechat
 * `<account>|<user>` (no `to:`), which scripts/send.js also accepts, maps the
 * same way. A bare `<user>` has no account and cannot be mapped without state.
 *
 * One group per bot account and WeChat user, because each account is its own
 * private chat with that user. Core only accepts [A-Za-z0-9_.:-], so the single
 * '@' in the user id becomes ':'. The account id is the normalized id (no ':',
 * '@' or '.') and the user id must contain exactly one '@' and no ':', so the
 * first ':' splits account from user and the second one is the '@': the mapping
 * is one-to-one. Anything else throws; ids are never truncated or hashed.
 * Per-message endpoint parts never take part. Core adds the `wechat:` namespace.
 */

/** Core's limits for the name a component passes (Core adds `<namespace>:`). */
export const SESSION_GROUP_MAX_LENGTH = 95;
export const SESSION_GROUP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

/** Normalized account id, see normalizeAccountId() in qr-login.js. */
const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
/** WeChat user id: exactly one '@', e.g. o9cq80xyz@im.wechat. */
const USER_ID = /^([A-Za-z0-9][A-Za-z0-9_.-]*)@([A-Za-z0-9][A-Za-z0-9_.-]*)$/;

/**
 * Whether Core would accept this nonempty name.
 * @param {string} name
 * @returns {boolean}
 */
export function isValidSessionGroup(name) {
  return typeof name === 'string' && name.length <= SESSION_GROUP_MAX_LENGTH
    && SESSION_GROUP_PATTERN.test(name);
}

const quote = (value, max = 64) => JSON.stringify(String(value ?? '').slice(0, max));

/**
 * Derive the in-group session name from an endpoint string.
 * @param {string} endpoint - e.g. "abc123-im-bot|to:o9cq80xyz@im.wechat"
 * @returns {string} group name without namespace (never '')
 * @throws {Error} when the endpoint cannot be mapped
 */
export function sessionGroupFromEndpoint(endpoint) {
  const parts = String(endpoint ?? '').split('|');
  const accountId = parts[0];
  // Same rule as scripts/send.js: the `to:` part, else the second part.
  const toPart = parts.slice(1).find((part) => part.startsWith('to:'));
  const userId = toPart ? toPart.slice(3) : parts[1];

  if (!ACCOUNT_ID.test(accountId)) {
    throw new Error(`invalid WeChat account id in endpoint: ${quote(endpoint)}`);
  }
  if (userId === undefined) {
    throw new Error(`endpoint has no user: ${quote(endpoint)}`);
  }
  const match = USER_ID.exec(userId);
  if (!match) {
    throw new Error(`invalid WeChat user id in endpoint: ${quote(userId)}`);
  }

  const name = `dm-${accountId}:${match[1]}:${match[2]}`;
  if (!isValidSessionGroup(name)) {
    throw new Error(`session group would be invalid for Core (length ${name.length}, max ${SESSION_GROUP_MAX_LENGTH})`);
  }
  return name;
}

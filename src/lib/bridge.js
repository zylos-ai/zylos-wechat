import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

export const GENERIC_REJECT_REPLY = "Sorry, I couldn't take this message right now. Please try again later.";
export const UNCERTAIN_REPLY = "Sorry, this message may not have reached me. If you don't get a reply in a few minutes, please send it again.";

/**
 * Whether the installed Core lists an optional c4-receive argument.
 * Reads `c4-receive-options.json` beside the configured c4-receive script on
 * every call, so a Core upgrade needs no restart. Missing or unreadable files,
 * invalid JSON and invalid shapes all mean unsupported.
 * @param {string} scriptPath - c4-receive.js path
 * @param {string} name - e.g. '--session-group'
 * @returns {boolean}
 */
export function c4ReceiveSupportsOption(scriptPath, name) {
  try {
    const manifest = JSON.parse(fs.readFileSync(
      path.join(path.dirname(scriptPath), 'c4-receive-options.json'), 'utf8'));
    return manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest)
      && manifest.options !== null && typeof manifest.options === 'object'
      && !Array.isArray(manifest.options) && Object.hasOwn(manifest.options, name);
  } catch {
    return false;
  }
}

export function buildC4ReceiveArgs({ scriptPath, channel, endpoint, content, sessionGroup }) {
  const args = [scriptPath, '--channel', channel, '--endpoint', endpoint, '--json', '--content', content];
  if (sessionGroup != null && sessionGroup !== '' && c4ReceiveSupportsOption(scriptPath, '--session-group')) {
    args.push('--session-group', sessionGroup);
  }
  return args;
}

/**
 * Classify a structured c4-receive rejection by `error.persisted`.
 * - non-empty array: Core already stored the message; send nothing, do not resend.
 * - empty array: nothing was stored; ask the user to try again later.
 * - anything else (null, or absent on older Cores): unknown.
 * @param {object} response - parsed `{ ok: false, error }` JSON
 * @returns {'committed'|'not_stored'|'uncertain'}
 */
export function classifyC4Rejection(response) {
  const persisted = response?.error?.persisted;
  if (!Array.isArray(persisted)) return 'uncertain';
  return persisted.length > 0 ? 'committed' : 'not_stored';
}

function parseC4Response(stdout) {
  if (!stdout) return null;
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return null;
  }
}

/**
 * True when c4-receive never started (spawn itself failed), so Core cannot
 * have stored anything. Any other failure without a structured result has an
 * unknown outcome.
 */
function neverStarted(error) {
  return typeof error?.code === 'string'
    && typeof error.syscall === 'string' && error.syscall.startsWith('spawn');
}

function runReceive(args) {
  return new Promise((resolve) => {
    try {
      execFile('node', args, { encoding: 'utf8' }, (error, stdout, stderr) => {
        resolve({ error, stdout: stdout?.trim() || '', stderr: stderr?.trim() || '' });
      });
    } catch (error) {
      // Invalid arguments (e.g. a NUL byte in the content) throw before spawning.
      resolve({ error, invalidArgs: true, stdout: '', stderr: '' });
    }
  });
}

/**
 * Send an inbound message to Core via c4-receive.
 *
 * The session group is passed only when the installed Core lists
 * --session-group (rechecked on every attempt). A rejected group is never
 * dropped and resent to the overall group, and Core's error text only goes to
 * the log. c4-receive runs without a timeout: killing it after Core stored the
 * message and then retrying would deliver it twice. Only a call that never
 * started is retried once.
 *
 * @returns {Promise<{ outcome: 'sent'|'committed'|'not_stored'|'uncertain', notice: string|null }>}
 *   `notice` is the text to send the WeChat user, or null to send nothing.
 */
export async function sendToC4({
  scriptPath,
  channel = 'wechat',
  endpoint,
  content,
  sessionGroup,
  logger,
  retryDelayMs = 2000,
}) {
  for (let attempt = 1; ; attempt += 1) {
    const args = buildC4ReceiveArgs({ scriptPath, channel, endpoint, content, sessionGroup });
    const { error, invalidArgs, stdout, stderr } = await runReceive(args);
    if (invalidArgs) {
      logger?.error?.('c4 receive could not start (invalid arguments), not stored:', error.message);
      return { outcome: 'not_stored', notice: GENERIC_REJECT_REPLY };
    }
    const response = parseC4Response(stdout);

    if (response?.ok === false && response.error) {
      const kind = classifyC4Rejection(response);
      const { code, message } = response.error;
      if (kind === 'committed') {
        logger?.warn?.(`c4 rejected after commit (${code}), not resending:`, message);
        return { outcome: 'committed', notice: null };
      }
      logger?.warn?.(`c4 rejected (${code}, ${kind}) [group=${sessionGroup ?? ''}]:`, message);
      return { outcome: kind, notice: kind === 'not_stored' ? GENERIC_REJECT_REPLY : UNCERTAIN_REPLY };
    }

    if (!error) {
      if (stdout) logger?.debug?.('c4 response', stdout);
      if (stderr) logger?.debug?.('c4 stderr', stderr);
      return { outcome: 'sent', notice: null };
    }

    if (!neverStarted(error) || attempt >= 2) {
      logger?.error?.('c4 receive failed, outcome unknown, not resending:', error.message, stderr);
      return { outcome: 'uncertain', notice: UNCERTAIN_REPLY };
    }

    logger?.warn?.(`c4 receive did not start, retrying in ${retryDelayMs}ms:`, error.message);
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
}

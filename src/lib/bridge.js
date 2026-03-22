import { execFile } from 'child_process';

export function sendToC4({ scriptPath, channel = 'wechat', endpoint, content, logger }) {
  return new Promise((resolve, reject) => {
    const args = [
      scriptPath,
      '--channel', channel,
      '--endpoint', endpoint,
      '--json',
      '--content', content
    ];

    execFile('node', args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        logger?.error?.('c4 receive failed', error.message, stderr?.trim());
        return reject(error);
      }

      if (stdout?.trim()) logger?.debug?.('c4 response', stdout.trim());
      resolve(stdout?.trim() || '');
    });
  });
}

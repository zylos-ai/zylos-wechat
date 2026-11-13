---
name: wechat
version: 0.3.2
description: >-
  WeChat (微信) communication channel for Zylos. Use when: (1) replying to WeChat
  messages (DM), (2) sending proactive messages or media (images, files) to WeChat
  users, (3) managing DM access control (dmPolicy, dmAllowFrom), (4) managing WeChat
  account login via QR code, (5) troubleshooting WeChat connection or polling issues.
  Config at ~/zylos/components/wechat/config.json. Service: pm2 zylos-wechat.
type: communication

lifecycle:
  npm: true
  service:
    type: pm2
    name: zylos-wechat
    entry: src/index.js
  data_dir: ~/zylos/components/wechat
  hooks:
    post-install: hooks/post-install.js
    pre-upgrade: hooks/pre-upgrade.js
    post-upgrade: hooks/post-upgrade.js
  preserve:
    - config.json
    - accounts/
    - context-tokens.json

upgrade:
  repo: zylos-ai/zylos-wechat
  branch: main

config:
  required: []
  optional:
    - name: ZYLOS_WECHAT_DATA_DIR
      description: Override component data directory
      default: "~/zylos/components/wechat"
    - name: ZYLOS_WECHAT_ENABLED
      description: Optional env override for config.enabled
      default: "true"
    - name: ZYLOS_WECHAT_LOG_LEVEL
      description: Optional env override for config.logLevel
      default: "info"
    - name: ZYLOS_WECHAT_DM_ALLOWLIST
      description: Legacy env override for config.dmAllowFrom (implies dmPolicy=allowlist when non-empty)
      default: ""

dependencies:
  - comm-bridge
---

# zylos-wechat

WeChat personal account integration via the iLink Bot API.

## Account Login

```bash
npm run admin -- login
```

The command prints a QR URL. Open it with WeChat and confirm login. If the service is running, it should pick up the new account within about 10 seconds.

## Admin CLI

```bash
npm run admin -- show
npm run admin -- list-accounts
npm run admin -- remove-account <normalized_id>
npm run admin -- set-dm-policy <open|allowlist>
npm run admin -- list-dm-allow
npm run admin -- add-dm-allow <wechat_user_id>
npm run admin -- remove-dm-allow <wechat_user_id>
```

## Config

Primary config: `~/zylos/components/wechat/config.json`

```json
{
  "enabled": true,
  "logLevel": "info",
  "dmPolicy": "open",
  "dmAllowFrom": [],
  "wechat": {
    "apiBase": "https://ilinkai.weixin.qq.com",
    "cdnBaseUrl": "https://novac2c.cdn.weixin.qq.com/c2c"
  },
  "c4": {
    "receiveScript": "~/zylos/.claude/skills/comm-bridge/scripts/c4-receive.js"
  }
}
```

Environment variables are optional overrides on top of `config.json`, not the primary source of truth.

## Send Message

```bash
# Text
echo "hello" | node scripts/send.js "<normalized_account_id>|to:<wechat_user_id>"

# Media
echo "[MEDIA:image]/path/to/photo.png" | node scripts/send.js "<normalized_account_id>|to:<wechat_user_id>"
```

## Session Groups (multi-session Core)

With a zylos-core that supports multi-session, each inbound message carries a
session group, so every private chat gets its own conversation thread. Replies
still go through the same `reply via` path; `scripts/send.js` and the endpoint
format are unchanged.

| Conversation | Endpoint | Session group | Example |
|---|---|---|---|
| Private chat | `<account>\|to:<user>` | `dm-<account>:<user with @ as :>` | `dm-abc123-im-bot:o9cq80xyz:im.wechat` |

Core adds the `wechat:` namespace (e.g. `wechat:dm-abc123-im-bot:o9cq80xyz:im.wechat`).

- These rules are fixed. Group names are Core's memory keys, so changing them
  would need a migration together with Core.
- On a multi-session Core every outbound send is checked with
  `scripts/session-group.js`, so send to `<account>|to:<user>` (or
  `<account>|<user>`). A bare `<user>` cannot be mapped and is refused by Core.
- A message without `from_user_id` cannot be mapped or answered; it is logged
  and not sent to Core.
- One group per bot account and user: the same person chatting with two bot
  accounts gets two groups.
- The single `@` in the user id becomes `:`. The account id is the normalized id
  (no `:`) and a user id must contain exactly one `@` and no `:`, so the name
  maps back to exactly one endpoint. Ids are never truncated or hashed; an
  endpoint that cannot be mapped (or a name over 95 characters) is not sent to
  Core, and the user is asked to try again later. It never falls back to the
  overall group.
- The group is derived and passed only if the installed Core lists
  `--session-group` in `c4-receive-options.json` (re-read on every message).
  Older Cores receive exactly the same arguments as before.
- If Core rejects a message, Core's text goes only to the log. The user gets a
  "try again later" notice when Core stored nothing, a "may not have reached me"
  notice when the outcome is unknown, and nothing when Core already stored it.
  A message is never resent without its group; c4-receive runs without a
  timeout and is retried (once, after 2s) only when the process could not be
  started. NUL bytes are removed from the content.

```bash
node ~/zylos/.claude/skills/wechat/scripts/session-group.js "<endpoint>"
# prints e.g. dm-abc123-im-bot:o9cq80xyz:im.wechat (without "wechat:"), exit 0
```

## Architecture

- Long-poll (`getUpdates`) for inbound messages
- Context token cached per user (required for all replies)
- AES-128-ECB encrypted media via Tencent CDN
- Multi-account support with isolated state per account

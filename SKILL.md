---
name: wechat
version: 0.1.0
description: >-
  WeChat (微信) communication channel for Zylos. Use when: (1) replying to WeChat
  messages (DM), (2) sending proactive messages or media (images, files) to WeChat
  users, (3) managing DM access control (dmPolicy, allowFrom), (4) managing WeChat
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
    - name: ZYLOS_WECHAT_ENABLED
      description: Enable/disable the component
      default: "true"
    - name: ZYLOS_WECHAT_LOG_LEVEL
      description: Log level (debug, info, warn, error)
      default: "info"
    - name: ZYLOS_WECHAT_DM_ALLOWLIST
      description: Comma-separated WeChat user IDs to allow DMs from (empty = allow all)
      default: ""

dependencies:
  - comm-bridge
---

# zylos-wechat

WeChat personal account integration via the iLink Bot API.

## Account Login

Accounts are added via QR code scan. The service must be running, then trigger login via admin CLI (TBD) or restart with no accounts configured.

## Send Message

```bash
# Text
echo "hello" | node scripts/send.js "<account_id>|to:<wechat_user_id>"

# Media
echo "[MEDIA:image]/path/to/photo.png" | node scripts/send.js "<account_id>|to:<wechat_user_id>"
```

## Architecture

- Long-poll (`getUpdates`) for inbound messages
- Context token cached per user (required for all replies)
- AES-128-ECB encrypted media via Tencent CDN
- Multi-account support with isolated state per account

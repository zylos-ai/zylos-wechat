# Changelog

All notable changes to zylos-wechat will be documented in this file.

## [0.1.0] - 2026-03-22

### Added
- Component skeleton with zylos-component-template structure
- Interface contract v0.1 (inbound/outbound schema, error codes)
- WeChat iLink Bot API client (`api-client.js`) with real endpoints
- QR code login flow (`qr-login.js`) with retry and 8-min timeout
- Long-poll manager (`poller.js`) with error recovery and session expiry handling
- Multi-account credential and sync state persistence (`account-store.js`)
- Account lifecycle manager (`account-manager.js`)
- Context token cache with disk persistence (`context-tokens.js`)
- AES-128-ECB media encryption/decryption (`media-crypto.js`)
- Media upload pipeline (`media-upload.js`) with CDN encrypt+upload
- Typing indicator manager (`typing.js`) with auto-refresh
- Outbound send script (`scripts/send.js`) supporting text and media
- C4 comm-bridge integration for inbound message dispatch
- SKILL.md with component metadata and lifecycle hooks
- PM2 ecosystem config with proper paths and log files
- Lifecycle hooks (post-install, pre-upgrade, post-upgrade)
- Crypto roundtrip test suite (26 tests)
- Complete API reference documentation (`docs/WECHAT-API.md`)

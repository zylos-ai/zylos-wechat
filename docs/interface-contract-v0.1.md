# zylos-wechat Interface Contract v0.1

Status: Draft (team internal)

## 1) Inbound event schema (WeChat -> C4)

```json
{
  "channel": "wechat",
  "endpoint": "<account_uin>",
  "content": "[WeChat DM] <sender> said: <text>",
  "meta": {
    "account_uin": "<uin>",
    "msg_id": "<msg id>",
    "from": "<hex>@im.wechat",
    "context_token": "<token from inbound if exists>",
    "timestamp": "<iso time>",
    "raw_type": "text|image|file|..."
  }
}
```

## 2) Outbound contract (`scripts/send.js` / runtime)

Required fields:

- `to`: WeChat peer id, e.g. `<hex>@im.wechat`
- `content`: text payload
- `contextToken`: must come from latest inbound message of the target conversation

Request (target shape, pending exact endpoint lock):

```json
{
  "to": "<wechat_user_id>",
  "type": "text",
  "content": "hello",
  "contextToken": "<token>"
}
```

## 3) Account state store schema

Path: `data/state.json`

```json
{
  "accounts": {
    "<uin>": {
      "offset": 0,
      "lastOkAt": "2026-03-22T00:00:00.000Z",
      "session": {
        "accessToken": "<optional runtime token>",
        "deviceId": "<optional>",
        "qr": {
          "ticket": "<optional>",
          "expiresAt": "<optional iso>"
        }
      }
    }
  }
}
```

## 4) Dedupe / idempotency

Key: `account_uin:msg_id`

Store: `data/dedupe.json`

Guarantee: At-least-once ingestion from polling; dedupe prevents duplicate dispatch into C4.

## 5) Error handling semantics (v0)

- `ERR_CONTEXT_TOKEN_MISSING`
- `ERR_CONTEXT_TOKEN_EXPIRED`
- `ERR_WECHAT_AUTH`
- `ERR_WECHAT_RATE_LIMIT`
- `ERR_WECHAT_UPSTREAM`

For v0 these are log/error-code conventions; response mapping to caller will be stabilized in v0.2.

## 6) Non-goals in v0.1

- Group chat semantics
- Full media download pipeline
- Webhook mode (polling first)


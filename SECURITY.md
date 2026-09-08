# Security review

This review covers the current AURA MVP backend and is intended to be rerun before each closed-beta expansion.

## Verified controls

- Tenant isolation: memory reads, updates, and deletes are keyed by the authenticated Telegram user ID. Cross-user access is covered by automated tests.
- Request abuse: Telegram webhook requests are limited to 60 requests per source address per minute. The limiter does not trust `X-Forwarded-For`; deployments behind a proxy must rate-limit at the proxy as well.
- Request size: webhook bodies are capped at 1 MiB.
- Webhook authentication: production startup fails without `TELEGRAM_WEBHOOK_SECRET`. Requests with a wrong or missing secret receive `401`.
- Private data controls: memory, export, and account deletion commands are rejected in non-private Telegram chats.
- Data controls: `/export` returns the requesting user's stored profile and memories; `/delete_account confirm` removes that user's profile and memories.
- Secret handling: Telegram API failures expose only status and error codes to logs. Bot tokens and request bodies are not logged.
- Response hardening: JSON responses are marked `no-store` and `nosniff`.

## Not applicable in this repository yet

- Prompt-injection defenses and tool kill switch: no model calls or external tools are exposed by this backend yet. Any future tool integration must default to an allowlist and require an explicit kill switch.
- Database tenant isolation: the current stores are in-memory. PostgreSQL row-level isolation must be reviewed when issue #2 is integrated.
- Durable audit logs and usage metrics: the current process does not persist operational events. The beta runbook defines the metrics to collect without recording private message content.

## Release checks

Run these checks before a beta deployment:

```bash
npm ci
npm test
npm run build
NODE_ENV=production npm start
```

The production command must fail immediately if `TELEGRAM_WEBHOOK_SECRET` is absent. Keep `.env` outside source control and inspect deployment logs for private content before inviting users.

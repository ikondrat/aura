# Agent SaaS

Telegram-first сервис, который по короткому диалогу разворачивает персонального AI-агента с памятью, инструментами и понятной подпиской.

## Статус

План MVP зафиксирован. Базовый backend-скелет доступен для локального запуска.

## Backend

The backend uses Node.js, TypeScript, and the built-in HTTP server. It exposes a
health endpoint and a Telegram webhook, with configuration kept in environment
variables.

```bash
cp .env.example .env
npm install
npm run dev
curl http://127.0.0.1:3000/health
```

Set `TELEGRAM_BOT_TOKEN` in `.env` to enable replies to Telegram. Keep the token
out of source control and logs. `TELEGRAM_WEBHOOK_SECRET` is optional but should
be set for a deployed webhook; Telegram sends it as the
`X-Telegram-Bot-Api-Secret-Token` header.

The webhook endpoint is `POST /webhook/telegram`. It accepts Telegram updates,
creates or finds the sender on `/start`, and sends a welcome message. Updates
without a recognized command are acknowledged without a reply. For local
testing, send a fixture directly:

```bash
curl -X POST http://127.0.0.1:3000/webhook/telegram \
  -H 'content-type: application/json' \
  -d '{"update_id":1,"message":{"chat":{"id":123},"from":{"id":123,"first_name":"Ada"},"text":"/start"}}'
```

The health endpoint returns `{"status":"ok"}`. For a production-style local
run, use `npm run build && npm start`. Run the automated checks with `npm test`.

## Memory controls

Memory is always scoped to the Telegram user who created it. The memory
commands require an explicit user action, which is also the consent signal for
storing the supplied text:

```text
/remember profile Prefers concise answers
/remember project AURA | Ship the MVP
/memory
/edit_memory <id> <new text>
/forget <id>
/forget_all
```

Profile and project memories can be listed, edited, and deleted individually or
in full. The current backend uses an in-memory store while the database work is
being completed, so memory is cleared when the process restarts. No memory is
written by a background process without explicit consent.

## Цель MVP

Пользователь отвечает на вопросы бота, получает настроенного агента для одного конкретного сценария и может пользоваться им в Telegram в рамках безопасных лимитов.

Подробный план: [PLAN.md](PLAN.md).

# Agent SaaS

Telegram-first сервис, который по короткому диалогу разворачивает персонального AI-агента с памятью, инструментами и понятной подпиской.

## Статус

План MVP зафиксирован. Базовый backend-скелет доступен для локального запуска.

## Backend

The backend uses Node.js, TypeScript, and the built-in HTTP server. It currently
exposes a health endpoint and keeps configuration in environment variables.

```bash
cp .env.example .env
npm install
npm run dev
curl http://127.0.0.1:3000/health
```

The health endpoint returns `{"status":"ok"}`. For a production-style local
run, use `npm run build && npm start`. Run the automated checks with `npm test`.

## Цель MVP

Пользователь отвечает на вопросы бота, получает настроенного агента для одного конкретного сценария и может пользоваться им в Telegram в рамках безопасных лимитов.

Подробный план: [PLAN.md](PLAN.md).

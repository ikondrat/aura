# Closed beta runbook

The first beta should be limited to 5–10 users who have agreed to test the research-assistant workflow. Do not invite users until the checks in [SECURITY.md](SECURITY.md) pass.

## Before inviting users

1. Configure `TELEGRAM_BOT_TOKEN` and a strong `TELEGRAM_WEBHOOK_SECRET` outside the repository.
2. Set `NODE_ENV=production` and verify that startup fails when the webhook secret is removed.
3. Register the Telegram webhook over HTTPS and verify a valid update receives `200` while a request with an invalid secret receives `401`.
4. Test `/export` and `/delete_account confirm` with a disposable account.
5. Confirm that private commands sent from a group do not reveal stored data.

## Metrics

Record one aggregate row per beta user per day; never record message text, prompts, search contents, tokens, or secrets.

- Activation: user completed onboarding and sent a first research task within 24 hours of `/start`.
- Task success: user marked the returned answer useful, or completed the task without a retry.
- Retention: a user who returns and sends a task on day 7.
- Cost per user: provider cost divided by active users for the period.
- Safety events: rejected webhook requests, rate-limit responses, account deletions, and manually reported privacy incidents.

Review these metrics after the first 5 users and again after 10 users. Pause invitations if a privacy incident, cross-user data exposure, or uncontrolled provider cost is observed.

# Database

AURA uses PostgreSQL for durable tenant-owned data. The migrations add the user,
agent, conversation, and message foundation plus immutable usage accounting
events for the MVP.

## Relationships

| Table | Ownership | Delete behavior |
| --- | --- | --- |
| `users` | Root tenant identified by `id`; Telegram identity is unique | Deleting a user cascades to their agents |
| `agents` | `user_id` is required and references `users.id` | An agent cannot outlive its user |
| `conversations` | `user_id` is required; optional `agent_id` must belong to the same user | Deleting a user cascades; deleting an agent detaches the conversation |
| `messages` | Reached only through an owner-scoped conversation | Deleting a conversation cascades to messages |
| `usage_events` | `user_id` is required; optional agent/conversation references must belong to the same user | Deleting a user cascades; deleting an agent is restricted; deleting a conversation clears only the correlation reference |
| `onboarding_drafts` | `user_id` is required and all draft operations are owner-scoped | Deleting a user cascades; at most one non-terminal draft exists per user |

`telegram_user_id` is a non-null PostgreSQL `bigint`, so Telegram identifiers
larger than a 32-bit integer round-trip without a database overflow. Application
code should represent it as a string or a safe bigint when binding values.

Agent onboarding fields reject empty strings. Agent lifecycle is constrained to
`draft`, `active`, `paused`, or `archived`. `created_at` and `updated_at` are
UTC-aware `timestamptz` values; a trigger refreshes `updated_at` on updates.
Indexes cover Telegram identity lookup and agent lookup by owner.

## Conversations and messages

Conversations have an `active` or `archived` status and are ordered by their
latest activity (`updated_at DESC, id DESC`). Inserting a message touches the
conversation activity timestamp. Messages support the `user`, `assistant`,
`system`, and `tool` roles, require non-empty content of at most 10,000
characters, and are ordered chronologically with `created_at ASC, id ASC` as a
deterministic tie-breaker. Provider metadata is optional JSONB.

`idempotency_key` is optional and unique within a conversation. When a retry
uses the same key, `ConversationRepository.appendMessage` returns the original
message with `duplicate: true`; a different payload is not appended. Repository
reads and writes always require the owning `user_id`, including indirect
message access through a conversation.

## Usage events

`usage_events` is append-only at the repository boundary and records token
counts as PostgreSQL `bigint` values. The repository accepts `bigint`, decimal
strings, or safe JavaScript numbers and returns bigint values, avoiding
JavaScript precision loss. `cost_microusd` is an integer number of micro-USD;
`NULL` explicitly means that the provider did not report a cost. Failed and
cancelled requests are retained with their status and whatever usage is known.

`request_id` is optional. When supplied, it is unique per user and retries
return the original event with `duplicate: true`, so a retry is not counted
twice. Events are queried with the half-open time range `[from, to)`, ordered by
`created_at DESC, id DESC`, and every repository read requires the owning
`user_id`. Aggregates sum exact integer values and cannot cross tenant
boundaries.

Agent references are checked against the event owner, and deleting an agent
with usage history is rejected so the immutable record remains valid.
Migration `005_enforce_tenant_relationships` also checks conversation IDs
against the event owner. Deleting a conversation clears only that correlation
reference and does not delete accounting history. Deleting a user cascades to
the user's usage events.
Usage events cannot be updated; account deletion is the normal removal path.

## Migrations

Copy `.env.example` to `.env`, set `DATABASE_URL` to a disposable PostgreSQL
database, then run:

```bash
npm run db:migrate
npm run db:rollback # rolls back the latest applied migration
```

Each migration runs in a transaction. The migration runner records applied
migrations in `aura_schema_migrations`; that bookkeeping table is intentionally
kept when the last application migration is rolled back. The first migration's
rollback removes the `users`, `agents`, and timestamp trigger objects.

For a clean verification, apply the migrations, insert two users and agents,
create owner-scoped conversations, append messages with equal timestamps, and
verify deterministic ordering, retry idempotency, cross-user isolation, and
agent-detach behavior. Also record successful, failed, zero-usage, and
duplicate-request usage events and query each user's period and aggregate.
Verify that empty content, invalid roles, negative values, invalid status,
cross-owner references, updates, and cross-user reads are rejected or return
no data. Check that cross-owner agent and conversation attachments are rejected
by the database constraints, the half-open period boundaries, and delete
behavior. Deleting a conversation must retain its usage event with a null
correlation reference.
Finish by rolling back the migrations and confirming the application tables are
absent.

The repository integration test runs when `AURA_TEST_DATABASE_URL` points to a
disposable database that already has the migrations applied:

```bash
AURA_TEST_DATABASE_URL="$DATABASE_URL" npm test
```

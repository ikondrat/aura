# Onboarding drafts

Migration `004_create_onboarding_drafts` stores the five-step onboarding flow
separately from `agents`, so an incomplete setup can be paused and resumed
without exposing a partial agent.

## Contract

Every repository method takes the owning `user_id` before using a draft ID.
`get` returns no draft when the ID belongs to another user. `createOrGetActive`
is safe for concurrent `/setup` requests: the partial unique index allows at
most one `in_progress`, `paused`, or `ready_for_preview` draft per user and a
retry returns that existing draft.

The unanswered steps are `goal`, `language`, `working_style`, `sources`, and
`prohibited_actions`. `updateAnswer` compares the expected current step in the
same update that stores the answer, then advances to the next step. The fifth
answer changes the status to `ready_for_preview` and the current step to
`preview`. A stale or duplicate delivery therefore cannot advance the draft a
second time. Source and prohibited-action entries are trimmed, retained in the
submitted order, and duplicates are preserved; empty lists are valid.

Draft statuses are `in_progress`, `paused`, `ready_for_preview`, `completed`,
and `cancelled`. `pause`, `resume`, and `cancel` are owner-scoped. `complete`
is retry-safe after the draft reaches `completed`, but it only changes the
draft state; it does not create an agent.

## Activation transaction

The preview/activation service must acquire one PostgreSQL client, begin a
transaction, create the active agent, call `OnboardingDraftRepository.complete`
with that same client, and commit. If either write fails, it must roll back so
the database cannot contain a partially-created agent alongside a completed
draft. Telegram delivery happens after commit; a delivery failure leaves the
committed state retryable and must not create another agent.

The migration cascades drafts when their user is deleted. Timestamps are UTC
`timestamptz` values and `updated_at` is refreshed by the shared timestamp
trigger. Apply and roll back it with the normal migration commands against a
disposable PostgreSQL database; the integration test uses
`AURA_TEST_DATABASE_URL`.

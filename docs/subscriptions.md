# Subscriptions and entitlements

`subscriptions` contains one current, owner-scoped record per user. Its status
is `active`, `grace_period`, or `cancelled`; period boundaries are UTC
`timestamptz` values. Active access uses the half-open interval
`[period_start, period_end)`. Grace access uses
`[period_start, grace_until)`, with `grace_until >= period_end`; cancelled and
expired records are denied. Missing, malformed, or unavailable state fails
closed with a typed denial reason from `EntitlementService`.

Provider-neutral adapters call `SubscriptionRepository.applyTransition` with a
stable owner-scoped `transitionId` and a non-negative monotonically increasing
`revision`. The transition ledger makes retries idempotent. A transition with
an older or equal revision is retained for audit but cannot revert the current
state; a newer revision atomically replaces it. No provider SDK, checkout,
webhook signature, credential, or raw provider payload belongs in this layer.

Subscription and transition rows are deleted with their user. Reads and
transitions always require the owning `userId`; a subscription identifier is
never an authorization credential.

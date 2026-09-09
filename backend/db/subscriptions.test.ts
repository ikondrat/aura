import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import { SubscriptionRepository } from "./subscriptions.js";

const testDatabaseUrl = process.env.AURA_TEST_DATABASE_URL;
const userId = "00000000-0000-4000-8000-000000000211";
const otherUserId = "00000000-0000-4000-8000-000000000212";

test("subscription transitions are owner-scoped, ordered, and idempotent", {
  skip: !testDatabaseUrl,
}, async () => {
  const pool = new Pool({ connectionString: testDatabaseUrl });
  const repository = new SubscriptionRepository(pool);
  try {
    await pool.query("TRUNCATE subscription_transitions, subscriptions, users CASCADE");
    await pool.query(
      "INSERT INTO users (id, telegram_user_id) VALUES ($1, 211), ($2, 212)",
      [userId, otherUserId],
    );

    const first = await repository.applyTransition({
      userId,
      transitionId: "event-1",
      revision: 1,
      status: "active",
      periodStart: "2026-01-01T00:00:00Z",
      periodEnd: "2026-02-01T00:00:00Z",
    });
    assert.equal(first.applied, true);
    assert.equal(first.subscription.status, "active");

    const stale = await repository.applyTransition({
      userId,
      transitionId: "event-0",
      revision: 0,
      status: "cancelled",
      periodStart: "2026-01-01T00:00:00Z",
      periodEnd: "2026-02-01T00:00:00Z",
    });
    assert.equal(stale.applied, false);
    assert.equal(stale.subscription.status, "active");

    const replay = await repository.applyTransition({
      userId,
      transitionId: "event-1",
      revision: 1,
      status: "cancelled",
      periodStart: "2026-01-01T00:00:00Z",
      periodEnd: "2026-02-01T00:00:00Z",
    });
    assert.equal(replay.duplicate, true);
    assert.equal(replay.subscription.status, "active");

    const grace = await repository.applyTransition({
      userId,
      transitionId: "event-2",
      revision: 2,
      status: "grace_period",
      periodStart: "2026-01-01T00:00:00Z",
      periodEnd: "2026-02-01T00:00:00Z",
      graceUntil: "2026-02-08T00:00:00Z",
    });
    assert.equal(grace.applied, true);
    assert.equal(grace.subscription.revision, 2n);
    assert.equal((await repository.get(otherUserId))?.userId, otherUserId);
  } finally {
    await pool.end();
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import { UsageEventRepository } from "./usage-events.js";

const testDatabaseUrl = process.env.AURA_TEST_DATABASE_URL;
const userId = "00000000-0000-4000-8000-000000000101";
const otherUserId = "00000000-0000-4000-8000-000000000102";
const agentId = "00000000-0000-4000-8000-000000000111";
const otherAgentId = "00000000-0000-4000-8000-000000000112";

test("usage events are persisted, deduplicated, aggregated, and owner-scoped", {
  skip: !testDatabaseUrl,
}, async () => {
  const pool = new Pool({ connectionString: testDatabaseUrl });
  const repository = new UsageEventRepository(pool);

  try {
    await pool.query("TRUNCATE usage_events, agents, users CASCADE");
    await pool.query(
      "INSERT INTO users (id, telegram_user_id) VALUES ($1, 101), ($2, 102)",
      [userId, otherUserId],
    );
    await pool.query(
      `INSERT INTO agents (id, user_id, name, goal, language, working_style)
       VALUES ($1, $2, 'A', 'Research', 'English', 'Concise'),
              ($3, $4, 'B', 'Research', 'English', 'Concise')`,
      [agentId, userId, otherAgentId, otherUserId],
    );

    const first = await repository.record({
      userId,
      agentId,
      requestId: "request-1",
      inputTokens: "9007199254740993",
      outputTokens: 2n,
      totalTokens: "9007199254740995",
      costMicroUsd: 42n,
      status: "succeeded",
      createdAt: "2026-01-01T00:00:00Z",
    });
    const retry = await repository.record({ userId, requestId: "request-1", status: "failed" });
    assert.equal(first.duplicate, false);
    assert.equal(retry.duplicate, true);
    assert.equal(retry.event.id, first.event.id);

    await repository.record({
      userId,
      status: "failed",
      createdAt: "2026-01-01T00:00:00Z",
    });
    await repository.record({
      userId: otherUserId,
      status: "succeeded",
      createdAt: "2026-01-01T00:00:00Z",
    });

    const events = await repository.list(userId, {
      from: "2026-01-01T00:00:00Z",
      to: "2026-01-01T00:00:01Z",
    });
    assert.equal(events.length, 2);
    const summary = await repository.summarize(userId, {
      from: "2026-01-01T00:00:00Z",
      to: "2026-01-01T00:00:01Z",
    });
    assert.equal(summary.eventCount, 2n);
    assert.equal(summary.totalTokens, 9007199254740995n);
    assert.equal(summary.costMicroUsd, 42n);
    assert.equal((await repository.list(otherUserId)).length, 1);

    await assert.rejects(() => repository.record({
      userId,
      agentId: otherAgentId,
      status: "succeeded",
    }));
    await assert.rejects(() => repository.record({ userId, costMicroUsd: -1, status: "succeeded" }));
    await assert.rejects(() => pool.query("UPDATE usage_events SET status = 'cancelled'"));
  } finally {
    await pool.end();
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import { ConversationRepository } from "./conversations.js";

const testDatabaseUrl = process.env.AURA_TEST_DATABASE_URL;
const userId = "00000000-0000-4000-8000-000000000201";
const otherUserId = "00000000-0000-4000-8000-000000000202";
const agentId = "00000000-0000-4000-8000-000000000211";
const otherAgentId = "00000000-0000-4000-8000-000000000212";

test("conversation and message persistence is owner-scoped and retry-safe", {
  skip: !testDatabaseUrl,
}, async () => {
  const pool = new Pool({ connectionString: testDatabaseUrl });
  const repository = new ConversationRepository(pool);
  const createdAt = "2026-01-01T00:00:00Z";

  try {
    await pool.query("TRUNCATE messages, conversations, usage_events, agents, users CASCADE");
    await pool.query(
      "INSERT INTO users (id, telegram_user_id) VALUES ($1, 201), ($2, 202)",
      [userId, otherUserId],
    );
    await pool.query(
      `INSERT INTO agents (id, user_id, name, goal, language, working_style)
       VALUES ($1, $2, 'A', 'Research', 'English', 'Concise'),
              ($3, $4, 'B', 'Research', 'English', 'Concise')`,
      [agentId, userId, otherAgentId, otherUserId],
    );

    const conversation = await repository.createConversation({ userId, agentId });
    const otherConversation = await repository.createConversation({ userId: otherUserId });
    assert.equal(conversation.agentId, agentId);
    assert.deepEqual(await repository.listConversations(otherUserId), [otherConversation]);
    await assert.rejects(() => repository.createConversation({ userId, agentId: otherAgentId }));

    const first = await repository.appendMessage({
      userId,
      conversationId: conversation.id,
      role: "user",
      content: "  Find reliable sources.  ",
      idempotencyKey: "telegram-update-1",
      createdAt,
    });
    const retry = await repository.appendMessage({
      userId,
      conversationId: conversation.id,
      role: "user",
      content: "different payload is ignored for the same retry key",
      idempotencyKey: "telegram-update-1",
    });
    const second = await repository.appendMessage({
      userId,
      conversationId: conversation.id,
      role: "assistant",
      content: "Here are the sources.",
      providerMetadata: { provider: "test", model: "fixture" },
      createdAt,
    });

    assert.equal(first.duplicate, false);
    assert.equal(retry.duplicate, true);
    assert.equal(retry.message.id, first.message.id);
    assert.equal(first.message.content, "Find reliable sources.");
    assert.deepEqual(
      (await repository.listMessages(userId, conversation.id)).map(({ id }) => id),
      [first.message.id, second.message.id].sort(),
    );
    assert.deepEqual(await repository.listMessages(otherUserId, conversation.id), []);
    await assert.rejects(() => repository.appendMessage({
      userId: otherUserId,
      conversationId: conversation.id,
      role: "user",
      content: "cross-tenant",
    }));
    await assert.rejects(() => repository.appendMessage({
      userId,
      conversationId: conversation.id,
      role: "invalid" as never,
      content: "bad role",
    }));
    await assert.rejects(() => repository.appendMessage({
      userId,
      conversationId: conversation.id,
      role: "user",
      content: "   ",
    }));

    await pool.query("DELETE FROM agents WHERE id = $1", [agentId]);
    const detached = (await repository.listConversations(userId))[0];
    assert.equal(detached?.agentId, undefined);
  } finally {
    await pool.end();
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import { OnboardingDraftRepository } from "./onboarding.js";

const testDatabaseUrl = process.env.AURA_TEST_DATABASE_URL;
const userId = "00000000-0000-4000-8000-000000000201";
const otherUserId = "00000000-0000-4000-8000-000000000202";

test("onboarding drafts persist steps, resume safely, and stay owner-scoped", {
  skip: !testDatabaseUrl,
}, async () => {
  const pool = new Pool({ connectionString: testDatabaseUrl });
  const repository = new OnboardingDraftRepository(pool);

  try {
    await pool.query("TRUNCATE onboarding_drafts, users CASCADE");
    await pool.query(
      "INSERT INTO users (id, telegram_user_id) VALUES ($1, 201), ($2, 202)",
      [userId, otherUserId],
    );

    const created = await repository.createOrGetActive(userId);
    assert.equal(created.created, true);
    assert.equal(created.draft.currentStep, "goal");
    const retry = await repository.createOrGetActive(userId);
    assert.equal(retry.created, false);
    assert.equal(retry.draft.id, created.draft.id);
    const concurrent = await Promise.all([
      repository.createOrGetActive(otherUserId),
      repository.createOrGetActive(otherUserId),
    ]);
    assert.equal(new Set(concurrent.map(({ draft }) => draft.id)).size, 1);

    await assert.rejects(() => repository.updateAnswer({
      userId,
      draftId: created.draft.id,
      step: "goal",
      value: "   ",
    }));

    const paused = await repository.pause(userId, created.draft.id);
    assert.equal(paused.draft.status, "paused");
    const resumed = await repository.resume(userId, created.draft.id);
    assert.equal(resumed.draft.status, "in_progress");
    assert.equal((await repository.resume(userId, created.draft.id)).changed, false);

    const goal = await repository.updateAnswer({
      userId,
      draftId: created.draft.id,
      step: "goal",
      value: "Research Swiss energy policy",
    });
    assert.equal(goal.currentStep, "language");
    await assert.rejects(() => repository.updateAnswer({
      userId,
      draftId: created.draft.id,
      step: "goal",
      value: "A duplicate delivery",
    }));
    await repository.updateAnswer({ userId, draftId: created.draft.id, step: "language", value: "English" });
    await repository.updateAnswer({ userId, draftId: created.draft.id, step: "working_style", value: "Concise" });
    await repository.updateAnswer({
      userId,
      draftId: created.draft.id,
      step: "sources",
      value: ["official publications", "official publications", "research papers"],
    });
    const preview = await repository.updateAnswer({
      userId,
      draftId: created.draft.id,
      step: "prohibited_actions",
      value: [],
    });
    assert.equal(preview.status, "ready_for_preview");
    assert.deepEqual(preview.sources, ["official publications", "official publications", "research papers"]);
    assert.deepEqual(preview.prohibitedActions, []);

    assert.equal(await repository.get(otherUserId, created.draft.id), undefined);
    await assert.rejects(() => repository.cancel(otherUserId, created.draft.id));

    const completed = await repository.complete(userId, created.draft.id);
    assert.equal(completed.changed, true);
    assert.equal((await repository.complete(userId, created.draft.id)).changed, false);
    assert.equal((await repository.getActive(userId)), undefined);
  } finally {
    await pool.end();
  }
});

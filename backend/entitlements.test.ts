import assert from "node:assert/strict";
import test from "node:test";
import { EntitlementService, type SubscriptionReader } from "./entitlements.js";
import type { Subscription } from "./db/subscriptions.js";

const userId = "00000000-0000-4000-8000-000000000201";
const periodStart = new Date("2026-01-01T00:00:00Z");
const periodEnd = new Date("2026-02-01T00:00:00Z");

function subscription(status: Subscription["status"], graceUntil?: Date): Subscription {
  return {
    id: "00000000-0000-4000-8000-000000000202",
    userId,
    status,
    periodStart,
    periodEnd,
    ...(graceUntil ? { graceUntil } : {}),
    revision: 1n,
    lastTransitionId: "transition-1",
    createdAt: periodStart,
    updatedAt: periodStart,
  };
}

class FakeSubscriptionReader implements SubscriptionReader {
  constructor(private readonly value?: Subscription, private readonly failure = false) {}

  async get(): Promise<Subscription | undefined> {
    if (this.failure) throw new Error("database unavailable");
    return this.value;
  }
}

test("active subscriptions are entitled only inside their half-open period", async () => {
  const service = new EntitlementService(new FakeSubscriptionReader(subscription("active")));
  assert.equal((await service.check(userId, periodStart)).entitled, true);
  assert.deepEqual(await service.check(userId, periodEnd), { entitled: false, reason: "period_expired" });
});

test("grace access ends at the exact grace deadline", async () => {
  const graceUntil = new Date("2026-02-08T00:00:00Z");
  const service = new EntitlementService(new FakeSubscriptionReader(subscription("grace_period", graceUntil)));
  assert.equal((await service.check(userId, periodEnd)).entitled, true);
  assert.deepEqual(await service.check(userId, graceUntil), { entitled: false, reason: "grace_expired" });
});

test("missing, cancelled, invalid, and unavailable state fail closed", async () => {
  assert.deepEqual(await new EntitlementService(new FakeSubscriptionReader()).check(userId), {
    entitled: false, reason: "missing_subscription",
  });
  assert.deepEqual(await new EntitlementService(new FakeSubscriptionReader(subscription("cancelled"))).check(userId, periodStart), {
    entitled: false, reason: "cancelled",
  });
  assert.deepEqual(await new EntitlementService(new FakeSubscriptionReader(undefined, true)).check(userId), {
    entitled: false, reason: "storage_unavailable",
  });
  assert.deepEqual(await new EntitlementService(new FakeSubscriptionReader()).check("not-a-uuid"), {
    entitled: false, reason: "invalid_user",
  });
});

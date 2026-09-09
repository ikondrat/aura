import type { Subscription, SubscriptionStatus } from "./db/subscriptions.js";

export interface SubscriptionReader {
  get(userId: string): Promise<Subscription | undefined>;
}

export type EntitlementDenialReason =
  | "invalid_user"
  | "storage_unavailable"
  | "missing_subscription"
  | "invalid_subscription"
  | "not_started"
  | "period_expired"
  | "grace_expired"
  | "cancelled";

export interface EntitlementAllowed {
  entitled: true;
  subscription: Subscription;
}

export interface EntitlementDenied {
  entitled: false;
  reason: EntitlementDenialReason;
}

export type EntitlementResult = EntitlementAllowed | EntitlementDenied;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validSubscription(subscription: Subscription): boolean {
  const validStatus: SubscriptionStatus[] = ["active", "grace_period", "cancelled"];
  if (!validStatus.includes(subscription.status)) return false;
  if (!(subscription.periodStart instanceof Date) || Number.isNaN(subscription.periodStart.getTime())) return false;
  if (!(subscription.periodEnd instanceof Date) || Number.isNaN(subscription.periodEnd.getTime())) return false;
  if (subscription.periodStart >= subscription.periodEnd) return false;
  if (subscription.status === "grace_period") {
    return subscription.graceUntil instanceof Date
      && !Number.isNaN(subscription.graceUntil.getTime())
      && subscription.graceUntil >= subscription.periodEnd;
  }
  return subscription.graceUntil === undefined;
}

export class EntitlementService {
  constructor(private readonly subscriptions: SubscriptionReader) {}

  async check(userId: string, now = new Date()): Promise<EntitlementResult> {
    if (typeof userId !== "string" || !UUID_PATTERN.test(userId.trim())) {
      return { entitled: false, reason: "invalid_user" };
    }
    if (Number.isNaN(now.getTime())) return { entitled: false, reason: "invalid_subscription" };

    let subscription: Subscription | undefined;
    try {
      subscription = await this.subscriptions.get(userId.trim());
    } catch {
      return { entitled: false, reason: "storage_unavailable" };
    }
    if (!subscription) return { entitled: false, reason: "missing_subscription" };
    if (!validSubscription(subscription)) return { entitled: false, reason: "invalid_subscription" };
    if (subscription.status === "cancelled") return { entitled: false, reason: "cancelled" };
    if (now < subscription.periodStart) return { entitled: false, reason: "not_started" };
    if (subscription.status === "active") {
      return now < subscription.periodEnd
        ? { entitled: true, subscription }
        : { entitled: false, reason: "period_expired" };
    }
    return now < (subscription.graceUntil as Date)
      ? { entitled: true, subscription }
      : { entitled: false, reason: "grace_expired" };
  }
}

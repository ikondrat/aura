import { randomUUID } from "node:crypto";
import type { Pool, QueryResultRow } from "pg";

export type SubscriptionStatus = "active" | "grace_period" | "cancelled";
export type SubscriptionIntegerInput = bigint | number | string;

export interface Subscription {
  id: string;
  userId: string;
  status: SubscriptionStatus;
  periodStart: Date;
  periodEnd: Date;
  graceUntil?: Date;
  externalReference?: string;
  revision: bigint;
  lastTransitionId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApplySubscriptionTransitionInput {
  userId: string;
  transitionId: string;
  revision: SubscriptionIntegerInput;
  status: SubscriptionStatus;
  periodStart: Date | string;
  periodEnd: Date | string;
  graceUntil?: Date | string;
  externalReference?: string;
}

export interface AppliedSubscriptionTransition {
  subscription: Subscription;
  applied: boolean;
  duplicate: boolean;
}

interface SubscriptionRow extends QueryResultRow {
  id: string;
  user_id: string;
  status: SubscriptionStatus;
  period_start: Date;
  period_end: Date;
  grace_until: Date | null;
  external_reference: string | null;
  revision: string;
  last_transition_id: string;
  created_at: Date;
  updated_at: Date;
}

interface InsertedTransitionRow extends QueryResultRow {
  id: string;
}

const MAX_INT64 = 9_223_372_036_854_775_807n;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TEXT_LENGTH = 500;

function requireUuid(value: string, fieldName: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value.trim())) {
    throw new Error(`${fieldName} must be a UUID`);
  }
  return value.trim();
}

function requireText(value: string, fieldName: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${fieldName} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${fieldName} must not be empty`);
  if (normalized.length > maxLength) throw new Error(`${fieldName} is too long`);
  return normalized;
}

function optionalText(value: string | undefined, fieldName: string): string | undefined {
  return value === undefined ? undefined : requireText(value, fieldName, MAX_TEXT_LENGTH);
}

function dateValue(value: Date | string | undefined, fieldName: string): Date | undefined {
  if (value === undefined) return undefined;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${fieldName} must be a valid date`);
  return date;
}

function revisionValue(value: SubscriptionIntegerInput): bigint {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error("revision must be a non-negative safe integer");
  }
  let revision: bigint;
  try {
    revision = BigInt(value);
  } catch {
    throw new Error("revision must be a non-negative integer");
  }
  if (revision < 0n || revision > MAX_INT64) throw new Error("revision must fit in a PostgreSQL bigint");
  return revision;
}

function normalizeTransition(input: ApplySubscriptionTransitionInput) {
  const userId = requireUuid(input.userId, "userId");
  const transitionId = requireText(input.transitionId, "transitionId", 255);
  if (!("active" === input.status || "grace_period" === input.status || "cancelled" === input.status)) {
    throw new Error("status must be active, grace_period, or cancelled");
  }
  const periodStart = dateValue(input.periodStart, "periodStart") as Date;
  const periodEnd = dateValue(input.periodEnd, "periodEnd") as Date;
  if (periodStart >= periodEnd) throw new Error("periodStart must be before periodEnd");
  const graceUntil = dateValue(input.graceUntil, "graceUntil");
  if (input.status === "grace_period" && (!graceUntil || graceUntil < periodEnd)) {
    throw new Error("graceUntil is required and must be on or after periodEnd for grace_period");
  }
  if (input.status !== "grace_period" && graceUntil) {
    throw new Error("graceUntil is only valid for grace_period");
  }
  return {
    userId,
    transitionId,
    revision: revisionValue(input.revision),
    status: input.status,
    periodStart,
    periodEnd,
    graceUntil,
    externalReference: optionalText(input.externalReference, "externalReference"),
  };
}

function mapSubscription(row: SubscriptionRow): Subscription {
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status,
    periodStart: new Date(row.period_start),
    periodEnd: new Date(row.period_end),
    ...(row.grace_until ? { graceUntil: new Date(row.grace_until) } : {}),
    ...(row.external_reference ? { externalReference: row.external_reference } : {}),
    revision: BigInt(row.revision),
    lastTransitionId: row.last_transition_id,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

const SUBSCRIPTION_COLUMNS = `id, user_id, status, period_start, period_end, grace_until,
  external_reference, revision, last_transition_id, created_at, updated_at`;

export class SubscriptionRepository {
  constructor(private readonly pool: Pool) {}

  async get(userId: string): Promise<Subscription | undefined> {
    const ownerId = requireUuid(userId, "userId");
    const result = await this.pool.query<SubscriptionRow>(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions WHERE user_id = $1`,
      [ownerId],
    );
    return result.rows[0] ? mapSubscription(result.rows[0]) : undefined;
  }

  /**
   * Applies only a strictly newer revision. The transition ledger makes event
   * retries idempotent; older or same-revision events are recorded but cannot
   * revert the current state.
   */
  async applyTransition(input: ApplySubscriptionTransitionInput): Promise<AppliedSubscriptionTransition> {
    const transition = normalizeTransition(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const ownerResult = await client.query<{ id: string }>(
        "SELECT id FROM users WHERE id = $1 FOR UPDATE",
        [transition.userId],
      );
      if (!ownerResult.rows[0]) throw new Error("subscription user not found");
      const currentResult = await client.query<SubscriptionRow>(
        `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions WHERE user_id = $1 FOR UPDATE`,
        [transition.userId],
      );
      const current = currentResult.rows[0] ? mapSubscription(currentResult.rows[0]) : undefined;
      const existingEvent = await client.query<{ id: string }>(
        `SELECT id FROM subscription_transitions WHERE user_id = $1 AND transition_id = $2`,
        [transition.userId, transition.transitionId],
      );
      if (existingEvent.rows[0]) {
        if (!current) throw new Error("subscription transition ledger is inconsistent");
        await client.query("COMMIT");
        return { subscription: current, applied: false, duplicate: true };
      }

      const insertedEvent = await client.query<InsertedTransitionRow>(
        `INSERT INTO subscription_transitions (
           id, user_id, transition_id, revision, status, period_start, period_end,
           grace_until, external_reference
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (user_id, transition_id) DO NOTHING
         RETURNING id`,
        [
          randomUUID(), transition.userId, transition.transitionId, transition.revision,
          transition.status, transition.periodStart, transition.periodEnd,
          transition.graceUntil ?? null, transition.externalReference ?? null,
        ],
      );
      if (!insertedEvent.rows[0]) {
        const afterRace = await client.query<SubscriptionRow>(
          `SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions WHERE user_id = $1 FOR UPDATE`,
          [transition.userId],
        );
        if (!afterRace.rows[0]) throw new Error("subscription transition ledger is inconsistent");
        await client.query("COMMIT");
        return { subscription: mapSubscription(afterRace.rows[0]), applied: false, duplicate: true };
      }

      if (current && transition.revision <= current.revision) {
        await client.query("COMMIT");
        return { subscription: current, applied: false, duplicate: false };
      }

      const values = [
        transition.userId, transition.status, transition.periodStart, transition.periodEnd,
        transition.graceUntil ?? null, transition.externalReference ?? null,
        transition.revision, transition.transitionId,
      ];
      const result = current
        ? await client.query<SubscriptionRow>(
          `UPDATE subscriptions SET
             status = $2, period_start = $3, period_end = $4, grace_until = $5,
             external_reference = $6, revision = $7, last_transition_id = $8
           WHERE user_id = $1
           RETURNING ${SUBSCRIPTION_COLUMNS}`,
          values,
        )
        : await client.query<SubscriptionRow>(
          `INSERT INTO subscriptions (
             id, user_id, status, period_start, period_end, grace_until,
             external_reference, revision, last_transition_id
           ) VALUES ($9, $1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING ${SUBSCRIPTION_COLUMNS}`,
          [...values, randomUUID()],
        );
      if (!result.rows[0]) throw new Error("subscription transition did not update a subscription");
      await client.query("COMMIT");
      return { subscription: mapSubscription(result.rows[0]), applied: true, duplicate: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export { UUID_PATTERN as subscriptionUuidPattern };

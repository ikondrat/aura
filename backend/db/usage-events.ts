import { randomUUID } from "node:crypto";
import type { Pool, QueryResultRow } from "pg";

export type UsageStatus = "succeeded" | "failed" | "cancelled";

export interface UsageEvent {
  id: string;
  userId: string;
  agentId?: string;
  conversationId?: string;
  provider?: string;
  model?: string;
  requestId?: string;
  inputTokens: bigint;
  outputTokens: bigint;
  totalTokens: bigint;
  costMicroUsd: bigint | null;
  status: UsageStatus;
  createdAt: Date;
}

export interface RecordUsageEventInput {
  userId: string;
  agentId?: string;
  conversationId?: string;
  provider?: string;
  model?: string;
  requestId?: string;
  inputTokens?: bigint | number | string;
  outputTokens?: bigint | number | string;
  totalTokens?: bigint | number | string;
  costMicroUsd?: bigint | number | string | null;
  status: UsageStatus;
  createdAt?: Date | string;
}

export interface UsagePeriod {
  from?: Date | string;
  to?: Date | string;
}

export interface ListUsageEventsOptions extends UsagePeriod {
  limit?: number;
}

export interface UsageSummary {
  eventCount: bigint;
  inputTokens: bigint;
  outputTokens: bigint;
  totalTokens: bigint;
  costMicroUsd: bigint | null;
}

export interface RecordedUsageEvent {
  event: UsageEvent;
  duplicate: boolean;
}

interface UsageEventRow extends QueryResultRow {
  id: string;
  user_id: string;
  agent_id: string | null;
  conversation_id: string | null;
  provider: string | null;
  model: string | null;
  request_id: string | null;
  input_tokens: string;
  output_tokens: string;
  total_tokens: string;
  cost_microusd: string | null;
  status: UsageStatus;
  created_at: Date;
}

interface UsageSummaryRow extends QueryResultRow {
  event_count: string;
  input_tokens: string;
  output_tokens: string;
  total_tokens: string;
  cost_microusd: string | null;
}

const MAX_INT64 = 9_223_372_036_854_775_807n;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TEXT_LENGTH = 500;

function requireUuid(value: string, fieldName: string): string {
  if (!UUID_PATTERN.test(value.trim())) throw new Error(`${fieldName} must be a UUID`);
  return value.trim();
}

function optionalUuid(value: string | undefined, fieldName: string): string | undefined {
  if (value === undefined) return undefined;
  return requireUuid(value, fieldName);
}

function optionalText(value: string | undefined, fieldName: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized) throw new Error(`${fieldName} must not be empty`);
  if (normalized.length > MAX_TEXT_LENGTH) throw new Error(`${fieldName} is too long`);
  return normalized;
}

function nonNegativeInt64(value: bigint | number | string | undefined, fieldName: string): bigint {
  if (value === undefined) return 0n;
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`${fieldName} must be a non-negative safe integer`);
  }

  let normalized: bigint;
  try {
    normalized = typeof value === "number" ? BigInt(value) : BigInt(value);
  } catch {
    throw new Error(`${fieldName} must be a non-negative integer`);
  }
  if (normalized < 0n || normalized > MAX_INT64) {
    throw new Error(`${fieldName} must fit in a PostgreSQL bigint`);
  }
  return normalized;
}

function optionalNonNegativeInt64(
  value: bigint | number | string | null | undefined,
  fieldName: string,
): bigint | null {
  return value === null || value === undefined ? null : nonNegativeInt64(value, fieldName);
}

function dateValue(value: Date | string | undefined, fieldName: string): Date | undefined {
  if (value === undefined) return undefined;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${fieldName} must be a valid date`);
  return date;
}

function dateParameters(period: UsagePeriod): { clauses: string[]; values: unknown[] } {
  const clauses: string[] = [];
  const values: unknown[] = [];
  const from = dateValue(period.from, "from");
  const to = dateValue(period.to, "to");
  if (from) {
    values.push(from);
    clauses.push(`created_at >= $${values.length + 1}`);
  }
  if (to) {
    values.push(to);
    clauses.push(`created_at < $${values.length + 1}`);
  }
  return { clauses, values };
}

function mapEvent(row: UsageEventRow): UsageEvent {
  return {
    id: row.id,
    userId: row.user_id,
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
    ...(row.provider ? { provider: row.provider } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.request_id ? { requestId: row.request_id } : {}),
    inputTokens: BigInt(row.input_tokens),
    outputTokens: BigInt(row.output_tokens),
    totalTokens: BigInt(row.total_tokens),
    costMicroUsd: row.cost_microusd === null ? null : BigInt(row.cost_microusd),
    status: row.status,
    createdAt: new Date(row.created_at),
  };
}

function mapSummary(row: UsageSummaryRow): UsageSummary {
  return {
    eventCount: BigInt(row.event_count),
    inputTokens: BigInt(row.input_tokens),
    outputTokens: BigInt(row.output_tokens),
    totalTokens: BigInt(row.total_tokens),
    costMicroUsd: row.cost_microusd === null ? null : BigInt(row.cost_microusd),
  };
}

export class UsageEventRepository {
  constructor(private readonly pool: Pool) {}

  async record(input: RecordUsageEventInput): Promise<RecordedUsageEvent> {
    const userId = requireUuid(input.userId, "userId");
    const agentId = optionalUuid(input.agentId, "agentId");
    const conversationId = optionalUuid(input.conversationId, "conversationId");
    const provider = optionalText(input.provider, "provider");
    const model = optionalText(input.model, "model");
    const requestId = optionalText(input.requestId, "requestId");
    if (!(["succeeded", "failed", "cancelled"] as UsageStatus[]).includes(input.status)) {
      throw new Error("status must be succeeded, failed, or cancelled");
    }
    const createdAt = dateValue(input.createdAt, "createdAt");
    const inputTokens = nonNegativeInt64(input.inputTokens, "inputTokens");
    const outputTokens = nonNegativeInt64(input.outputTokens, "outputTokens");
    const totalTokens = nonNegativeInt64(input.totalTokens, "totalTokens");
    const costMicroUsd = optionalNonNegativeInt64(input.costMicroUsd, "costMicroUsd");
    const id = randomUUID();

    const result = await this.pool.query<UsageEventRow>(
      `INSERT INTO usage_events (
         id, user_id, agent_id, conversation_id, provider, model, request_id,
         input_tokens, output_tokens, total_tokens, cost_microusd, status, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, COALESCE($13, now()))
       ON CONFLICT (user_id, request_id) WHERE request_id IS NOT NULL DO NOTHING
       RETURNING id, user_id, agent_id, conversation_id, provider, model, request_id,
         input_tokens, output_tokens, total_tokens, cost_microusd, status, created_at`,
      [
        id,
        userId,
        agentId ?? null,
        conversationId ?? null,
        provider ?? null,
        model ?? null,
        requestId ?? null,
        inputTokens,
        outputTokens,
        totalTokens,
        costMicroUsd,
        input.status,
        createdAt ?? null,
      ],
    );

    if (result.rows[0]) return { event: mapEvent(result.rows[0]), duplicate: false };
    if (!requestId) throw new Error("Usage event insert did not return a row");

    const duplicate = await this.pool.query<UsageEventRow>(
      `SELECT id, user_id, agent_id, conversation_id, provider, model, request_id,
         input_tokens, output_tokens, total_tokens, cost_microusd, status, created_at
       FROM usage_events
       WHERE user_id = $1 AND request_id = $2`,
      [userId, requestId],
    );
    if (!duplicate.rows[0]) throw new Error("Usage event request ID conflict could not be resolved");
    return { event: mapEvent(duplicate.rows[0]), duplicate: true };
  }

  async list(userId: string, options: ListUsageEventsOptions = {}): Promise<UsageEvent[]> {
    const ownerId = requireUuid(userId, "userId");
    const { clauses, values } = dateParameters(options);
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("limit must be an integer between 1 and 1000");
    }
    const predicates = [`user_id = $1`, ...clauses];
    const result = await this.pool.query<UsageEventRow>(
      `SELECT id, user_id, agent_id, conversation_id, provider, model, request_id,
         input_tokens, output_tokens, total_tokens, cost_microusd, status, created_at
       FROM usage_events
       WHERE ${predicates.join(" AND ")}
       ORDER BY created_at DESC, id DESC
       LIMIT $${values.length + 2}`,
      [ownerId, ...values, limit],
    );
    return result.rows.map(mapEvent);
  }

  async summarize(userId: string, period: UsagePeriod = {}): Promise<UsageSummary> {
    const ownerId = requireUuid(userId, "userId");
    const { clauses, values } = dateParameters(period);
    const predicates = [`user_id = $1`, ...clauses];
    const result = await this.pool.query<UsageSummaryRow>(
      `SELECT COUNT(*)::text AS event_count,
         COALESCE(SUM(input_tokens), 0)::text AS input_tokens,
         COALESCE(SUM(output_tokens), 0)::text AS output_tokens,
         COALESCE(SUM(total_tokens), 0)::text AS total_tokens,
         SUM(cost_microusd)::text AS cost_microusd
       FROM usage_events
       WHERE ${predicates.join(" AND ")}`,
      [ownerId, ...values],
    );
    return mapSummary(result.rows[0]);
  }
}

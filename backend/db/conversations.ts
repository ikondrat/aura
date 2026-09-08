import { randomUUID } from "node:crypto";
import type { Pool, QueryResultRow } from "pg";

export type ConversationStatus = "active" | "archived";
export type MessageRole = "user" | "assistant" | "system" | "tool";

export interface Conversation {
  id: string;
  userId: string;
  agentId?: string;
  status: ConversationStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  providerMetadata?: Record<string, unknown>;
  idempotencyKey?: string;
  createdAt: Date;
}

export interface CreateConversationInput {
  userId: string;
  agentId?: string;
  status?: ConversationStatus;
}

export interface AppendMessageInput {
  userId: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  providerMetadata?: Record<string, unknown> | null;
  idempotencyKey?: string;
  createdAt?: Date | string;
}

export interface ListConversationsOptions {
  limit?: number;
}

export interface ListMessagesOptions {
  limit?: number;
}

export interface RecordedMessage {
  message: Message;
  duplicate: boolean;
}

interface ConversationRow extends QueryResultRow {
  id: string;
  user_id: string;
  agent_id: string | null;
  status: ConversationStatus;
  created_at: Date;
  updated_at: Date;
}

interface MessageRow extends QueryResultRow {
  id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  provider_metadata: Record<string, unknown> | null;
  idempotency_key: string | null;
  created_at: Date;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CONTENT_LENGTH = 10_000;
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;
const MESSAGE_ROLES: MessageRole[] = ["user", "assistant", "system", "tool"];

function requireUuid(value: string, fieldName: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value.trim())) {
    throw new Error(`${fieldName} must be a UUID`);
  }
  return value.trim();
}

function optionalUuid(value: string | undefined, fieldName: string): string | undefined {
  return value === undefined ? undefined : requireUuid(value, fieldName);
}

function optionalText(value: string | undefined, fieldName: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized) throw new Error(`${fieldName} must not be empty`);
  if (normalized.length > maxLength) throw new Error(`${fieldName} is too long`);
  return normalized;
}

function dateValue(value: Date | string | undefined, fieldName: string): Date | undefined {
  if (value === undefined) return undefined;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${fieldName} must be a valid date`);
  return date;
}

function validateMetadata(value: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("providerMetadata must be an object");
  }
  try {
    JSON.stringify(value);
  } catch {
    throw new Error("providerMetadata must be JSON serializable");
  }
  return value;
}

function validateLimit(limit: number | undefined): number {
  const normalized = limit ?? 100;
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > 1_000) {
    throw new Error("limit must be an integer between 1 and 1000");
  }
  return normalized;
}

function mapConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    userId: row.user_id,
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    status: row.status,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function mapMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    ...(row.provider_metadata ? { providerMetadata: row.provider_metadata } : {}),
    ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
    createdAt: new Date(row.created_at),
  };
}

const conversationColumns = "id, user_id, agent_id, status, created_at, updated_at";
const messageColumns = "id, conversation_id, role, content, provider_metadata, idempotency_key, created_at";
const qualifiedMessageColumns = `m.${messageColumns.replaceAll(", ", ", m.")}`;

export class ConversationRepository {
  constructor(private readonly pool: Pool) {}

  async createConversation(input: CreateConversationInput): Promise<Conversation> {
    const userId = requireUuid(input.userId, "userId");
    const agentId = optionalUuid(input.agentId, "agentId");
    const status = input.status ?? "active";
    if (status !== "active" && status !== "archived") {
      throw new Error("status must be active or archived");
    }

    const result = await this.pool.query<ConversationRow>(
      `INSERT INTO conversations (id, user_id, agent_id, status)
       VALUES ($1, $2, $3, $4)
       RETURNING ${conversationColumns}`,
      [randomUUID(), userId, agentId ?? null, status],
    );
    return mapConversation(result.rows[0]);
  }

  async appendMessage(input: AppendMessageInput): Promise<RecordedMessage> {
    const userId = requireUuid(input.userId, "userId");
    const conversationId = requireUuid(input.conversationId, "conversationId");
    if (!MESSAGE_ROLES.includes(input.role)) {
      throw new Error("role must be user, assistant, system, or tool");
    }
    if (typeof input.content !== "string") throw new Error("content must be a string");
    const content = input.content.trim();
    if (!content) throw new Error("content must not be empty");
    if (content.length > MAX_CONTENT_LENGTH) throw new Error("content is too long");
    const providerMetadata = validateMetadata(input.providerMetadata);
    const idempotencyKey = optionalText(input.idempotencyKey, "idempotencyKey", MAX_IDEMPOTENCY_KEY_LENGTH);
    const createdAt = dateValue(input.createdAt, "createdAt");

    const result = await this.pool.query<MessageRow>(
      `INSERT INTO messages (
         id, conversation_id, role, content, provider_metadata, idempotency_key, created_at
       )
       SELECT $1, $2, $3, $4, $5::jsonb, $6, COALESCE($7, now())
       FROM conversations
       WHERE id = $2 AND user_id = $8
       ON CONFLICT (conversation_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING ${messageColumns}`,
      [
        randomUUID(),
        conversationId,
        input.role,
        content,
        providerMetadata,
        idempotencyKey ?? null,
        createdAt ?? null,
        userId,
      ],
    );

    if (result.rows[0]) return { message: mapMessage(result.rows[0]), duplicate: false };
    if (!idempotencyKey) throw new Error("conversation not found for user");

    const duplicate = await this.pool.query<MessageRow>(
      `SELECT ${qualifiedMessageColumns}
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE c.id = $1 AND c.user_id = $2 AND m.idempotency_key = $3`,
      [conversationId, userId, idempotencyKey],
    );
    if (!duplicate.rows[0]) throw new Error("conversation not found for user");
    return { message: mapMessage(duplicate.rows[0]), duplicate: true };
  }

  async listConversations(userId: string, options: ListConversationsOptions = {}): Promise<Conversation[]> {
    const ownerId = requireUuid(userId, "userId");
    const limit = validateLimit(options.limit);
    const result = await this.pool.query<ConversationRow>(
      `SELECT ${conversationColumns}
       FROM conversations
       WHERE user_id = $1
       ORDER BY updated_at DESC, id DESC
       LIMIT $2`,
      [ownerId, limit],
    );
    return result.rows.map(mapConversation);
  }

  async listMessages(
    userId: string,
    conversationId: string,
    options: ListMessagesOptions = {},
  ): Promise<Message[]> {
    const ownerId = requireUuid(userId, "userId");
    const conversation = requireUuid(conversationId, "conversationId");
    const limit = validateLimit(options.limit);
    const result = await this.pool.query<MessageRow>(
      `SELECT ${qualifiedMessageColumns}
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE c.id = $1 AND c.user_id = $2
       ORDER BY m.created_at ASC, m.id ASC
       LIMIT $3`,
      [conversation, ownerId, limit],
    );
    return result.rows.map(mapMessage);
  }
}

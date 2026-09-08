import { randomUUID } from "node:crypto";
import type {
  Conversation,
  Message,
  RecordedMessage,
} from "./db/conversations.js";
import type {
  ResearchAgentConfiguration,
  ResearchCitation,
  ResearchAgentResult,
  ResearchConversationMessage,
} from "./research-agent.js";

type MaybePromise<T> = T | Promise<T>;

export interface TaskUser {
  id: string;
  telegramUserId: number;
}

export interface ActiveTaskAgent extends ResearchAgentConfiguration {
  id: string;
  userId: string;
}

export interface TaskUserStore {
  findByTelegramUserId(telegramUserId: number): MaybePromise<TaskUser | undefined>;
}

export interface TaskAgentStore {
  findActiveByOwner(userId: string): MaybePromise<ActiveTaskAgent | undefined>;
}

export interface TaskConversationStore {
  findOrCreateConversation(input: {
    userId: string;
    agentId: string;
  }): MaybePromise<Conversation>;
  listMessages(userId: string, conversationId: string): MaybePromise<Message[]>;
  appendMessage(input: {
    userId: string;
    conversationId: string;
    role: "user" | "assistant";
    content: string;
    idempotencyKey?: string;
  }): MaybePromise<RecordedMessage>;
}

export interface TaskOrchestrator {
  run(input: {
    agent: ActiveTaskAgent;
    history: readonly ResearchConversationMessage[];
    request: string;
  }): MaybePromise<ResearchAgentResult>;
}

export interface TaskFlowInput {
  telegramUserId: number;
  chatId: number | string;
  text: string;
  updateId: number;
}

export type TaskReply = (chatId: number | string, text: string) => MaybePromise<boolean>;

export interface TaskFlowLogger {
  warn(message: string): void;
  error(message: string): void;
}

export interface TelegramTaskFlowOptions {
  users: TaskUserStore;
  agents: TaskAgentStore;
  conversations: TaskConversationStore;
  orchestrator: TaskOrchestrator;
  reply: TaskReply;
  logger?: TaskFlowLogger;
}

const MAX_TELEGRAM_MESSAGE_LENGTH = 4_096;
const DEFAULT_LOGGER: TaskFlowLogger = {
  warn: () => undefined,
  error: () => undefined,
};

const SETUP_MESSAGE = "Your research agent is not active yet. Send /setup to create one.";
const START_MESSAGE = "Please send /start before sending a task.";
const RETRY_MESSAGE = "Your request is still being processed. Please try again shortly.";
const FAILURE_MESSAGE = "I couldn't process that request right now. Please try again.";

function boundedTelegramText(text: string): string {
  if (text.length <= MAX_TELEGRAM_MESSAGE_LENGTH) return text;
  return `${text.slice(0, MAX_TELEGRAM_MESSAGE_LENGTH - 1)}…`;
}

export function formatResearchResult(result: ResearchAgentResult): string {
  if (result.outcome === "clarification") return boundedTelegramText(result.question);

  const sections = [result.answer];
  if (result.assumptions.length > 0) {
    sections.push(`Assumptions:\n${result.assumptions.map((item) => `- ${item}`).join("\n")}`);
  }
  if (result.limitation) sections.push(`Limitation: ${result.limitation}`);
  if (result.citations && result.citations.length > 0) {
    sections.push([
      "Sources:",
      ...result.citations.map((citation, index) => formatCitation(citation, index + 1)),
    ].join("\n"));
  }
  return boundedTelegramText(sections.join("\n\n"));
}

function formatCitation(citation: ResearchCitation, number: number): string {
  const title = citation.title.replace(/\s+/g, " ").trim();
  const domain = citation.domain.replace(/\s+/g, " ").trim();
  return `[${number}] ${title} (${domain})\n${citation.url}`;
}

function messageHistory(messages: readonly Message[], currentMessageId: string): ResearchConversationMessage[] {
  return messages
    .filter((message) => message.id !== currentMessageId)
    .map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
    }));
}

interface DeliveryEntry {
  chatId: number | string;
  response?: string;
  delivered: boolean;
  processing: Promise<void>;
}

export class TelegramTaskFlow {
  private readonly logger: TaskFlowLogger;
  private readonly deliveries = new Map<string, DeliveryEntry>();
  private readonly userLocks = new Map<string, Promise<void>>();

  constructor(private readonly options: TelegramTaskFlowOptions) {
    this.logger = options.logger ?? DEFAULT_LOGGER;
  }

  async handle(input: TaskFlowInput): Promise<boolean> {
    const key = `${input.telegramUserId}:${input.updateId}`;
    const existing = this.deliveries.get(key);
    if (existing) {
      await existing.processing;
      if (!existing.delivered && existing.response) await this.deliver(existing);
      return true;
    }

    const entry: DeliveryEntry = {
      chatId: input.chatId,
      delivered: false,
      processing: Promise.resolve(),
    };
    this.deliveries.set(key, entry);
    entry.processing = this.serialize(String(input.telegramUserId), async () => {
      entry.response = await this.process(input);
      if (entry.response) await this.deliver(entry);
    });
    await entry.processing;
    return true;
  }

  private async process(input: TaskFlowInput): Promise<string | undefined> {
    if (!input.text.trim()) return "Please send a non-empty task.";

    const user = await this.options.users.findByTelegramUserId(input.telegramUserId);
    if (!user) return START_MESSAGE;

    const agent = await this.options.agents.findActiveByOwner(user.id);
    if (!agent || agent.userId !== user.id) return SETUP_MESSAGE;

    let conversation: Conversation;
    try {
      conversation = await this.options.conversations.findOrCreateConversation({
        userId: user.id,
        agentId: agent.id,
      });
      if (conversation.userId !== user.id || conversation.agentId !== agent.id) {
        this.logger.error("Task conversation ownership validation failed");
        return FAILURE_MESSAGE;
      }

      const userMessage = await this.options.conversations.appendMessage({
        userId: user.id,
        conversationId: conversation.id,
        role: "user",
        content: input.text,
        idempotencyKey: `telegram-update:${input.updateId}`,
      });
      const assistantKey = `telegram-assistant:${input.updateId}`;
      const messages = await this.options.conversations.listMessages(user.id, conversation.id);
      const existingAssistant = messages.find((message) => message.idempotencyKey === assistantKey);
      if (userMessage.duplicate || existingAssistant) {
        return existingAssistant?.content ?? RETRY_MESSAGE;
      }

      const result = await this.options.orchestrator.run({
        agent,
        history: messageHistory(messages, userMessage.message.id),
        request: userMessage.message.content,
      });
      const response = formatResearchResult(result);
      const assistant = await this.options.conversations.appendMessage({
        userId: user.id,
        conversationId: conversation.id,
        role: "assistant",
        content: response,
        idempotencyKey: assistantKey,
      });
      return assistant.message.content;
    } catch {
      this.logger.error("Telegram task processing failed");
      return FAILURE_MESSAGE;
    }
  }

  private async deliver(entry: DeliveryEntry): Promise<void> {
    if (!entry.response || entry.delivered) return;
    try {
      entry.delivered = await this.options.reply(entry.chatId, entry.response);
      if (!entry.delivered) this.logger.warn("Telegram task delivery failed; retry is available");
    } catch {
      entry.delivered = false;
      this.logger.warn("Telegram task delivery failed; retry is available");
    }
  }

  private async serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.userLocks.get(key);
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.userLocks.set(key, current);
    if (previous) await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.userLocks.get(key) === current) this.userLocks.delete(key);
    }
  }
}

export class ConversationRepositoryTaskStore implements TaskConversationStore {
  constructor(private readonly repository: {
    listConversations(userId: string): Promise<Conversation[]>;
    createConversation(input: { userId: string; agentId: string }): Promise<Conversation>;
    listMessages(userId: string, conversationId: string): Promise<Message[]>;
    appendMessage(input: {
      userId: string;
      conversationId: string;
      role: "user" | "assistant";
      content: string;
      idempotencyKey?: string;
    }): Promise<RecordedMessage>;
  }) {}

  async findOrCreateConversation(input: { userId: string; agentId: string }): Promise<Conversation> {
    const existing = (await this.repository.listConversations(input.userId))
      .find((conversation) => conversation.status === "active" && conversation.agentId === input.agentId);
    return existing ?? this.repository.createConversation(input);
  }

  listMessages(userId: string, conversationId: string): Promise<Message[]> {
    return this.repository.listMessages(userId, conversationId);
  }

  appendMessage(input: {
    userId: string;
    conversationId: string;
    role: "user" | "assistant";
    content: string;
    idempotencyKey?: string;
  }): Promise<RecordedMessage> {
    return this.repository.appendMessage(input);
  }
}

export class InMemoryTaskUserStore implements TaskUserStore {
  private readonly users = new Map<number, TaskUser>();

  set(user: TaskUser): void {
    this.users.set(user.telegramUserId, { ...user });
  }

  findByTelegramUserId(telegramUserId: number): TaskUser | undefined {
    const user = this.users.get(telegramUserId);
    return user ? { ...user } : undefined;
  }
}

export class InMemoryTaskAgentStore implements TaskAgentStore {
  private readonly agents = new Map<string, ActiveTaskAgent>();

  set(agent: ActiveTaskAgent): void {
    this.agents.set(agent.userId, { ...agent });
  }

  findActiveByOwner(userId: string): ActiveTaskAgent | undefined {
    const agent = this.agents.get(userId);
    return agent ? { ...agent } : undefined;
  }
}

export class InMemoryTaskConversationStore implements TaskConversationStore {
  private readonly conversations = new Map<string, Conversation>();
  private readonly messages = new Map<string, Message[]>();

  findOrCreateConversation(input: { userId: string; agentId: string }): Conversation {
    const key = `${input.userId}:${input.agentId}`;
    const existing = this.conversations.get(key);
    if (existing) return { ...existing };
    const now = new Date();
    const conversation: Conversation = {
      id: randomUUID(),
      userId: input.userId,
      agentId: input.agentId,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    this.conversations.set(key, conversation);
    this.messages.set(conversation.id, []);
    return { ...conversation };
  }

  listMessages(userId: string, conversationId: string): Message[] {
    const conversation = [...this.conversations.values()]
      .find((candidate) => candidate.id === conversationId && candidate.userId === userId);
    if (!conversation) return [];
    return [...(this.messages.get(conversation.id) ?? [])]
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id))
      .map((message) => ({ ...message }));
  }

  appendMessage(input: {
    userId: string;
    conversationId: string;
    role: "user" | "assistant";
    content: string;
    idempotencyKey?: string;
  }): RecordedMessage {
    const conversation = [...this.conversations.values()]
      .find((candidate) => candidate.id === input.conversationId && candidate.userId === input.userId);
    if (!conversation) throw new Error("conversation not found for user");
    const messages = this.messages.get(conversation.id) ?? [];
    const duplicate = input.idempotencyKey
      ? messages.find((message) => message.idempotencyKey === input.idempotencyKey)
      : undefined;
    if (duplicate) return { message: { ...duplicate }, duplicate: true };
    const message: Message = {
      id: randomUUID(),
      conversationId: conversation.id,
      role: input.role,
      content: input.content.trim(),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      createdAt: new Date(),
    };
    messages.push(message);
    this.messages.set(conversation.id, messages);
    conversation.updatedAt = message.createdAt;
    return { message: { ...message }, duplicate: false };
  }
}

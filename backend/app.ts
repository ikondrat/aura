import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual } from "node:crypto";
import {
  InMemoryTelegramUserStore,
  type TelegramClient,
  type TelegramUserStore,
} from "./telegram.js";
import {
  InMemoryMemoryStore,
  MemoryConsentRequiredError,
  MemoryValidationError,
  type MemoryStore,
} from "./memory.js";

const MAX_REQUEST_BODY_BYTES = 1_048_576;

interface Logger {
  error(message: string, details?: Record<string, number | undefined>): void;
  warn(message: string): void;
}

const defaultLogger: Logger = {
  error: (message, details) => console.error(message, details),
  warn: (message) => console.warn(message),
};

interface TelegramMessage {
  chat?: { id?: number | string };
  from?: {
    id?: number;
    first_name?: string;
    last_name?: string;
    username?: string;
  };
  text?: string;
}

interface TelegramUpdate {
  message?: TelegramMessage;
}

export interface AppOptions {
  telegramClient?: TelegramClient;
  userStore?: TelegramUserStore;
  memoryStore?: MemoryStore;
  webhookSecret?: string;
  logger?: Logger;
  maxRequestBodyBytes?: number;
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function readBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;

    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) {
        reject(new Error("request body too large"));
        request.destroy();
        return;
      }
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function isValidWebhookSecret(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  return (
    providedBytes.length === expectedBytes.length &&
    timingSafeEqual(providedBytes, expectedBytes)
  );
}

function isTelegramUpdate(value: unknown): value is TelegramUpdate {
  return typeof value === "object" && value !== null;
}

interface TelegramCommand {
  name: string;
  args: string;
}

function getTelegramCommand(message: TelegramMessage): TelegramCommand | undefined {
  if (typeof message.text !== "string") return undefined;
  const match = message.text.match(/^\/([a-z][a-z_]*)?(?:@[^\s]+)?(?:\s+([\s\S]*))?$/i);
  if (!match?.[1]) return undefined;
  return { name: match[1].toLowerCase(), args: match[2]?.trim() ?? "" };
}

async function handleTelegramWebhook(
  request: IncomingMessage,
  response: ServerResponse,
  options: Required<Pick<AppOptions, "userStore" | "logger" | "memoryStore">> & AppOptions,
): Promise<void> {
  if (
    options.webhookSecret &&
    !isValidWebhookSecret(
      Array.isArray(request.headers["x-telegram-bot-api-secret-token"])
        ? undefined
        : request.headers["x-telegram-bot-api-secret-token"],
      options.webhookSecret,
    )
  ) {
    sendJson(response, 401, { error: "Unauthorized" });
    return;
  }

  let update: unknown;
  try {
    update = JSON.parse(await readBody(request, options.maxRequestBodyBytes ?? MAX_REQUEST_BODY_BYTES));
  } catch (error) {
    if (error instanceof Error && error.message === "request body too large") {
      sendJson(response, 413, { error: "Request body too large" });
      return;
    }
    sendJson(response, 400, { error: "Invalid JSON" });
    return;
  }

  if (!isTelegramUpdate(update)) {
    sendJson(response, 400, { error: "Invalid Telegram update" });
    return;
  }

  const message = update.message;
  const command = message ? getTelegramCommand(message) : undefined;
  if (!message || !command) {
    sendJson(response, 200, { ok: true });
    return;
  }

  const chatId = message.chat?.id;
  const telegramUserId = message.from?.id;
  if (
    (typeof chatId !== "number" && typeof chatId !== "string") ||
    typeof telegramUserId !== "number" ||
    !Number.isInteger(telegramUserId)
  ) {
    sendJson(response, 400, { error: "Telegram update is missing user or chat data" });
    return;
  }

  if (command.name === "start") {
    const { created } = options.userStore.upsert({
      telegramUserId,
      firstName: message.from?.first_name ?? "there",
      lastName: message.from?.last_name,
      username: message.from?.username,
    });
    await sendTelegramMessage(
      options,
      chatId,
      created
        ? "Welcome to AURA! Your personal research assistant is ready."
        : "Welcome back to AURA! Your personal research assistant is ready.",
    );
  } else if (command.name === "remember") {
    await handleRememberCommand(options, chatId, telegramUserId, command.args);
  } else if (command.name === "memory" || command.name === "memories") {
    await handleMemoryListCommand(options, chatId, telegramUserId);
  } else if (command.name === "edit_memory") {
    await handleMemoryEditCommand(options, chatId, telegramUserId, command.args);
  } else if (command.name === "forget") {
    await handleMemoryDeleteCommand(options, chatId, telegramUserId, command.args);
  } else if (command.name === "forget_all") {
    const deleted = options.memoryStore.deleteAll(telegramUserId);
    await sendTelegramMessage(options, chatId, `Deleted ${deleted} stored memor${deleted === 1 ? "y" : "ies"}.`);
  }

  sendJson(response, 200, { ok: true });
}

async function sendTelegramMessage(
  options: Required<Pick<AppOptions, "logger">> & AppOptions,
  chatId: number | string,
  text: string,
): Promise<void> {
  if (!options.telegramClient) {
    options.logger.warn("Telegram bot token is not configured; update acknowledged without reply");
    return;
  }
  try {
    await options.telegramClient.sendMessage(chatId, text);
  } catch (error) {
    const telegramError =
      error && typeof error === "object"
        ? (error as { statusCode?: unknown; errorCode?: unknown })
        : undefined;
    const details =
      telegramError && ("statusCode" in telegramError || "errorCode" in telegramError)
        ? {
            statusCode:
              typeof telegramError.statusCode === "number" ? telegramError.statusCode : undefined,
            errorCode:
              typeof telegramError.errorCode === "number" ? telegramError.errorCode : undefined,
          }
        : undefined;
    options.logger.error("Telegram API request failed", details);
  }
}

async function handleRememberCommand(
  options: Required<Pick<AppOptions, "memoryStore" | "logger">> & AppOptions,
  chatId: number | string,
  userId: number,
  args: string,
): Promise<void> {
  const match = args.match(/^(profile|project)(?:\s+([\s\S]*))?$/i);
  if (!match?.[1] || !match[2]) {
    await sendTelegramMessage(options, chatId, "Usage: /remember profile <text> or /remember project <name> | <text>");
    return;
  }

  const kind = match[1].toLowerCase() as "profile" | "project";
  let content = match[2].trim();
  let projectName: string | undefined;
  if (kind === "project") {
    const separator = content.indexOf("|");
    if (separator === -1) {
      await sendTelegramMessage(options, chatId, "Usage: /remember project <name> | <text>");
      return;
    }
    projectName = content.slice(0, separator).trim();
    content = content.slice(separator + 1).trim();
  }

  try {
    const memory = options.memoryStore.create({
      userId,
      kind,
      content,
      projectName,
      consent: true,
    });
    await sendTelegramMessage(options, chatId, `Memory saved with id ${memory.id}. You can edit or delete it at any time.`);
  } catch (error) {
    await sendMemoryError(options, chatId, error);
  }
}

async function handleMemoryListCommand(
  options: Required<Pick<AppOptions, "memoryStore" | "logger">> & AppOptions,
  chatId: number | string,
  userId: number,
): Promise<void> {
  const memories = options.memoryStore.list(userId);
  if (memories.length === 0) {
    await sendTelegramMessage(options, chatId, "No stored memories.");
    return;
  }
  const lines = memories.map((memory) => {
    const project = memory.projectName ? `, project: ${memory.projectName}` : "";
    return `- ${memory.id} (${memory.kind}${project}): ${memory.content}`;
  });
  await sendTelegramMessage(options, chatId, `Stored memories:\n${lines.join("\n")}`);
}

async function handleMemoryEditCommand(
  options: Required<Pick<AppOptions, "memoryStore" | "logger">> & AppOptions,
  chatId: number | string,
  userId: number,
  args: string,
): Promise<void> {
  const separator = args.indexOf(" ");
  if (separator === -1) {
    await sendTelegramMessage(options, chatId, "Usage: /edit_memory <id> <new text>");
    return;
  }
  const memoryId = args.slice(0, separator).trim();
  const content = args.slice(separator + 1).trim();
  try {
    const memory = options.memoryStore.update(userId, memoryId, { content, consent: true });
    await sendTelegramMessage(options, chatId, memory ? "Memory updated." : "Memory not found.");
  } catch (error) {
    await sendMemoryError(options, chatId, error);
  }
}

async function handleMemoryDeleteCommand(
  options: Required<Pick<AppOptions, "memoryStore" | "logger">> & AppOptions,
  chatId: number | string,
  userId: number,
  args: string,
): Promise<void> {
  if (!args) {
    await sendTelegramMessage(options, chatId, "Usage: /forget <id>");
    return;
  }
  await sendTelegramMessage(
    options,
    chatId,
    options.memoryStore.delete(userId, args) ? "Memory deleted." : "Memory not found.",
  );
}

async function sendMemoryError(
  options: Required<Pick<AppOptions, "logger">> & AppOptions,
  chatId: number | string,
  error: unknown,
): Promise<void> {
  if (error instanceof MemoryConsentRequiredError) {
    await sendTelegramMessage(options, chatId, "Explicit consent is required before storing memory.");
    return;
  }
  if (error instanceof MemoryValidationError) {
    await sendTelegramMessage(options, chatId, error.message);
    return;
  }
  options.logger.error("Memory request failed");
  await sendTelegramMessage(options, chatId, "Unable to update memory.");
}

export function createApp(options: AppOptions = {}) {
  const resolvedOptions = {
    ...options,
    userStore: options.userStore ?? new InMemoryTelegramUserStore(),
    memoryStore: options.memoryStore ?? new InMemoryMemoryStore(),
    logger: options.logger ?? defaultLogger,
  };

  return createServer((request, response) => {
    const requestUrl = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "localhost"}`,
    );

    if (request.method === "GET" && requestUrl.pathname === "/health") {
      sendJson(response, 200, { status: "ok" });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/webhook/telegram") {
      void handleTelegramWebhook(request, response, resolvedOptions).catch(() => {
        if (!response.headersSent) {
          sendJson(response, 500, { error: "Internal server error" });
        } else {
          response.destroy();
        }
      });
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  });
}

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

function getStartMessage(update: TelegramUpdate): TelegramMessage | undefined {
  const message = update.message;
  if (!message || typeof message.text !== "string") return undefined;
  return /^\/start(?:\s|$)/i.test(message.text) ? message : undefined;
}

function isTelegramUpdate(value: unknown): value is TelegramUpdate {
  return typeof value === "object" && value !== null;
}

async function handleTelegramWebhook(
  request: IncomingMessage,
  response: ServerResponse,
  options: Required<Pick<AppOptions, "userStore" | "logger">> & AppOptions,
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

  const message = getStartMessage(update);
  if (!message) {
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

  const { created } = options.userStore.upsert({
    telegramUserId,
    firstName: message.from?.first_name ?? "there",
    lastName: message.from?.last_name,
    username: message.from?.username,
  });

  if (options.telegramClient) {
    const greeting = created
      ? "Welcome to AURA! Your personal research assistant is ready."
      : "Welcome back to AURA! Your personal research assistant is ready.";
    try {
      await options.telegramClient.sendMessage(chatId, greeting);
    } catch (error) {
      const telegramError =
        error && typeof error === "object"
          ? (error as { statusCode?: unknown; errorCode?: unknown })
          : undefined;
      const details =
        telegramError && ("statusCode" in telegramError || "errorCode" in telegramError)
          ? {
              statusCode:
                typeof telegramError.statusCode === "number"
                  ? telegramError.statusCode
                  : undefined,
              errorCode:
                typeof telegramError.errorCode === "number"
                  ? telegramError.errorCode
                  : undefined,
            }
          : undefined;
      options.logger.error("Telegram API request failed", details);
    }
  } else {
    options.logger.warn("Telegram bot token is not configured; update acknowledged without reply");
  }

  sendJson(response, 200, { ok: true });
}

export function createApp(options: AppOptions = {}) {
  const resolvedOptions = {
    ...options,
    userStore: options.userStore ?? new InMemoryTelegramUserStore(),
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

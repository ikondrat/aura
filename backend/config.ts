export interface AppConfig {
  host: string;
  nodeEnv: string;
  port: number;
  databaseUrl?: string;
  telegramBotToken?: string;
  telegramApiBaseUrl: string;
  telegramWebhookSecret?: string;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number(env.PORT ?? "3000");

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  const telegramApiBaseUrl = env.TELEGRAM_API_BASE_URL ?? "https://api.telegram.org";
  try {
    const parsedTelegramApiBaseUrl = new URL(telegramApiBaseUrl);
    if (!['http:', 'https:'].includes(parsedTelegramApiBaseUrl.protocol)) {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new Error("TELEGRAM_API_BASE_URL must be a valid HTTP(S) URL");
  }

  const telegramWebhookSecret = env.TELEGRAM_WEBHOOK_SECRET?.trim() || undefined;
  if (env.NODE_ENV === "production" && !telegramWebhookSecret) {
    throw new Error("TELEGRAM_WEBHOOK_SECRET is required in production");
  }

  return {
    host: env.HOST ?? "127.0.0.1",
    nodeEnv: env.NODE_ENV ?? "development",
    port,
    databaseUrl: env.DATABASE_URL?.trim() || undefined,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN?.trim() || undefined,
    telegramApiBaseUrl: telegramApiBaseUrl.replace(/\/$/, ""),
    telegramWebhookSecret,
  };
}

export interface TelegramClient {
  sendMessage(chatId: number | string, text: string): Promise<void>;
}

export interface TelegramUserInput {
  telegramUserId: number;
  firstName: string;
  lastName?: string;
  username?: string;
}

export interface TelegramUser {
  telegramUserId: number;
  firstName: string;
  lastName?: string;
  username?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TelegramUserStore {
  upsert(input: TelegramUserInput): { user: TelegramUser; created: boolean };
  get(telegramUserId: number): TelegramUser | undefined;
  delete(telegramUserId: number): boolean;
}

export class InMemoryTelegramUserStore implements TelegramUserStore {
  private readonly users = new Map<number, TelegramUser>();

  upsert(input: TelegramUserInput): { user: TelegramUser; created: boolean } {
    const now = new Date().toISOString();
    const existing = this.users.get(input.telegramUserId);

    if (existing) {
      const user: TelegramUser = {
        ...existing,
        ...input,
        updatedAt: now,
      };
      this.users.set(input.telegramUserId, user);
      return { user, created: false };
    }

    const user: TelegramUser = {
      ...input,
      createdAt: now,
      updatedAt: now,
    };
    this.users.set(input.telegramUserId, user);
    return { user, created: true };
  }

  get(telegramUserId: number): TelegramUser | undefined {
    const user = this.users.get(telegramUserId);
    return user ? { ...user } : undefined;
  }

  delete(telegramUserId: number): boolean {
    return this.users.delete(telegramUserId);
  }

  get size(): number {
    return this.users.size;
  }
}

export class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
    readonly errorCode?: number,
  ) {
    super(message);
    this.name = "TelegramApiError";
  }
}

interface TelegramApiResponse {
  ok?: boolean;
  error_code?: number;
}

export class TelegramBotClient implements TelegramClient {
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly token: string,
    apiBaseUrl = "https://api.telegram.org",
    fetchImpl: typeof fetch = fetch,
  ) {
    this.apiBaseUrl = apiBaseUrl.replace(/\/$/, "");
    this.fetchImpl = fetchImpl;
  }

  async sendMessage(chatId: number | string, text: string): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.apiBaseUrl}/bot${this.token}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text }),
        },
      );
    } catch {
      throw new TelegramApiError("Telegram API network request failed");
    }

    let payload: TelegramApiResponse;
    try {
      payload = (await response.json()) as TelegramApiResponse;
    } catch {
      throw new TelegramApiError(
        "Telegram API returned an invalid response",
        response.status,
      );
    }

    if (!response.ok || payload.ok !== true) {
      throw new TelegramApiError(
        "Telegram API rejected the request",
        response.status,
        payload.error_code,
      );
    }
  }
}

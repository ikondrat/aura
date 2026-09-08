import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "./app.js";
import { readConfig } from "./config.js";
import { InMemoryMemoryStore, MemoryConsentRequiredError } from "./memory.js";
import { InMemoryTelegramUserStore, TelegramBotClient } from "./telegram.js";

test("GET /health returns a successful health response", async () => {
  const server = createApp().listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    assert(address && typeof address !== "string");

    const response = await fetch(`http://127.0.0.1:${address.port}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("unknown routes return not found", async () => {
  const server = createApp().listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    assert(address && typeof address !== "string");

    const response = await fetch(`http://127.0.0.1:${address.port}/missing`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Not found" });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("Telegram /start creates a user and sends a welcome message", async () => {
  const messages: Array<{ chatId: number | string; text: string }> = [];
  const userStore = new InMemoryTelegramUserStore();
  const server = createApp({
    userStore,
    telegramClient: {
      sendMessage: async (chatId, text) => {
        messages.push({ chatId, text });
      },
    },
  }).listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    const update = {
      update_id: 1,
      message: {
        chat: { id: 42 },
        from: { id: 7, first_name: "Ada", username: "ada" },
        text: "/start",
      },
    };

    const response = await fetch(`http://127.0.0.1:${address.port}/webhook/telegram`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(update),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(userStore.size, 1);
    assert.deepEqual(messages, [
      {
        chatId: 42,
        text: "Welcome to AURA! Your personal research assistant is ready.",
      },
    ]);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("Telegram /start finds an existing user and handles API failures safely", async () => {
  const logs: Array<{ message: string; details?: unknown }> = [];
  const userStore = new InMemoryTelegramUserStore();
  const server = createApp({
    userStore,
    telegramClient: {
      sendMessage: async () => {
        throw new Error("bot token must never be logged");
      },
    },
    logger: {
      error: (message, details) => logs.push({ message, details }),
      warn: () => undefined,
    },
  }).listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    const update = {
      update_id: 2,
      message: {
        chat: { id: 42 },
        from: { id: 7, first_name: "Ada" },
        text: "/start referral-code",
      },
    };
    const response = await fetch(`http://127.0.0.1:${address.port}/webhook/telegram`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(update),
    });

    assert.equal(response.status, 200);
    assert.equal(userStore.size, 1);
    assert.equal(logs.length, 1);
    assert.deepEqual(logs[0], { message: "Telegram API request failed", details: undefined });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("Telegram webhook rejects an invalid secret", async () => {
  const server = createApp({ webhookSecret: "known-secret" }).listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/webhook/telegram`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Unauthorized" });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("Telegram API errors do not include the bot token", async () => {
  const token = "123456:super-secret-token";
  const client = new TelegramBotClient(
    token,
    "https://telegram.test",
    async () => new Response(JSON.stringify({ ok: false, error_code: 403 }), { status: 403 }),
  );

  await assert.rejects(
    () => client.sendMessage(42, "Hello"),
    (error: unknown) => {
      assert(error instanceof Error);
      assert.equal(error.message, "Telegram API rejected the request");
      assert.equal(error.message.includes(token), false);
      return true;
    },
  );
});

test("memory storage requires consent and is isolated by user", () => {
  const store = new InMemoryMemoryStore();

  assert.throws(
    () => store.create({ userId: 7, kind: "profile", content: "Private detail", consent: false }),
    MemoryConsentRequiredError,
  );

  const profile = store.create({
    userId: 7,
    kind: "profile",
    content: "Prefers concise answers",
    consent: true,
  });
  const project = store.create({
    userId: 7,
    kind: "project",
    projectName: "AURA",
    content: "Ship the MVP",
    consent: true,
  });

  assert.deepEqual(store.list(7, "profile").map((memory) => memory.content), ["Prefers concise answers"]);
  assert.equal(store.update(8, profile.id, { content: "Should not move tenants", consent: true }), undefined);
  assert.equal(store.delete(8, project.id), false);
  assert.equal(store.update(7, project.id, { content: "Ship the tested MVP", consent: true })?.content, "Ship the tested MVP");
  assert.equal(store.deleteAll(7), 2);
  assert.deepEqual(store.list(7), []);
});

test("Telegram memory commands support consented create, view, edit, and deletion", async () => {
  const messages: string[] = [];
  const memoryStore = new InMemoryMemoryStore();
  const server = createApp({
    memoryStore,
    telegramClient: {
      sendMessage: async (_chatId, text) => {
        messages.push(text);
      },
    },
  }).listen(0, "127.0.0.1");
  await once(server, "listening");

  const sendCommand = async (text: string): Promise<void> => {
    const address = server.address();
    assert(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/webhook/telegram`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        update_id: messages.length + 10,
        message: { chat: { id: 42 }, from: { id: 7, first_name: "Ada" }, text },
      }),
    });
    assert.equal(response.status, 200);
  };

  try {
    await sendCommand("/remember project AURA | Ship the MVP");
    const memory = memoryStore.list(7)[0];
    assert(memory);
    assert.equal(memory.projectName, "AURA");

    await sendCommand("/memory");
    assert.match(messages.at(-1) ?? "", new RegExp(memory.id));
    await sendCommand(`/edit_memory ${memory.id} Ship the tested MVP`);
    assert.equal(memoryStore.list(7)[0]?.content, "Ship the tested MVP");
    await sendCommand(`/forget ${memory.id}`);
    assert.deepEqual(memoryStore.list(7), []);

    await sendCommand("/remember profile Uses English");
    await sendCommand("/remember project Launch | Invite beta users");
    await sendCommand("/forget_all");
    assert.deepEqual(memoryStore.list(7), []);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("webhook rate limiting returns 429 without trusting forwarded headers", async () => {
  const server = createApp({
    rateLimit: { maxRequests: 1, windowMs: 60_000 },
  }).listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    const request = () => fetch(`http://127.0.0.1:${address.port}/webhook/telegram`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.10",
      },
      body: JSON.stringify({ message: { chat: { id: 42 }, from: { id: 7 }, text: "/start" } }),
    });

    assert.equal((await request()).status, 200);
    const limited = await request();
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "60");
    assert.deepEqual(await limited.json(), { error: "Too many requests" });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("export and confirmed account deletion only affect the requesting user", async () => {
  const messages: string[] = [];
  const userStore = new InMemoryTelegramUserStore();
  const memoryStore = new InMemoryMemoryStore();
  const server = createApp({
    userStore,
    memoryStore,
    telegramClient: {
      sendMessage: async (_chatId, text) => {
        messages.push(text);
      },
    },
  }).listen(0, "127.0.0.1");
  await once(server, "listening");

  const sendCommand = async (userId: number, text: string, chatType = "private"): Promise<void> => {
    const address = server.address();
    assert(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/webhook/telegram`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: { chat: { id: userId, type: chatType }, from: { id: userId, first_name: "Ada" }, text },
      }),
    });
    assert.equal(response.status, 200);
  };

  try {
    await sendCommand(7, "/start");
    await sendCommand(7, "/remember profile Uses English");
    await sendCommand(8, "/start");
    await sendCommand(8, "/remember profile Must remain");
    await sendCommand(7, "/export");
    assert.match(messages.at(-1) ?? "", /Uses English/);

    await sendCommand(7, "/delete_account");
    assert.match(messages.at(-1) ?? "", /delete_account confirm/);
    await sendCommand(7, "/delete_account confirm");
    assert.equal(userStore.get(7), undefined);
    assert.deepEqual(memoryStore.list(7), []);
    assert.equal(userStore.get(8)?.firstName, "Ada");
    assert.equal(memoryStore.list(8)[0]?.content, "Must remain");

    await sendCommand(8, "/memory", "group");
    assert.match(messages.at(-1) ?? "", /private chat/);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("production configuration requires a webhook secret", () => {
  assert.throws(
    () => readConfig({ NODE_ENV: "production" }),
    /TELEGRAM_WEBHOOK_SECRET is required in production/,
  );
  assert.equal(
    readConfig({ NODE_ENV: "production", TELEGRAM_WEBHOOK_SECRET: "beta-secret" }).telegramWebhookSecret,
    "beta-secret",
  );
});

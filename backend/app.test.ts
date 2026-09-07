import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "./app.js";
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

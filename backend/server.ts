import "dotenv/config";
import { createApp } from "./app.js";
import { readConfig } from "./config.js";
import { TelegramBotClient } from "./telegram.js";

const config = readConfig();
const server = createApp({
  telegramClient: config.telegramBotToken
    ? new TelegramBotClient(config.telegramBotToken, config.telegramApiBaseUrl)
    : undefined,
  webhookSecret: config.telegramWebhookSecret,
});

server.listen(config.port, config.host, () => {
  console.log(`AURA backend listening on http://${config.host}:${config.port}`);
});

function shutdown(signal: string): void {
  console.log(`Received ${signal}; shutting down`);
  server.close((error) => {
    if (error) {
      console.error("Failed to close the server cleanly", error);
      process.exitCode = 1;
    }
  });
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

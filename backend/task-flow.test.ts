import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryTaskAgentStore,
  InMemoryTaskConversationStore,
  InMemoryTaskUserStore,
  TelegramTaskFlow,
  formatResearchResult,
  type ActiveTaskAgent,
} from "./task-flow.js";

const agent: ActiveTaskAgent = {
  id: "agent-1",
  userId: "user-1",
  name: "Research helper",
  goal: "Summarize reliable sources",
  language: "English",
  workingStyle: "Concise",
};

function createFlow(options: {
  orchestrate?: (request: { request: string; historyLength: number }) => Promise<string>;
  reply?: (text: string) => Promise<boolean>;
} = {}) {
  const users = new InMemoryTaskUserStore();
  users.set({ id: "user-1", telegramUserId: 7 });
  const agents = new InMemoryTaskAgentStore();
  agents.set(agent);
  const conversations = new InMemoryTaskConversationStore();
  let calls = 0;
  const replies: string[] = [];
  const flow = new TelegramTaskFlow({
    users,
    agents,
    conversations,
    orchestrator: {
      run: async (input) => {
        calls += 1;
        const answer = await options.orchestrate?.({
          request: input.request,
          historyLength: input.history.length,
        });
        return {
          outcome: "final",
          answer: answer ?? `Answer: ${input.request}`,
          assumptions: [],
          limitation: null,
        };
      },
    },
    reply: async (_chatId, text) => {
      replies.push(text);
      return options.reply ? options.reply(text) : true;
    },
  });
  return { flow, conversations, replies, get calls() { return calls; } };
}

test("routes a private task, persists both turns, and resumes the same conversation", async () => {
  const fixture = createFlow();

  await fixture.flow.handle({
    telegramUserId: 7,
    chatId: 42,
    text: "Compare these two approaches",
    updateId: 100,
  });
  await fixture.flow.handle({
    telegramUserId: 7,
    chatId: 42,
    text: "Now recommend one",
    updateId: 101,
  });

  const conversations = fixture.conversations.listMessages("user-1", "missing");
  assert.deepEqual(conversations, []);
  assert.equal(fixture.calls, 2);
  assert.deepEqual(fixture.replies, [
    "Answer: Compare these two approaches",
    "Answer: Now recommend one",
  ]);
});

test("duplicate and concurrent Telegram deliveries invoke orchestration once", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const fixture = createFlow({
    orchestrate: async () => {
      await blocked;
      return "One answer";
    },
  });

  const first = fixture.flow.handle({
    telegramUserId: 7,
    chatId: 42,
    text: "Same request",
    updateId: 200,
  });
  const second = fixture.flow.handle({
    telegramUserId: 7,
    chatId: 42,
    text: "Same request",
    updateId: 200,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.calls, 1);
  release();
  await Promise.all([first, second]);

  assert.equal(fixture.calls, 1);
  assert.deepEqual(fixture.replies, ["One answer"]);
});

test("missing users and inactive agents receive setup guidance without persistence", async () => {
  const fixture = createFlow();
  await fixture.flow.handle({
    telegramUserId: 999,
    chatId: 42,
    text: "Hello",
    updateId: 300,
  });
  assert.deepEqual(fixture.replies, ["Please send /start before sending a task."]);
  assert.equal(fixture.calls, 0);

  const noAgent = createFlow();
  noAgent.flow = new TelegramTaskFlow({
    users: new InMemoryTaskUserStore(),
    agents: new InMemoryTaskAgentStore(),
    conversations: noAgent.conversations,
    orchestrator: { run: async () => ({ outcome: "final", answer: "unexpected", assumptions: [], limitation: null }) },
    reply: async (_chatId, text) => {
      noAgent.replies.push(text);
      return true;
    },
  });
  const users = new InMemoryTaskUserStore();
  users.set({ id: "user-1", telegramUserId: 7 });
  noAgent.flow = new TelegramTaskFlow({
    users,
    agents: new InMemoryTaskAgentStore(),
    conversations: noAgent.conversations,
    orchestrator: { run: async () => ({ outcome: "final", answer: "unexpected", assumptions: [], limitation: null }) },
    reply: async (_chatId, text) => {
      noAgent.replies.push(text);
      return true;
    },
  });
  await noAgent.flow.handle({ telegramUserId: 7, chatId: 42, text: "Hello", updateId: 301 });
  assert.equal(noAgent.replies.at(-1), "Your research agent is not active yet. Send /setup to create one.");
  assert.equal(noAgent.calls, 0);
});

test("empty tasks are rejected before owner or model access", async () => {
  let ownerLookups = 0;
  const fixture = createFlow();
  const flow = new TelegramTaskFlow({
    users: {
      findByTelegramUserId: () => {
        ownerLookups += 1;
        return undefined;
      },
    },
    agents: new InMemoryTaskAgentStore(),
    conversations: fixture.conversations,
    orchestrator: { run: async () => ({ outcome: "final", answer: "unexpected", assumptions: [], limitation: null }) },
    reply: async (_chatId, text) => {
      fixture.replies.push(text);
      return true;
    },
  });

  await flow.handle({ telegramUserId: 7, chatId: 42, text: "  ", updateId: 350 });
  assert.deepEqual(fixture.replies, ["Please send a non-empty task."]);
  assert.equal(ownerLookups, 0);
});

test("a failed Telegram delivery is retryable without calling the model again", async () => {
  let attempts = 0;
  const fixture = createFlow({
    reply: async () => {
      attempts += 1;
      return attempts > 1;
    },
  });

  await fixture.flow.handle({ telegramUserId: 7, chatId: 42, text: "Retry me", updateId: 400 });
  await fixture.flow.handle({ telegramUserId: 7, chatId: 42, text: "Retry me", updateId: 400 });
  assert.equal(attempts, 2);
  assert.equal(fixture.calls, 1);
});

test("renders validated citations as a bounded plain-text source list", () => {
  const rendered = formatResearchResult({
    outcome: "final",
    answer: "The answer.",
    assumptions: [],
    limitation: null,
    citations: [{
      id: "source_1",
      title: "A\nsource",
      domain: "example.com",
      url: "https://example.com/article",
    }],
  });

  assert.equal(rendered, "The answer.\n\nSources:\n[1] A source (example.com)\nhttps://example.com/article");
});

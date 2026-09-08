import assert from "node:assert/strict";
import test from "node:test";
import {
  ModelGatewayRefusalError,
  ModelGatewayUnavailableError,
  ResearchAgentInputError,
  ResearchAgentService,
  type ModelGateway,
  type ModelGatewayRequest,
  type ResearchAgentFailureReason,
  type ResearchAgentInput,
} from "./research-agent.js";

function input(overrides: Partial<ResearchAgentInput> = {}): ResearchAgentInput {
  const base: ResearchAgentInput = {
    agent: {
      name: "Research helper",
      goal: "Summarize product research",
      language: "English",
      workingStyle: "Concise and explicit about uncertainty",
    },
    history: [
      { id: "b", role: "assistant", content: "Earlier answer", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "a", role: "user", content: "Earlier request", createdAt: "2026-01-01T00:00:00.000Z" },
    ],
    request: "Compare the two approaches.",
  };
  return { ...base, ...overrides };
}

test("builds a bounded, deterministic gateway request and returns a structured final answer", async () => {
  let captured: ModelGatewayRequest | undefined;
  const service = new ResearchAgentService({
    complete: async (request) => {
      captured = request;
      return {
        outcome: "final",
        answer: "The first approach is simpler.",
        assumptions: ["The comparison uses the supplied requirements."],
        limitation: null,
      };
    },
  });

  const result = await service.run(input());

  assert.deepEqual(result, {
    outcome: "final",
    answer: "The first approach is simpler.",
    assumptions: ["The comparison uses the supplied requirements."],
    limitation: null,
  });
  assert(captured);
  assert.match(captured.systemPrompt, /English/);
  assert.match(captured.systemPrompt, /Concise and explicit about uncertainty/);
  assert.match(captured.systemPrompt, /web research, source retrieval, citations/);
  assert.deepEqual(captured.messages.map(({ role, content }) => ({ role, content })), [
    { role: "user", content: "<user_message>\nEarlier request\n</user_message>" },
    { role: "assistant", content: "<assistant_message>\nEarlier answer\n</assistant_message>" },
    { role: "user", content: "<new_user_request>\nCompare the two approaches.\n</new_user_request>" },
  ]);
});

test("returns one typed clarification without retrying or parsing Telegram text", async () => {
  let calls = 0;
  const service = new ResearchAgentService({
    complete: async () => {
      calls += 1;
      return { outcome: "clarification", question: "Which audience should this target?" };
    },
  });

  assert.deepEqual(await service.run(input()), {
    outcome: "clarification",
    question: "Which audience should this target?",
  });
  assert.equal(calls, 1);
});

test("keeps only the newest history within the context policy", async () => {
  let captured: ModelGatewayRequest | undefined;
  const service = new ResearchAgentService({
    complete: async (request) => {
      captured = request;
      return { outcome: "final", answer: "Done", assumptions: [], limitation: null };
    },
  });
  const history = Array.from({ length: 50 }, (_, index) => ({
    id: String(index).padStart(3, "0"),
    role: "user" as const,
    content: `message-${index}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)),
  }));

  await service.run(input({ history }));

  assert(captured);
  assert(captured.messages.length <= 41);
  assert.match(captured.messages.at(-2)?.content ?? "", /message-49/);
  assert.doesNotMatch(captured.messages[0]?.content ?? "", /message-0\n/);
});

test("rejects invalid input before calling the gateway", async () => {
  let calls = 0;
  const service = new ResearchAgentService({
    complete: async () => {
      calls += 1;
      return { outcome: "final", answer: "unexpected", assumptions: [], limitation: null };
    },
  });

  await assert.rejects(
    () => service.run(input({ request: "   " })),
    ResearchAgentInputError,
  );
  assert.equal(calls, 0);
});

test("maps malformed, refusal, unavailable, timeout, and cancellation to safe final results", async () => {
  const logs: ResearchAgentFailureReason[] = [];
  const logger = { warn: (_message: string, details?: { reason: ResearchAgentFailureReason }) => {
    if (details) logs.push(details.reason);
  }};

  const responses: Array<{ gateway: ModelGateway; reason: ResearchAgentFailureReason }> = [
    {
      gateway: { complete: async () => ({ outcome: "final", answer: "", assumptions: [], limitation: null }) },
      reason: "malformed_output",
    },
    {
      gateway: { complete: async () => ({ outcome: "refusal" }) },
      reason: "provider_refusal",
    },
    {
      gateway: { complete: async () => { throw new ModelGatewayUnavailableError(); } },
      reason: "provider_unavailable",
    },
    {
      gateway: { complete: async () => new Promise(() => undefined) },
      reason: "provider_timeout",
    },
  ];

  for (const { gateway, reason } of responses) {
    const service = new ResearchAgentService(gateway, { timeoutMs: 5, logger });
    const result = await service.run(input());
    assert.equal(result.outcome, "final");
    assert.notEqual(result.answer, "");
    assert.deepEqual(result.assumptions, []);
    assert.ok(result.limitation);
    assert.equal(logs.at(-1), reason);
  }

  const controller = new AbortController();
  controller.abort();
  const cancelled = await new ResearchAgentService({
    complete: async () => { throw new Error("must not be called"); },
  }, { logger }).run(input({ signal: controller.signal }));
  assert.equal(cancelled.outcome, "final");
  assert.deepEqual(logs, [
    "malformed_output",
    "provider_refusal",
    "provider_unavailable",
    "provider_timeout",
    "cancelled",
  ]);
});

test("does not log provider errors or private request content", async () => {
  const entries: Array<{ message: string; reason?: ResearchAgentFailureReason }> = [];
  const service = new ResearchAgentService({
    complete: async () => { throw new Error("secret-provider-payload and private request"); },
  }, {
    logger: {
      warn: (message, details) => entries.push({ message, reason: details?.reason }),
    },
  });

  await service.run(input({ request: "private request that must not be logged" }));

  assert.deepEqual(entries, [{ message: "Research agent provider failure", reason: "provider_error" }]);
  assert.equal(JSON.stringify(entries).includes("secret-provider-payload"), false);
  assert.equal(JSON.stringify(entries).includes("private request"), false);
});

test("recognizes an explicit gateway refusal error", async () => {
  const result = await new ResearchAgentService({
    complete: async () => { throw new ModelGatewayRefusalError(); },
  }).run(input());

  assert.equal(result.outcome, "final");
  assert.match(result.answer, /can't safely complete/);
});

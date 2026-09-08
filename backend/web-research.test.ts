import assert from "node:assert/strict";
import test from "node:test";
import {
  WEB_RESEARCH_POLICY,
  WebResearchCancelledError,
  WebResearchInputError,
  WebResearchProviderUnavailableError,
  WebResearchService,
  type WebResearchProvider,
  type WebResearchRequest,
} from "./web-research.js";

function request(overrides: Partial<WebResearchRequest> = {}): WebResearchRequest {
  return { query: "compare privacy-preserving analytics", ...overrides };
}

function provider(response: unknown): WebResearchProvider {
  return { search: async () => response };
}

test("normalizes, de-duplicates, bounds, and deterministically orders evidence", async () => {
  const result = await new WebResearchService(provider({ results: [
    {
      url: "HTTPS://Example.com/article#section?utm_source=ignored",
      title: "Zeta",
      snippet: "second",
      sourceName: "Example",
    },
    {
      url: "https://example.com/article?utm_medium=ignored",
      title: "Alpha duplicate metadata",
      snippet: "duplicate",
      sourceName: "Example",
    },
    {
      url: "https://other.example/path?b=2&a=1&gclid=ignored",
      title: "Alpha",
      snippet: "first",
      sourceName: "Other",
      publishedAt: "2026-01-02T03:04:05+01:00",
    },
    { url: "javascript:alert(1)", title: "unsafe", snippet: "omit" },
  ] })).search(request({ resultCount: 10 }));

  assert.equal(result.outcome, "partial");
  if (result.outcome !== "partial") return;
  assert.equal(result.sources.length, 2);
  assert.deepEqual(result.sources.map((source) => source.title), ["Alpha", "Zeta"]);
  assert.equal(result.sources[0]?.url, "https://other.example/path?a=1&b=2");
  assert.equal(result.sources[0]?.domain, "other.example");
  assert.equal(result.sources[0]?.publishedAt, "2026-01-02T02:04:05.000Z");
  assert.equal(result.sources[0]?.id, "source_d4b0d7bfdb8f80d47179");
  assert.equal(result.omittedCount, 1);
  assert.match(result.context, /Snippet: first/);
});

test("returns explicit empty and malformed outcomes", async () => {
  assert.deepEqual(await new WebResearchService(provider({ results: [] })).search(request()), {
    outcome: "empty", sources: [], context: "",
  });
  assert.deepEqual(await new WebResearchService(provider({ results: [{ url: "not a URL" }] })).search(request()), {
    outcome: "malformed_provider_data", sources: [], context: "",
  });
  assert.deepEqual(await new WebResearchService(provider({ nope: [] })).search(request()), {
    outcome: "malformed_provider_data", sources: [], context: "",
  });
});

test("marks provider-declared partial results and keeps evidence separate from answers", async () => {
  const result = await new WebResearchService(provider({
    complete: false,
    results: [{ url: "https://example.com", title: "Example", snippet: "Evidence" }],
  })).search(request());
  assert.equal(result.outcome, "partial");
  if (result.outcome !== "partial") return;
  assert.equal(result.reason, "provider_marked_partial");
  assert.equal("answer" in result, false);
  assert.equal("assumptions" in result, false);
  assert.match(result.context, /Snippet: Evidence/);
});

test("rejects invalid requests before invoking the provider", async () => {
  let calls = 0;
  const service = new WebResearchService({ search: async () => { calls += 1; return { results: [] }; } });
  await assert.rejects(() => service.search(request({ query: "   " })), WebResearchInputError);
  await assert.rejects(() => service.search(request({ resultCount: 0 })), WebResearchInputError);
  await assert.rejects(() => service.search(request({ timeoutMs: WEB_RESEARCH_POLICY.maxTimeoutMs + 1 })), WebResearchInputError);
  assert.equal(calls, 0);
});

test("does not call a provider when already cancelled and maps cancellation", async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  const service = new WebResearchService({ search: async () => { calls += 1; return { results: [] }; } });
  assert.deepEqual(await service.search(request({ signal: controller.signal })), {
    outcome: "cancelled", sources: [], context: "",
  });
  assert.equal(calls, 0);

  const running = new AbortController();
  const pending = new WebResearchService({
    search: async ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new WebResearchCancelledError()), { once: true });
      void resolve;
    }),
  }).search(request({ signal: running.signal, timeoutMs: 1_000 }));
  running.abort();
  assert.deepEqual(await pending, { outcome: "cancelled", sources: [], context: "" });
});

test("returns timeout and provider-unavailable outcomes without raw errors", async () => {
  const timeout = await new WebResearchService({ search: async () => new Promise(() => undefined) })
    .search(request({ timeoutMs: 5 }));
  assert.deepEqual(timeout, { outcome: "timeout", sources: [], context: "" });

  const unavailable = await new WebResearchService({
    search: async () => { throw new WebResearchProviderUnavailableError(); },
  }).search(request());
  assert.deepEqual(unavailable, { outcome: "provider_unavailable", sources: [], context: "" });
});

test("caps source count and evidence context", async () => {
  const result = await new WebResearchService(provider({
    results: Array.from({ length: 25 }, (_, index) => ({
      url: `https://example.com/${index}`,
      title: `Title ${index}`,
      snippet: "x".repeat(500),
      sourceName: "Example",
    })),
  })).search(request({ resultCount: 20 }));
  assert.equal(result.outcome, "partial");
  if (result.outcome !== "partial") return;
  assert.ok(result.sources.length <= WEB_RESEARCH_POLICY.maxSourceCount);
  assert.ok(result.context.length <= WEB_RESEARCH_POLICY.maxEvidenceContextLength);
  assert.ok(result.omittedCount > 0);
});

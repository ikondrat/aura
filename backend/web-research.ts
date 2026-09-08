import { createHash } from "node:crypto";

/** Limits shared by providers and consumers of the normalized web-research contract. */
export const WEB_RESEARCH_POLICY = {
  maxQueryLength: 2_000,
  maxLocaleLength: 64,
  defaultResultCount: 10,
  maxResultCount: 20,
  defaultTimeoutMs: 10_000,
  maxTimeoutMs: 60_000,
  maxUrlLength: 2_048,
  maxTitleLength: 500,
  maxSnippetLength: 2_000,
  maxSourceNameLength: 255,
  maxSourceCount: 20,
  maxEvidenceContextLength: 12_000,
} as const;

export interface WebResearchRequest {
  query: string;
  locale?: string;
  safeSearch?: boolean;
  resultCount?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface NormalizedWebResearchRequest {
  query: string;
  locale?: string;
  safeSearch: boolean;
  resultCount: number;
  timeoutMs: number;
  signal: AbortSignal;
}

/**
 * The provider boundary deliberately returns unknown data. A vendor adapter or
 * fake must map its response to this runtime shape; callers never receive raw
 * provider payloads.
 */
export interface WebResearchProvider {
  search(request: NormalizedWebResearchRequest): Promise<unknown>;
}

export interface WebResearchSource {
  /** Stable for the canonical URL, including across repeated provider calls. */
  id: string;
  url: string;
  title: string;
  snippet: string;
  sourceName: string;
  domain: string;
  publishedAt?: string;
}

export interface WebResearchEvidence {
  /** Retrieved source material only; this is not an answer or an assumption. */
  sources: readonly WebResearchSource[];
  /** Bounded citation context for a downstream model, never provider JSON. */
  context: string;
}

export type WebResearchPartialReason =
  | "provider_marked_partial"
  | "invalid_results_omitted"
  | "result_limit_applied"
  | "context_limit_applied";

export interface WebResearchResults extends WebResearchEvidence {
  outcome: "results";
}

export interface WebResearchEmptyResult extends WebResearchEvidence {
  outcome: "empty";
}

export interface WebResearchPartialResult extends WebResearchEvidence {
  outcome: "partial";
  omittedCount: number;
  reason: WebResearchPartialReason;
}

export type WebResearchFailureOutcome =
  | "cancelled"
  | "timeout"
  | "provider_unavailable"
  | "malformed_provider_data"
  | "provider_error";

export interface WebResearchFailureResult {
  outcome: WebResearchFailureOutcome;
  sources: readonly [];
  context: "";
}

export type WebResearchResult =
  | WebResearchResults
  | WebResearchEmptyResult
  | WebResearchPartialResult
  | WebResearchFailureResult;

export class WebResearchInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebResearchInputError";
  }
}

export class WebResearchProviderUnavailableError extends Error {
  constructor() {
    super("web research provider unavailable");
    this.name = "WebResearchProviderUnavailableError";
  }
}

export class WebResearchMalformedResultError extends Error {
  constructor() {
    super("web research provider returned malformed data");
    this.name = "WebResearchMalformedResultError";
  }
}

export class WebResearchTimeoutError extends Error {
  constructor() {
    super("web research provider timed out");
    this.name = "WebResearchTimeoutError";
  }
}

export class WebResearchCancelledError extends Error {
  constructor() {
    super("web research request cancelled");
    this.name = "WebResearchCancelledError";
  }
}

export interface WebResearchLogger {
  warn(message: string, details?: { outcome: WebResearchFailureOutcome }): void;
}

export interface WebResearchServiceOptions {
  logger?: WebResearchLogger;
}

const defaultLogger: WebResearchLogger = { warn: () => undefined };

type RawWebResearchResponse = {
  results: readonly unknown[];
  complete: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, field: string, maxLength: number, required = true): string {
  if (value === undefined && !required) return "";
  if (typeof value !== "string") throw new WebResearchInputError(`${field} must be text`);
  const text = value.trim();
  if (required && !text) throw new WebResearchInputError(`${field} must not be empty`);
  if (text.length > maxLength) throw new WebResearchInputError(`${field} is too long`);
  return text;
}

function boundedInteger(
  value: unknown,
  field: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const candidate = value === undefined ? defaultValue : value;
  if (
    typeof candidate !== "number"
    || !Number.isSafeInteger(candidate)
    || candidate < minimum
    || candidate > maximum
  ) {
    throw new WebResearchInputError(`${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return candidate;
}

function validateRequest(request: WebResearchRequest, signal: AbortSignal): NormalizedWebResearchRequest {
  if (!isRecord(request)) throw new WebResearchInputError("research request is required");
  const query = boundedText(request.query, "query", WEB_RESEARCH_POLICY.maxQueryLength);
  const locale = request.locale === undefined
    ? undefined
    : boundedText(request.locale, "locale", WEB_RESEARCH_POLICY.maxLocaleLength);
  if (request.safeSearch !== undefined && typeof request.safeSearch !== "boolean") {
    throw new WebResearchInputError("safeSearch must be a boolean");
  }

  return {
    query,
    ...(locale === undefined ? {} : { locale }),
    safeSearch: request.safeSearch ?? true,
    resultCount: boundedInteger(
      request.resultCount,
      "resultCount",
      WEB_RESEARCH_POLICY.defaultResultCount,
      1,
      WEB_RESEARCH_POLICY.maxResultCount,
    ),
    timeoutMs: boundedInteger(
      request.timeoutMs,
      "timeoutMs",
      WEB_RESEARCH_POLICY.defaultTimeoutMs,
      1,
      WEB_RESEARCH_POLICY.maxTimeoutMs,
    ),
    signal,
  };
}

function canonicalUrl(value: unknown): { url: string; domain: string } | undefined {
  if (typeof value !== "string" || value.length > WEB_RESEARCH_POLICY.maxUrlLength) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  if (parsed.username || parsed.password || !parsed.hostname) return undefined;

  parsed.hash = "";
  const trackingParameters = /^(utm_[^=]+|fbclid|gclid|mc_cid|mc_eid)$/i;
  const entries = [...parsed.searchParams.entries()]
    .filter(([key]) => !trackingParameters.test(key))
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue),
    );
  parsed.search = "";
  for (const [key, parameterValue] of entries) parsed.searchParams.append(key, parameterValue);
  return { url: parsed.toString(), domain: parsed.hostname.toLowerCase() };
}

function sourceId(url: string): string {
  return `source_${createHash("sha256").update(url).digest("hex").slice(0, 20)}`;
}

function publishedAt(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

function normalizeSource(value: unknown): WebResearchSource | undefined {
  if (!isRecord(value)) return undefined;
  try {
    const canonical = canonicalUrl(value.url);
    if (!canonical) return undefined;
    const title = boundedText(value.title, "source.title", WEB_RESEARCH_POLICY.maxTitleLength, false);
    const snippet = boundedText(
      value.snippet,
      "source.snippet",
      WEB_RESEARCH_POLICY.maxSnippetLength,
      false,
    );
    const sourceName = boundedText(
      value.sourceName ?? value.source_name ?? canonical.domain,
      "source.sourceName",
      WEB_RESEARCH_POLICY.maxSourceNameLength,
    );
    const publication = publishedAt(value.publishedAt ?? value.published_at);
    return {
      id: sourceId(canonical.url),
      url: canonical.url,
      title: title || canonical.domain,
      snippet,
      sourceName,
      domain: canonical.domain,
      ...(publication === undefined ? {} : { publishedAt: publication }),
    };
  } catch (error) {
    if (error instanceof WebResearchInputError) return undefined;
    throw error;
  }
}

function parseResponse(value: unknown): RawWebResearchResponse {
  if (Array.isArray(value)) return { results: value, complete: true };
  if (!isRecord(value) || !Array.isArray(value.results)) throw new WebResearchMalformedResultError();
  if (value.complete !== undefined && typeof value.complete !== "boolean") {
    throw new WebResearchMalformedResultError();
  }
  return { results: value.results, complete: value.complete ?? true };
}

function evidenceContext(sources: readonly WebResearchSource[]): {
  sources: readonly WebResearchSource[];
  context: string;
  truncated: boolean;
} {
  const selected: WebResearchSource[] = [];
  let context = "";
  for (const source of sources) {
    const entry = [
      `[${source.id}]`,
      `Title: ${source.title}`,
      `Source: ${source.sourceName} (${source.domain})`,
      `URL: ${source.url}`,
      source.publishedAt ? `Published: ${source.publishedAt}` : undefined,
      `Snippet: ${source.snippet || "(no snippet provided)"}`,
    ].filter((line): line is string => line !== undefined).join("\n");
    const separator = context ? "\n\n" : "";
    if ((context + separator + entry).length > WEB_RESEARCH_POLICY.maxEvidenceContextLength) {
      return { sources: selected, context, truncated: true };
    }
    selected.push(source);
    context += separator + entry;
  }
  return { sources: selected, context, truncated: false };
}

function normalizeResponse(value: unknown, requestedCount: number): WebResearchResult {
  const response = parseResponse(value);
  const unique = new Map<string, WebResearchSource>();
  let invalidCount = 0;
  for (const raw of response.results) {
    const normalized = normalizeSource(raw);
    if (!normalized) {
      invalidCount += 1;
      continue;
    }
    if (!unique.has(normalized.url)) unique.set(normalized.url, normalized);
  }

  const ordered = [...unique.values()].sort((left, right) =>
    left.title.localeCompare(right.title) || left.url.localeCompare(right.url),
  );
  const bounded = ordered.slice(0, Math.min(requestedCount, WEB_RESEARCH_POLICY.maxSourceCount));
  const context = evidenceContext(bounded);
  const omittedCount = invalidCount + Math.max(0, ordered.length - bounded.length);

  if (bounded.length === 0) {
    if (response.results.length > 0 && invalidCount === response.results.length) {
      return { outcome: "malformed_provider_data", sources: [], context: "" };
    }
    return { outcome: "empty", sources: [], context: "" };
  }
  if (!response.complete || invalidCount > 0 || omittedCount > 0 || context.truncated) {
    const reason: WebResearchPartialReason = !response.complete
      ? "provider_marked_partial"
      : context.truncated
        ? "context_limit_applied"
        : invalidCount > 0
          ? "invalid_results_omitted"
          : "result_limit_applied";
    return {
      outcome: "partial",
      sources: context.sources,
      context: context.context,
      omittedCount: Math.max(1, omittedCount + (context.truncated ? bounded.length - context.sources.length : 0)),
      reason,
    };
  }
  return { outcome: "results", sources: context.sources, context: context.context };
}

function failure(outcome: WebResearchFailureOutcome): WebResearchFailureResult {
  return { outcome, sources: [], context: "" };
}

function failureOutcome(error: unknown): WebResearchFailureOutcome {
  if (error instanceof WebResearchCancelledError) return "cancelled";
  if (error instanceof WebResearchTimeoutError) return "timeout";
  if (error instanceof WebResearchProviderUnavailableError) return "provider_unavailable";
  if (error instanceof WebResearchMalformedResultError) return "malformed_provider_data";
  return "provider_error";
}

interface AbortOutcome {
  kind: "cancelled" | "timeout";
}

function isAbortOutcome(value: unknown): value is AbortOutcome {
  return isRecord(value) && (value.kind === "cancelled" || value.kind === "timeout");
}

export class WebResearchService {
  private readonly logger: WebResearchLogger;

  constructor(
    private readonly provider: WebResearchProvider,
    options: WebResearchServiceOptions = {},
  ) {
    this.logger = options.logger ?? defaultLogger;
  }

  async search(request: WebResearchRequest): Promise<WebResearchResult> {
    const callerSignal = request?.signal;
    if (callerSignal?.aborted) return failure("cancelled");

    const controller = new AbortController();
    const normalized = validateRequest(request, controller.signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let removeCallerListener: () => void = () => {};
    let resolveAbort: ((outcome: AbortOutcome) => void) | undefined;
    const abort = new Promise<AbortOutcome>((resolve) => { resolveAbort = resolve; });

    const cancel = () => {
      controller.abort();
      resolveAbort?.({ kind: "cancelled" });
    };
    if (callerSignal) {
      callerSignal.addEventListener("abort", cancel, { once: true });
      removeCallerListener = () => callerSignal.removeEventListener("abort", cancel);
    }
    timer = setTimeout(() => {
      controller.abort();
      resolveAbort?.({ kind: "timeout" });
    }, normalized.timeoutMs);

    const providerPromise = Promise.resolve().then(() => this.provider.search(normalized));
    try {
      const value = await Promise.race([providerPromise, abort]);
      if (isAbortOutcome(value)) return failure(value.kind);
      try {
        return normalizeResponse(value, normalized.resultCount);
      } catch (error) {
        const outcome = failureOutcome(error);
        this.logger.warn("Web research provider failure", { outcome });
        return failure(outcome);
      }
    } catch (error) {
      const outcome = failureOutcome(error);
      this.logger.warn("Web research provider failure", { outcome });
      return failure(outcome);
    } finally {
      if (timer) clearTimeout(timer);
      removeCallerListener();
    }
  }
}

import type {
  ModelGateway,
  ModelGatewayRequest,
  ModelGatewayOptions,
} from "./research-agent.js";

export type ModelTier = "low_cost" | "complex";
export type ModelComplexity = "ordinary" | "complex";
export type ModelCapability = "text" | "web_research" | "structured_output";

export const MODEL_CAPABILITIES = ["text", "web_research", "structured_output"] as const;
export const MODEL_TIERS = ["low_cost", "complex"] as const;

export interface ModelBudgetSnapshot {
  /** Authoritative preflight result from the admission/limits layer. */
  requestsRemaining: bigint;
  tokensRemaining: bigint;
  costMicroUsdRemaining: bigint;
}

export interface ModelRoutingInput {
  /** This signal must come from trusted application policy, not from task text. */
  complexity: ModelComplexity;
  capabilities: readonly ModelCapability[];
  budget: ModelBudgetSnapshot;
  signal?: AbortSignal;
  /** Absolute epoch time in milliseconds. */
  deadlineAt?: number;
}

export interface ModelTierDefinition {
  tier: ModelTier;
  /** Logical provider slot only; this does not select or contact a vendor. */
  provider: string;
  /** Logical model slot only; this does not imply a production model is approved. */
  model: string;
  enabled: boolean;
  capabilities: readonly ModelCapability[];
  timeoutMs: number;
}

export interface ModelRoutingConfiguration {
  lowCost: ModelTierDefinition;
  complex?: ModelTierDefinition;
  /** Explicit, ordered fallback tiers. Each list is bounded during validation. */
  fallbacks?: Partial<Record<ModelTier, readonly ModelTier[]>>;
}

export type ModelRoutingDecision =
  | {
      outcome: "route";
      tier: ModelTier;
      provider: string;
      model: string;
      timeoutMs: number;
      reason:
        | "ordinary_default"
        | "complex_requested"
        | "complex_tier_unavailable_fallback"
        | "configured_fallback";
      /** Ordered alternatives. Admission must be repeated before each attempt. */
      fallbacks: readonly ModelRoute[];
    }
  | {
      outcome: "denied";
      reason:
        | "cancelled"
        | "deadline_exceeded"
        | "budget_exhausted"
        | "tier_unavailable"
        | "unsupported_capability";
    };

export interface ModelRoute {
  tier: ModelTier;
  provider: string;
  model: string;
  timeoutMs: number;
}

export class ModelRoutingConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelRoutingConfigurationError";
  }
}

export class ModelRoutingDeniedError extends Error {
  readonly reason: Extract<ModelRoutingDecision, { outcome: "denied" }>['reason'];

  constructor(reason: Extract<ModelRoutingDecision, { outcome: "denied" }>['reason']) {
    super(`model routing denied: ${reason}`);
    this.name = "ModelRoutingDeniedError";
    this.reason = reason;
  }
}

const MAX_FALLBACKS = 2;
const MAX_TIMEOUT_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTier(value: unknown): value is ModelTier {
  return value === "low_cost" || value === "complex";
}

function isCapability(value: unknown): value is ModelCapability {
  return typeof value === "string" && (MODEL_CAPABILITIES as readonly string[]).includes(value);
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ModelRoutingConfigurationError(`${field} must not be empty`);
  }
  return value.trim();
}

function normalizeTierDefinition(value: unknown, expectedTier: ModelTier, field: string): ModelTierDefinition {
  if (!isRecord(value)) throw new ModelRoutingConfigurationError(`${field} is required`);
  if (value.tier !== expectedTier) {
    throw new ModelRoutingConfigurationError(`${field}.tier must be ${expectedTier}`);
  }
  if (typeof value.enabled !== "boolean") {
    throw new ModelRoutingConfigurationError(`${field}.enabled must be boolean`);
  }
  if (!Array.isArray(value.capabilities) || value.capabilities.length === 0) {
    throw new ModelRoutingConfigurationError(`${field}.capabilities must not be empty`);
  }
  const capabilities = value.capabilities.map((capability, index) => {
    if (!isCapability(capability)) {
      throw new ModelRoutingConfigurationError(`${field}.capabilities[${index}] is unsupported`);
    }
    return capability;
  });
  if (new Set(capabilities).size !== capabilities.length) {
    throw new ModelRoutingConfigurationError(`${field}.capabilities must not contain duplicates`);
  }
  if (typeof value.timeoutMs !== "number"
    || !Number.isSafeInteger(value.timeoutMs)
    || value.timeoutMs < 1
    || value.timeoutMs > MAX_TIMEOUT_MS) {
    throw new ModelRoutingConfigurationError(`${field}.timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}`);
  }
  return {
    tier: expectedTier,
    provider: nonEmpty(value.provider, `${field}.provider`),
    model: nonEmpty(value.model, `${field}.model`),
    enabled: value.enabled,
    capabilities,
    timeoutMs: value.timeoutMs,
  };
}

function routeFromDefinition(definition: ModelTierDefinition): ModelRoute {
  return {
    tier: definition.tier,
    provider: definition.provider,
    model: definition.model,
    timeoutMs: definition.timeoutMs,
  };
}

function sameRoute(left: ModelRoute, right: ModelRoute): boolean {
  return left.tier === right.tier && left.provider === right.provider && left.model === right.model;
}

export function validateModelRoutingConfiguration(
  value: unknown,
): ModelRoutingConfiguration {
  if (!isRecord(value)) throw new ModelRoutingConfigurationError("model routing configuration is required");
  const lowCost = normalizeTierDefinition(value.lowCost, "low_cost", "lowCost");
  const complex = value.complex === undefined
    ? undefined
    : normalizeTierDefinition(value.complex, "complex", "complex");
  if (!lowCost.enabled) throw new ModelRoutingConfigurationError("lowCost must be enabled");

  const fallbacks: Partial<Record<ModelTier, readonly ModelTier[]>> = {};
  if (value.fallbacks !== undefined) {
    if (!isRecord(value.fallbacks)) {
      throw new ModelRoutingConfigurationError("fallbacks must be an object");
    }
    for (const tier of MODEL_TIERS) {
      const configured = value.fallbacks[tier];
      if (configured === undefined) continue;
      if (!Array.isArray(configured) || configured.length > MAX_FALLBACKS) {
        throw new ModelRoutingConfigurationError(`fallbacks.${tier} must contain at most ${MAX_FALLBACKS} tiers`);
      }
      const normalized: ModelTier[] = [];
      for (const fallback of configured) {
        if (!isTier(fallback)) throw new ModelRoutingConfigurationError(`fallbacks.${tier} contains an unknown tier`);
        if (fallback === tier || normalized.includes(fallback)) {
          throw new ModelRoutingConfigurationError(`fallbacks.${tier} must contain distinct tiers other than itself`);
        }
        const definition = fallback === "low_cost" ? lowCost : complex;
        if (!definition || !definition.enabled) {
          throw new ModelRoutingConfigurationError(`fallbacks.${tier} references an unavailable tier`);
        }
        normalized.push(fallback);
      }
      fallbacks[tier] = normalized;
    }
  }

  return { lowCost, ...(complex ? { complex } : {}), fallbacks };
}

function validateRoutingInput(input: ModelRoutingInput): void {
  if (!isRecord(input) || (input.complexity !== "ordinary" && input.complexity !== "complex")) {
    throw new TypeError("routing complexity must be ordinary or complex");
  }
  if (!Array.isArray(input.capabilities) || input.capabilities.length === 0) {
    throw new TypeError("routing capabilities must not be empty");
  }
  if (input.capabilities.some((capability) => !isCapability(capability))) {
    throw new TypeError("routing capabilities contain an unsupported capability");
  }
  if (new Set(input.capabilities).size !== input.capabilities.length) {
    throw new TypeError("routing capabilities must not contain duplicates");
  }
  if (!isRecord(input.budget)
    || typeof input.budget.requestsRemaining !== "bigint"
    || typeof input.budget.tokensRemaining !== "bigint"
    || typeof input.budget.costMicroUsdRemaining !== "bigint"
    || input.budget.requestsRemaining < 0n
    || input.budget.tokensRemaining < 0n
    || input.budget.costMicroUsdRemaining < 0n) {
    throw new TypeError("routing budget must contain non-negative bigint values");
  }
  if (input.deadlineAt !== undefined && (!Number.isFinite(input.deadlineAt) || input.deadlineAt <= 0)) {
    throw new TypeError("routing deadlineAt must be a positive epoch timestamp");
  }
}

function supports(definition: ModelTierDefinition, capabilities: readonly ModelCapability[]): boolean {
  return capabilities.every((capability) => definition.capabilities.includes(capability));
}

export class ModelRouter {
  readonly configuration: ModelRoutingConfiguration;

  constructor(configuration: unknown) {
    this.configuration = validateModelRoutingConfiguration(configuration);
  }

  route(input: ModelRoutingInput): ModelRoutingDecision {
    validateRoutingInput(input);
    if (input.signal?.aborted) return { outcome: "denied", reason: "cancelled" };
    if (input.deadlineAt !== undefined && input.deadlineAt <= Date.now()) {
      return { outcome: "denied", reason: "deadline_exceeded" };
    }
    if (input.budget.requestsRemaining <= 0n
      || input.budget.tokensRemaining <= 0n
      || input.budget.costMicroUsdRemaining <= 0n) {
      return { outcome: "denied", reason: "budget_exhausted" };
    }

    const { lowCost, complex } = this.configuration;
    const desired = input.complexity === "complex" ? complex : lowCost;
    const desiredTier: ModelTier = input.complexity === "complex" ? "complex" : "low_cost";
    const configuredFallbacks = this.configuration.fallbacks?.[desiredTier] ?? [];
    const candidates = [
      ...(desired ? [desired] : []),
      ...configuredFallbacks.map((tier) => tier === "low_cost" ? lowCost : complex),
    ].filter((definition): definition is ModelTierDefinition => definition !== undefined);
    const available = candidates.filter((definition) => definition.enabled && supports(definition, input.capabilities));
    if (available.length === 0) {
      const hasEnabledTier = candidates.some((definition) => definition.enabled);
      return {
        outcome: "denied",
        reason: hasEnabledTier ? "unsupported_capability" : "tier_unavailable",
      };
    }

    const primary = available[0];
    const timeoutMs = input.deadlineAt === undefined
      ? primary.timeoutMs
      : Math.min(primary.timeoutMs, input.deadlineAt - Date.now());
    if (timeoutMs < 1) return { outcome: "denied", reason: "deadline_exceeded" };
    const primaryRoute = routeFromDefinition({ ...primary, timeoutMs });
    const fallbacks = available.slice(1).map(routeFromDefinition).filter((route) => !sameRoute(route, primaryRoute));
    const reason = input.complexity === "ordinary"
      ? "ordinary_default"
      : primary.tier === "complex" ? "complex_requested" : "complex_tier_unavailable_fallback";
    return { outcome: "route", ...primaryRoute, reason, fallbacks };
  }
}

function slotKey(route: Pick<ModelRoute, "provider" | "model">): string {
  return `${route.provider}:${route.model}`;
}

export interface RoutedModelGatewayOptions {
  router: ModelRouter;
  gateways: ReadonlyMap<string, ModelGateway>;
  /**
   * The #24 admission layer must reserve capacity before every attempt,
   * including fallbacks. Returning false denies the attempt without trying a
   * less expensive route that was not admitted.
   */
  admit: (input: ModelRoutingInput, route: ModelRoute) => boolean | Promise<boolean>;
  defaultRouting?: ModelRoutingInput;
}

/**
 * Routes the existing injectable gateway contract without importing a provider
 * SDK. The caller can pass a trusted routing context per request through the
 * existing gateway options; fallback attempts remain bounded by configuration.
 */
export class RoutedModelGateway implements ModelGateway {
  private readonly defaultRouting: ModelRoutingInput;

  constructor(private readonly options: RoutedModelGatewayOptions) {
    this.defaultRouting = options.defaultRouting ?? {
      complexity: "ordinary",
      capabilities: ["text", "structured_output"],
      budget: {
        requestsRemaining: 1n,
        tokensRemaining: 1n,
        costMicroUsdRemaining: 1n,
      },
    };
  }

  async complete(request: ModelGatewayRequest, gatewayOptions: ModelGatewayOptions = {}): Promise<unknown> {
    const routingInput = gatewayOptions.routing ?? this.defaultRouting;
    const decision = this.options.router.route(routingInput);
    if (decision.outcome === "denied") throw new ModelRoutingDeniedError(decision.reason);

    const attempts: ModelRoute[] = [
      { tier: decision.tier, provider: decision.provider, model: decision.model, timeoutMs: decision.timeoutMs },
      ...decision.fallbacks,
    ];
    let lastError: unknown;
    for (const route of attempts) {
      if (!await this.options.admit(routingInput, route)) {
        throw new ModelRoutingDeniedError("budget_exhausted");
      }
      const gateway = this.options.gateways.get(slotKey(route));
      if (!gateway) {
        lastError = new Error("configured model gateway slot is unavailable");
        continue;
      }
      try {
        return await this.callWithTimeout(gateway, request, gatewayOptions.signal, route.timeoutMs);
      } catch (error) {
        if (gatewayOptions.signal?.aborted) throw error;
        lastError = error;
      }
    }
    throw lastError ?? new Error("no model gateway slot is available");
  }

  private async callWithTimeout(
    gateway: ModelGateway,
    request: ModelGatewayRequest,
    parentSignal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<unknown> {
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    if (parentSignal?.aborted) throw new Error("request cancelled");
    const providerPromise = Promise.resolve().then(() => gateway.complete(request, { signal: controller.signal }));
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(new Error("model gateway attempt timed out"));
      }, timeoutMs);
    });
    const cancellationPromise = parentSignal
      ? new Promise<never>((_, reject) => {
        cancel = () => {
          controller.abort();
          reject(new Error("request cancelled"));
        };
        parentSignal.addEventListener("abort", cancel, { once: true });
      })
      : undefined;
    try {
      return await Promise.race([providerPromise, timeoutPromise, ...(cancellationPromise ? [cancellationPromise] : [])]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (cancel && parentSignal) parentSignal.removeEventListener("abort", cancel);
      controller.abort();
    }
  }
}

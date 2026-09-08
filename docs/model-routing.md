# Model routing contract

`ModelRouter` is the provider-neutral policy boundary for model selection. It
does not import a provider SDK, make HTTP calls, discover pricing, or require
credentials. `provider` and `model` values are logical slots supplied by a
later provider adapter decision; this issue does not approve a production
vendor or model identifier.

## Inputs and decisions

The caller supplies:

- a trusted `complexity` signal (`ordinary` or `complex`); task text must never
  be used directly to select a premium tier;
- required capabilities (`text`, `web_research`, and/or `structured_output`);
- the owner-scoped remaining request, token, and micro-USD cost budget from the
  admission/limits layer;
- optional cancellation and absolute deadline context.

The router returns either a typed route or a typed denial. A route contains the
logical tier, provider/model slot, timeout, policy reason, and an ordered list
of at most two configured fallback routes. A denial is one of `cancelled`,
`deadline_exceeded`, `budget_exhausted`, `tier_unavailable`, or
`unsupported_capability`.

The budget values are a preflight snapshot. The future admission service in
issue #24 remains authoritative and must reserve capacity before every primary
or fallback provider attempt; routing never bypasses request, token, or cost
limits.

## Policy

Ordinary requests always select the enabled low-cost tier. Complex requests
select the complex tier only when it is explicitly enabled and supports all
requested capabilities. Fallbacks are explicit, ordered, and validated: an
unavailable or unsupported complex tier may fall back to low-cost only when the
configuration says so. An absent complex configuration is not an implicit
provider selection.

`RoutedModelGateway` wraps the existing injectable `ModelGateway` contract. It
looks up logical `provider:model` slots in a caller-supplied registry and makes
bounded fallback attempts without changing the research-agent result contract.
The caller must inject the #24 admission function; it is called before every
primary and fallback attempt, so a fallback cannot spend capacity that was not
reserved. It passes cancellation to each gateway and never logs provider
payloads, prompts, credentials, or tokens.

Example credential-free configuration:

```ts
const router = new ModelRouter({
  lowCost: {
    tier: "low_cost",
    provider: "configured-low-cost-slot",
    model: "configured-low-cost-model",
    enabled: true,
    capabilities: ["text", "structured_output"],
    timeoutMs: 10_000,
  },
  complex: {
    tier: "complex",
    provider: "configured-complex-slot",
    model: "configured-complex-model",
    enabled: false,
    capabilities: ["text", "web_research", "structured_output"],
    timeoutMs: 30_000,
  },
  fallbacks: { complex: ["low_cost"] },
});
```

Validation rejects missing identifiers, unknown tiers/capabilities, duplicate
capabilities, disabled fallback targets, self-fallbacks, negative budgets, and
timeouts outside the bounded range. No production credentials are needed for
tests or local development.

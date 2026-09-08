# Research-agent orchestration

`ResearchAgentService` is the provider-agnostic application service for one
research-agent turn. It has no Telegram, database, network, web-search, or
model-selection dependency. A caller supplies the active agent configuration,
ordered conversation history, and the new user request, then injects a
`ModelGateway` implementation.

## Gateway contract

The gateway receives a system prompt and model messages and returns one JSON
object:

```json
{"outcome":"clarification","question":"one concise question"}
```

or:

```json
{
  "outcome":"final",
  "answer":"...",
  "assumptions":["..."],
  "limitation":null
}
```

The service validates this boundary at runtime. Unsupported, empty, or
malformed output becomes a deterministic safe final response. A clarification
is returned as one typed result; the service never loops or parses arbitrary
Telegram text to decide the outcome.

## Context policy

- Agent configuration fields are limited to 2,000 characters each.
- A new request is limited to 4,000 characters.
- History is ordered by `createdAt ASC, id ASC` and at most the newest 40
  messages are sent to the gateway.
- Each history message is limited to 4,000 characters and the selected history
  is limited to 12,000 characters total. Older messages are discarded first;
  if the final selected message reaches the boundary, its content is marked as
  truncated.
- The new request is always appended after the selected history.
- Historical `system` and `tool` messages are passed as untrusted user-channel
  data so they cannot replace the service's system instructions.

The service rejects empty input, invalid dates, unsupported roles, and invalid
configuration before making a gateway call. User-provided configuration,
history, and requests are explicitly treated as untrusted data in the system
prompt.

## Failure behavior

The service enforces a 10-second default gateway timeout, configurable up to
60 seconds, and propagates cancellation through `AbortSignal`. Timeouts,
cancellation, provider unavailability, refusals, provider errors, and malformed
output produce safe user-facing final results with no provider payloads,
tokens, private messages, or secrets in diagnostics. The logger receives only
a fixed failure reason.

## Web evidence and citations

When `ResearchAgentService` receives an injected `WebResearchService`, it uses
the deterministic `requiresWebResearch` rule. Explicit research/source wording
and time-sensitive terms such as `latest`, `current`, `today`, `price`, or
`weather` trigger bounded retrieval; ordinary requests do not. The original
request is the only search query, and the provider contract enforces limits and
normalizes sources before they reach the model.

Retrieved context is wrapped as untrusted evidence. Source text cannot change
the assistant's role, reveal hidden context, enable tools, or override policy.
The model may return source IDs in `citations`; the service rejects unknown or
duplicate IDs and maps accepted IDs to canonical title, domain, and URL data.
The Telegram task flow renders those citations as a numbered, bounded source
list. Search failures and incomplete/empty evidence remain safe and explicit in
the final limitation rather than being represented as sourced facts.

Without an injected web service, search-required requests still run through the
model with an unavailable-evidence marker, so local tests and development need
no vendor credentials. Web retrieval, external actions, usage accounting, and
model routing remain behind their respective interfaces.

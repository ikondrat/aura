# Web evidence in research-agent answers

The research agent uses the provider-neutral contract in
[`web-research.md`](web-research.md) and keeps retrieval behind an injected
`WebResearchService`. No vendor SDK, network credential, or provider payload is
required by the orchestration service.

## Search selection

`requiresWebResearch` is a deterministic request classifier. It searches when
the user explicitly asks for research, sources, citations, online lookup, or
time-sensitive information (`latest`, `current`, `today`, `news`, `weather`,
`price`, and similar terms). Other tasks do not make an unnecessary search
call. The original bounded request is passed as the search query.

## Evidence and citation policy

Normalized source context is placed in an `<untrusted_web_evidence>` block in
the model system prompt. It is data, never an instruction. The model must
return only source IDs from that block in `citations`; unknown or repeated IDs
make the model response malformed and produce a safe failure. Accepted IDs are
resolved to the normalized source title, domain, and canonical URL before any
Telegram output is generated.

An empty, failed, or malformed search is never presented as evidence. The
agent can still return a useful answer, but the result carries an explicit
limitation that it is not source-backed. Partial evidence is marked as
incomplete. A successful answer without citations is explicitly marked as
uncited rather than silently implying that its claims were verified.

The Telegram task flow renders citations as a compact numbered list and bounds
the complete response to Telegram's 4,096-character limit. Source text is
rendered as plain text and is not interpreted as Telegram markup.

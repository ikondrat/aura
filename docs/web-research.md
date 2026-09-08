# Web-research provider contract

`WebResearchService` is the provider-neutral boundary for retrieving citation
evidence. It accepts a bounded query and injectable provider; it does not
select a vendor, call a network, render Telegram messages, or generate an
answer. A provider adapter is responsible for mapping its vendor response to
the runtime shape below, and the service never returns that raw payload.

## Request and provider shape

```ts
await service.search({
  query: "compare privacy-preserving analytics",
  locale: "en-GB",
  safeSearch: true,
  resultCount: 10,
  timeoutMs: 10_000,
  signal,
});
```

The injected provider receives the normalized request and returns either an
array of raw results or:

```ts
{
  complete?: boolean;
  results: Array<{
    url: string;
    title?: string;
    snippet?: string;
    sourceName?: string;
    publishedAt?: string;
  }>;
}
```

The provider boundary is `unknown` at runtime so malformed vendor data cannot
silently enter the application. No provider SDK, API key, or network access is
needed by the contract or its tests.

## Normalization policy

- Queries are trimmed and limited to 2,000 characters. Result counts are from
  1 through 20; timeouts are from 1 ms through 60 seconds.
- Sources are limited to 20 and evidence context to 12,000 characters.
  Titles, snippets, source names, and URLs have independent length limits.
- Only absolute `http:` and `https:` URLs are accepted. Userinfo,
  unsupported schemes, malformed URLs, URL fragments, and common tracking
  parameters are removed or rejected. Invalid source entries are omitted;
  if every entry is invalid, the outcome is `malformed_provider_data`.
- URLs are canonicalized (including sorted query parameters) before
  de-duplication. A SHA-256 prefix of the canonical URL is the stable source
  ID. Sources are ordered by title and then URL, so equal timestamps or
  provider order cannot change the result.
- Missing titles use the source domain. Missing snippets and invalid
  publication timestamps are represented as absent/empty fields. Valid
  entries mixed with invalid entries produce a `partial` result.

## Typed outcomes

`results` and `empty` contain normalized evidence only. `partial` also states
why entries were omitted and how many were omitted. `cancelled`, `timeout`,
`provider_unavailable`, `malformed_provider_data`, and `provider_error` contain
no provider payload or error text. The result type has `sources` and
`context`, never `answer` or `assumptions`; downstream orchestration must not
claim that a source was consulted when no evidence was returned.

Invalid caller requests throw `WebResearchInputError` before the provider is
called. A pre-cancelled request returns `cancelled` without invoking it.

# RFC and source mapping

Every node emitted by `replay()` carries a `clause`. This file lists what each one means and
where the corresponding rule lives. The source column points at
`http-cache-semantics@4.3.0` (`index.js`, commit `b1d4bd6`), because `cachetrace` mirrors that
implementation rather than an idealised reading of the RFC.

## Storage (`storable()`)

| node id | clause | upstream source | note |
| --- | --- | --- | --- |
| `storable.request-no-store` | RFC 9111 §5.2.2.5 | `index.js` `storable()`, first term | request forbids storing |
| `storable.method` | RFC 9111 §3, §9.2.1 | `storable()`, method term | `GET`, `HEAD`, or `POST` with explicit freshness |
| `storable.status-understood` | RFC 9111 §3 | `storable()`, `understoodStatuses` | 206 is listed as cacheable-by-default but absent here |
| `storable.response-no-store` | RFC 9111 §5.2.1.5 | `storable()`, `no-store` term | |
| `storable.shared-private` | RFC 9111 §5.2.1.7 | `storable()`, `private` term | only applies to shared caches |
| `storable.shared-authorization` | RFC 9111 §3.3 | `storable()` + `_allowsStoringAuthenticated()` | `must-revalidate`, `public` or `s-maxage` unblock it |
| `storable.explicit-freshness` | RFC 9111 §3, §4.2.2 | `storable()`, final disjunction | any of Expires / max-age / s-maxage / public / default-status |
| `storable.freshness.*` | RFC 9111 §5.2.1.1, §5.2.1.9, §5.2.1.10, §5.3; RFC 7231 §6.1 | children of the disjunction | |

## Freshness lifetime (`maxAge()`)

| node id | clause | upstream source | note |
| --- | --- | --- | --- |
| `maxAge.storable-or-no-cache` | RFC 9111 §5.2.1.4 | `maxAge()`, first guard | lifetime is 0 when unstorable or `no-cache` |
| `maxAge.shared-set-cookie` | **upstream policy, not RFC 9111** | `maxAge()`, Set-Cookie guard | the source comment calls it a judgement call |
| `maxAge.vary-star` | RFC 9111 §4.1 | `maxAge()`, `vary === '*'` | strict string equality, not a field-list parse |
| `maxAge.proxy-revalidate` | RFC 9111 §5.2.1.8 | `maxAge()`, shared branch | stricter than the RFC text |
| `maxAge.s-maxage` | RFC 9111 §5.2.1.10 | `maxAge()`, shared branch | takes precedence over `max-age` for shared caches |
| `maxAge.max-age` | RFC 9111 §5.2.1.1 | `maxAge()` | an empty string value is falsy, `"0"` is truthy |
| `maxAge.expires` | RFC 9111 §5.3 | `maxAge()` | invalid or past `Expires` reads as already expired |
| `maxAge.last-modified-heuristic` | RFC 9111 §4.2.2 | `maxAge()` | `cacheHeuristic` fraction of the age since `Last-Modified` |
| `maxAge.default` | RFC 9111 §4.2.2 | `maxAge()`, final return | `immutableMinTimeToLive` when `immutable`, else 0 |

## Age (`age()`)

| node id | clause | upstream source |
| --- | --- | --- |
| `age.header` | RFC 9111 §5.1 | `_ageValue()` |
| `age.resident-time` | RFC 9111 §4.2.3 | `age()` |

## Time to live (`timeToLive()`)

| node id | clause | upstream source |
| --- | --- | --- |
| `timeToLive.fresh` | RFC 9111 §4.2.1 | `maxAge() - age()` |
| `timeToLive.stale-if-error` | RFC 5861 §4 | `timeToLive()` |
| `timeToLive.stale-while-revalidate` | RFC 5861 §3 | `timeToLive()` |

## Reuse (`evaluateRequest()`)

| node id | clause | upstream source | note |
| --- | --- | --- | --- |
| `evaluate.must-revalidate` | RFC 9111 §5.2.1.2 | `evaluateRequest()`, first guard | forces a synchronous round trip |
| `evaluate.request-match` | RFC 9111 §4 | `_requestMatches(req, false)` | `allowHeadMethod` is false on this path |
| `evaluate.match.url` | RFC 9111 §4 | `_requestMatches` | skipped when the stored URL is unset |
| `evaluate.match.host` | RFC 9111 §4 | `_requestMatches` | |
| `evaluate.match.method` | RFC 9111 §4 | `_requestMatches` | |
| `evaluate.match.vary` | RFC 9111 §4.1 | `_varyMatches()` | splits `Vary` on `\s*,\s*` after trimming |
| `evaluate.request-no-cache` | RFC 9111 §5.2.2.4 | `evaluateRequest()` | also honours `Pragma: no-cache` |
| `evaluate.request-max-age` | RFC 9111 §5.2.2.1 | `evaluateRequest()` | |
| `evaluate.request-min-fresh` | RFC 9111 §5.2.2.3 | `evaluateRequest()` | |
| `evaluate.stale` | RFC 9111 §4.2.1 | `stale()` | `maxAge() <= age()` |
| `evaluate.max-stale` | RFC 9111 §5.2.2.2 | `evaluateRequest()` | bare `max-stale` accepts any staleness |
| `evaluate.stale-while-revalidate` | RFC 5861 §3 | `useStaleWhileRevalidate()` | window is `maxAge + swr` |

## Nodes with no RFC clause

Three checks are upstream policy or implementation detail rather than protocol:

1. `maxAge.shared-set-cookie` — the source comment states the RFC would allow caching and that
   this is a deliberate refusal.
2. `maxAge.proxy-revalidate` — the RFC governs staleness handling; upstream also zeroes the
   lifetime.
3. `immutable-lifetime-inflation` (a finding, not a trace node) — a unit mismatch between the
   `immutableMinTimeToLive` option and the seconds returned by `maxAge()`.

Naming these as RFC requirements would be inaccurate, so the `clause` field says what they are.

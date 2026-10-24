# Known limits

This file records what `cachetrace` deliberately does not do, and where its output should be
read with care. Anything listed here is a conscious trade-off, not a bug waiting to be found.

## 1. The replay targets one upstream release

The trace mirrors `http-cache-semantics@4.3.0` (commit `b1d4bd6`). If upstream changes a rule,
the differential suite will start reporting divergences rather than silently explaining the old
behaviour — that is the intended failure mode. Until then, a trace against a newer upstream can
be wrong in exactly the places upstream changed.

`package.json` declares the peer range as `>=4.1.1` so installs are not blocked, but the
*verified* target is 4.3.0. `npm test` with a different peer version is the check.

## 2. Mirroring beats correctness

Where upstream deviates from RFC 9111, the replay deviates identically. Three known cases:

- `proxy-revalidate` zeroes the shared-cache lifetime, which the RFC does not require.
- A shared response carrying `Set-Cookie` gets no freshness unless `public` or `immutable`.
- A repeated directive keeps the last occurrence instead of being treated as invalid.

These are reported as findings, not corrected. Correcting them would produce a trace that
disagrees with the engine the reader actually deploys.

## 3. Counterfactuals are single-variable

Interventions are applied one at a time. Two changes that only help together (for example
adding `public` *and* removing `Vary`) will not be reported as a fix. This keeps every claim
attributable to one change, at the cost of missing compound repairs.

The intervention set is also finite: response directives, four response headers, two request
headers, and the status code. A fix that requires changing the request method or the request
URL is not offered, because those are not header fixes.

## 4. `timeToLive()` is not a schedule

`timeToLive()` returns a single number computed at one instant. `cachetrace` evaluates one
instant per run (`--now`, defaulting to the wall clock). It does not simulate the entry forwards
in time, so it will not tell you *when* a currently-fresh entry stops being reusable.

Without `--now`, TTL and age values depend on when the command ran. Always pass `--now` when
comparing runs or quoting a report.

## 5. Partial responses are not understood

Upstream excludes 206 from `understoodStatuses` while listing it in
`statusCodeCacheableByDefault`. `cachetrace` reproduces that and flags it, but it does not
implement range-aware caching, and `revalidationHeaders()` drops `if-range` (upstream does the
same). A capture full of video segment responses will look uniformly unstorable; that is the
engine's behaviour, not necessarily the CDN's.

## 6. HAR imports infer `Host`

HAR records the URL but not always a `Host` header. Upstream compares `headers.host` against the
stored value, so an absent one would compare `undefined === undefined` and appear to match
anything. `cachetrace` derives `host` from the URL when absent and marks the entry
`derivedHost: true`. If your HAR does carry a `Host` that differs from the URL authority, the
capture wins.

HTTP/2 pseudo-headers (`:status`, `:authority`, …) are skipped during import.

## 7. Header casing is not normalised for the engine

Upstream reads lower-case keys only. `cachetrace` does not lower-case anything on the way in —
doing so would explain a decision the engine never made. Instead, canonical-cased headers are
reported as `invisible-header-case`, and counterfactual interventions write back to the key that
is actually present.

This matters in practice: DevTools and hand-written fixtures frequently use `Cache-Control`.

## 8. Two open upstream advisories are not addressed

At the time of writing, `kornelski/http-cache-semantics` has open security advisories
([#65](https://github.com/kornelski/http-cache-semantics/issues/65) on `max-stale` handling and
[#57](https://github.com/kornelski/http-cache-semantics/issues/57) on `Vary: *` whitespace
forms). `cachetrace` measures the behaviour those reports describe — the `dead-cache-entry`
finding comes from the same code path — but it does not patch upstream and must not be described
as fixing them. If you need a mitigated deployment, pin a fixed upstream release when one exists.

## 9. Audit cost is bounded

`audit` runs counterfactuals only on entries that are not reusable and only up to
`--limit` (default 200) of them. Beyond that, the report's recommendation counts describe the
sampled entries, not the whole capture. Pass `--limit` explicitly when you need complete
coverage and can afford the runtime.

## 10. Findings are heuristics over measured behaviour

Each finding states the measurement it came from, and the evidence string can be reproduced by
running the engine directly. None of them is a full conformance check: a response with no
findings is not proven correct, only free of the nine patterns that are checked.

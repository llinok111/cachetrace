# cachetrace

Explain and audit HTTP cache decisions with the same engine your CDN runs.

`cachetrace` sits on top of [http-cache-semantics](https://github.com/kornelski/http-cache-semantics)
— the library behind CloudFront, Fastly and Akamai cache decisions — and answers the
question that library was never built to answer: **why**.

```
$ npx cachetrace explain response.json --counterfactual

cachetrace  GET https://api.example.com/data
----------------------------------------------------------------
verdict    storable=true  maxAge=600s  ttl=10m  reuse=false
engine     replay agrees with http-cache-semantics

RISKS (1)
  [CRITICAL] dead-cache-entry
    Stored for reuse that can never happen
    evidence: vary="* ", timeToLive=600000ms, reuse=false

counterfactual analysis
----------------------------------------------------------------
baseline   storable=true  ttl=10m  reuse=false
tested     10 single-variable changes, 5 verified improvement(s)

1. Remove the vary response header   [risk: high]
   verified: reuse false -> true
   Vary is the mechanism that stops a cache from serving content negotiated
   for one request to a different one. Removing it can mix representations.
```

## Why this exists

`http-cache-semantics` is a decision engine, and a decision engine returns decisions:

- `storable()` returns a boolean. It is a nine-term `&&` chain, so it short-circuits at the
  first failing term and the other eight are never evaluated.
- `maxAge()` returns seconds. It has six separate `return 0` exits, all of which collapse
  into the same number `0`.
- `evaluateRequest()` returns `{ response, revalidation }`. Seven distinct control-flow
  paths produce the same "miss" shape.

That is the right design for a hot path. It is the wrong shape for the person staring at a
CDN dashboard wondering why a `max-age=600` response is not cached.

The surrounding ecosystem does not fill the gap. Nearly everything built on
`http-cache-semantics` consumes the decision rather than explaining it: CDN integrations move
it to the edge, connectors forward it to other systems, formatters make it fit a log line. The
cache-audit tools that do exist independently (`cache-audit`, `cache-header-audit`,
`static-asset-cache-auditor`, all published in 2026) parse headers with regular expressions and
hand out configuration advice. None of them runs the actual decision engine, so none of them
can tell you that `Cache-Control: max-age=600` together with `Vary: "* "` produces a stored
entry that will never be served.

Measured on 2026-10-24, `http-cache-semantics` had **262 GitHub stars and 33.2 million weekly
npm downloads**. It is infrastructure that almost nobody looks at.

## What it does

### 1. `explain` — a trace, not a verdict

Every rule the engine applies becomes a node carrying the clause it implements, the value it
observed, and whether it passed. All conditions are evaluated, so a response that fails for
three reasons shows three reasons instead of the one the engine hit first.

### 2. Differential verification — the explanation is checked, not asserted

`replay()` is an independent implementation. It could drift. So every public call also
constructs a real `CachePolicy`, pins both to the same clock, and compares `storable`,
`maxAge`, `timeToLive`, reuse and revalidation mode. A disagreement is surfaced as a
divergence and the report says the trace cannot be trusted for that input.

The test suite runs this comparison across 3,100 generated request/response pairs; a
deliberately corrupted replay is included to prove the comparison can fail.

### 3. `counterfactual` — only changes that measurably flip the outcome

The analyser enumerates single-variable interventions (remove a directive, add `public`, tune
`max-age`, drop `Vary`, drop `Set-Cookie`, drop `Authorization`, rewrite the status), applies
each to a copy of the input, and **re-runs the real engine**. A change is reported as a fix
only when the measured outcome improves. Each fix carries a risk grade, because most changes
that make a response cacheable also change what it means:

| grade | meaning |
| --- | --- |
| `low` | additive or same-semantics, e.g. adding `s-maxage` next to an existing `max-age` |
| `medium` | grants longer or broader reuse than the origin asked for |
| `high` | contradicts an explicit origin instruction or a field used to keep responses apart (`no-store`, `private`, `Vary`, `Set-Cookie`) |

A `high` fix is shown with its consequence spelled out; it is never presented as a
recommendation to apply blindly.

### 4. `audit` — where caching is costing you the most

Feed it a HAR export, NDJSON, or a JSON array. It aggregates TTL distribution, findings by
kind, and verified fixes ranked by how many entries they would help. Exit codes make it
usable in CI.

## Findings it can produce

These are not header-lint rules. Each one requires comparing two engine code paths against
each other, which is why a regex-based checker cannot see them.

### `dead-cache-entry` — stored for a reuse that can never happen

```bash
$ node -e "
const C=require('http-cache-semantics');
const req={url:'/x',method:'GET',headers:{host:'a.test'}};
for (const vary of ['*','* ']) {
  const p=new C(req,{status:200,headers:{'cache-control':'max-age=600',vary}},{});
  console.log(JSON.stringify({vary, maxAge:p.maxAge(), ttlMs:p.timeToLive(), reuse:p.satisfiesWithoutRevalidation(req)}));
}"
{"vary":"*","maxAge":0,"ttlMs":0,"reuse":false}
{"vary":"* ","maxAge":600,"ttlMs":600000,"reuse":false}
```

`maxAge()` tests `vary === '*'` exactly. `_varyMatches()` trims and splits the field list.
A single trailing space therefore grants a 600-second lifetime while request matching still
refuses reuse: the entry occupies cache storage for ten minutes and is never served.

### `immutable-lifetime-inflation` — a 1000x unit mismatch

```bash
$ node -e "const C=require('http-cache-semantics');
console.log(new C({headers:{host:'a'}},{headers:{'cache-control':'public, immutable'}},{}).maxAge())"
86400000
```

`immutableMinTimeToLive` is documented and defaulted in **milliseconds** (86,400,000 = one
day), but `maxAge()` returns it as **seconds**, and every other branch of that method is in
seconds. When `immutable` is the only freshness signal the lifetime becomes 86,400,000
seconds ≈ 1,000 days. Pairing `immutable` with an explicit `max-age` avoids the branch.

### `set-cookie-blocks-shared-freshness` — CDN caching silently stops

A shared response carrying `Set-Cookie` gets zero freshness unless it is `public` or
`immutable`. RFC 9111 permits caching here; this is the engine's own policy (the source says
so). The practical effect is that a response can be perfectly cacheable by the RFC and still
never cache on a CDN.

### Also detected

`invisible-header-case` (canonical-cased `Cache-Control` that the engine cannot read),
`duplicate-directive` (RFC 9111 §4.2.1 says invalid, engine keeps the last),
`quoted-comma-split` (`no-cache="a, b"` cut in half by the naive comma split),
`field-qualified-no-cache` (body reuse allowed by the RFC, blanket-blocked by the engine),
`age-without-date`, and `request-bypasses-cache` (a browser reload, not a misconfiguration).

## Install

```bash
npm install cachetrace http-cache-semantics
```

`http-cache-semantics` is a **peer dependency on purpose**: the explanation must come from the
same engine the caller actually ships, not from a vendored copy that can drift.

Node 18 or newer. No runtime dependencies beyond the peer.

## CLI

```
cachetrace explain <file|-> [--index n] [--age seconds] [--private]
                            [--counterfactual] [--format text|md|json]
cachetrace audit   <file|-> [--limit n] [--rows] [--format text|md|json]

common: --fail-on divergence|warning|critical   --now <epoch-ms>
```

`<file>` accepts a HAR export, a single `{ request, response }` object, an array of them, or
NDJSON. `-` reads stdin.

Exit codes: `0` clean, `1` input/usage error, `2` engine divergence, `3` findings at or above
the requested level.

## API

```js
const { explain, counterfactual, audit } = require('cachetrace');

const explanation = explain(
  {
    request: { url: '/app.js', method: 'GET', headers: { host: 'cdn.test' } },
    response: {
      status: 200,
      headers: { 'cache-control': 'public, max-age=31536000, immutable' },
    },
    options: { shared: true },
  },
  { ageSeconds: 0 }
);

explanation.verdict;       // { storable, maxAge, age, timeToLive, reuse, ... }
explanation.consistent;    // true when the replay agrees with the engine
explanation.traces;        // storable | maxAge | age | timeToLive | evaluateRequest
explanation.risks;         // findings, sorted by severity
explanation.divergences;   // empty when consistent
```

`counterfactual(input, opts)` returns `{ baseline, fixes, totalVerified, ineffective, tested }`.
`audit(source, opts)` returns the aggregate described above. Both accept `{ now }` so output
is reproducible.

Pass an explicit `now` whenever you compare runs, quote a report, or write a test.

## Scope and honesty

- **It does not modify or fork `http-cache-semantics`.** No upstream file is patched, and the
  upstream test suite is unchanged.
- **It mirrors upstream semantics, including upstream deviations from RFC 9111.** A trace that
  describes an idealised RFC would be useless, because the CDN runs the code, not the RFC.
  Where the two differ, the finding says so and cites "upstream policy" instead of a section
  number.
- **It does not store anything.** It is an analyser, not a cache.
- **It does not fetch URLs.** Input is what you give it, so results are reproducible and it
  works offline against a HAR you already captured.
- Counterfactual fixes are single-variable. Combinations are not explored, and a reported fix
  is not a recommendation to ship — read its risk note.

See [`docs/KNOWN-LIMITS.md`](docs/KNOWN-LIMITS.md) for the parts that are deliberately
approximate, and [`docs/RFC-MAPPING.md`](docs/RFC-MAPPING.md) for the clause behind every node.

## Tests

```bash
npm test
```

88 tests across eight files: directive parsing, per-rule trace assertions, counterfactual
self-verification, risk detection, batch audit over a HAR fixture, edge and adversarial inputs,
CLI end-to-end, and the differential suite (3,100 generated cases plus a negative control).

Cost, measured on this machine (Node 22, Windows, single core):

| input | work | wall time |
| --- | --- | --- |
| 1,000 HAR entries | parse + replay + diff | 46 ms |
| 1,000 HAR entries | same, plus 200 counterfactual analyses | 61 ms |

These are throughput numbers for the analyser, not claims about the engine.

## License

BSD-2-Clause. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE) for the upstream attribution
required by `http-cache-semantics`.

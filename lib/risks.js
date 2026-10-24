'use strict';

/**
 * Risk detection.
 *
 * These are findings that a header-by-header checklist cannot produce, because
 * they only exist in the relationship between what the engine computes and what
 * it will later do with that computation. Each finding states the measurement it
 * came from, so it can be re-derived from the input by hand.
 */

/**
 * @typedef {Object} Finding
 * @property {string} code stable identifier
 * @property {'info'|'warning'|'critical'} severity
 * @property {string} title
 * @property {string} detail
 * @property {string} evidence what was measured
 * @property {string} [clause]
 */

const sevRank = { info: 0, warning: 1, critical: 2 };

/**
 * @param {Object} input
 * @param {Object} replayed result of replay()
 * @returns {Finding[]}
 */
function detectRisks(input, replayed) {
  const findings = [];
  const resHeaders = input.response.headers || {};
  const reqHeaders = input.request.headers || {};
  const v = replayed.verdict;

  // --- 1. the entry is stored but can never be reused ----------------------
  const varyRaw = resHeaders.vary;
  const varyIsWildcardSomewhere =
    typeof varyRaw === 'string' &&
    varyRaw
      .split(',')
      .map((part) => part.trim())
      .includes('*');
  const varyIsStrictWildcard = varyRaw === '*';

  if (
    typeof varyRaw === 'string' &&
    varyIsWildcardSomewhere &&
    !varyIsStrictWildcard &&
    v.storable &&
    v.timeToLive > 0
  ) {
    findings.push({
      code: 'dead-cache-entry',
      severity: 'critical',
      title: 'Stored for reuse that can never happen',
      detail:
        'Vary contains a wildcard only in a padded or list form. The freshness path compares ' +
        'Vary against the exact string "*", so it grants a lifetime, while request matching ' +
        'trims and splits the field list, so it always refuses reuse. The result is an entry ' +
        'that occupies cache storage for its whole TTL and is never served.',
      evidence:
        `vary=${JSON.stringify(varyRaw)}, timeToLive=${v.timeToLive}ms, ` +
        `reuse=${v.reuse}`,
      clause: 'RFC 9111 §4.1',
    });
  }

  // --- 2. header names upstream cannot see --------------------------------
  const invisible = [];
  for (const name of ['cache-control', 'expires', 'pragma', 'vary', 'age', 'date']) {
    if (Object.prototype.hasOwnProperty.call(resHeaders, name)) continue;
    const alias = Object.keys(resHeaders).find(
      (k) => k !== name.toLowerCase() && k.toLowerCase() === name
    );
    if (alias) invisible.push(alias);
  }
  if (invisible.length) {
    findings.push({
      code: 'invisible-header-case',
      severity: 'warning',
      title: 'Header names are invisible to the engine',
      detail:
        'http-cache-semantics reads lower-case keys only. These headers are present under ' +
        'different casing, so every rule that depends on them evaluates as if they were ' +
        'absent. Node\'s http module lower-cases incoming headers, so this mostly affects ' +
        'hand-built objects, HAR imports and test fixtures.',
      evidence: `present as: ${invisible.join(', ')}`,
    });
  }

  // --- 3. repeated directives --------------------------------------------
  if (replayed.parsed.response.duplicates.length) {
    findings.push({
      code: 'duplicate-directive',
      severity: 'warning',
      title: 'Repeated Cache-Control directive',
      detail:
        'RFC 9111 §4.2.1 says a repeated directive makes the freshness information invalid and ' +
        'invites treating the response as stale. The engine keeps the last occurrence instead, ' +
        'so the effective value depends on order rather than on the RFC.',
      evidence: replayed.parsed.response.duplicates.join(', '),
      clause: 'RFC 9111 §4.2.1',
    });
  }

  // --- 4. quoted commas ---------------------------------------------------
  const ccKey = Object.keys(resHeaders).find(
    (k) => k.toLowerCase() === 'cache-control'
  );
  const ccRaw = ccKey ? resHeaders[ccKey] : undefined;
  if (typeof ccRaw === 'string' && /"[^"]*,[^"]*"/.test(ccRaw)) {
    findings.push({
      code: 'quoted-comma-split',
      severity: 'warning',
      title: 'Quoted value contains a comma',
      detail:
        'The engine splits Cache-Control on every comma without regard to quoting, so a quoted ' +
        'field list such as no-cache="set-cookie, authorization" is cut in half and produces ' +
        'directive names that were never written.',
      evidence: JSON.stringify(ccRaw),
    });
  }

  // --- 5. field-qualified no-cache treated as blanket no-cache -----------
  const parsedRes = replayed.parsed.response.strictView.get('no-cache');
  if (parsedRes && parsedRes.fieldList && parsedRes.fieldList.length) {
    findings.push({
      code: 'field-qualified-no-cache',
      severity: 'info',
      title: 'no-cache is qualified with field names',
      detail:
        'A field-qualified no-cache means only the listed headers must be revalidated; the body ' +
        'may still be reused. The engine treats any no-cache as blanket revalidation, which is ' +
        'stricter than the header asks for.',
      evidence: `no-cache="${parsedRes.fieldList.join(', ')}"`,
      clause: 'RFC 9111 §5.2.1.4',
    });
  }

  // --- 6. Age without Date ------------------------------------------------
  const ageKey = Object.keys(resHeaders).find((k) => k.toLowerCase() === 'age');
  const dateKey = Object.keys(resHeaders).find((k) => k.toLowerCase() === 'date');
  if (ageKey && !dateKey) {
    findings.push({
      code: 'age-without-date',
      severity: 'info',
      title: 'Age present without Date',
      detail:
        'Without a Date header the heuristic and Expires calculations fall back to the local ' +
        'receive time, so the computed lifetime depends on when this tool ran rather than on ' +
        'what the origin said.',
      evidence: `age=${resHeaders[ageKey]}, date absent`,
    });
  }

  // --- 7. request forces a bypass ----------------------------------------
  const reqCC = replayed.parsed.request.upstreamView;
  if (reqCC['no-cache'] !== undefined && v.storable) {
    findings.push({
      code: 'request-bypasses-cache',
      severity: 'info',
      title: 'This request will bypass the cache',
      detail:
        'The request carries Cache-Control: no-cache, so a stored response is never served ' +
        'without validation even when it is perfectly fresh. If this came from a browser ' +
        'reload, it does not indicate a server misconfiguration.',
      evidence: 'request cache-control: no-cache',
    });
  }

  // --- 8. shared cache refuses a Set-Cookie response ---------------------
  if (
    v.storable &&
    v.maxAge === 0 &&
    resHeaders['set-cookie'] &&
    !replayed.parsed.response.upstreamView.public &&
    !replayed.parsed.response.upstreamView.immutable
  ) {
    findings.push({
      code: 'set-cookie-blocks-shared-freshness',
      severity: 'warning',
      title: 'Set-Cookie zeroes shared-cache freshness',
      detail:
        'The engine deliberately gives no freshness to a shared response carrying Set-Cookie ' +
        'unless it is public or immutable. RFC 9111 permits caching here, so this is a policy ' +
        'choice, not a protocol requirement; the practical effect is that CDN caching silently ' +
        'stops working on any response that also sets a cookie.',
      evidence: `set-cookie present, maxAge=${v.maxAge}`,
      clause: 'upstream policy, not RFC 9111',
    });
  }

  // --- 9. directive names the engine will not recognise ------------------
  const directives = replayed.parsed.response.upstreamView;
  const caseQuirks = replayed.parsed.response.quirks.filter(
    (q) => q.kind === 'mixed-case-directive'
  );
  if (caseQuirks.length) {
    findings.push({
      code: 'mixed-case-directive',
      severity: 'warning',
      title: 'Directive names are case-sensitive to the engine',
      detail:
        'RFC 9111 §5.2 makes Cache-Control directive names case-insensitive, so "Max-Age=600" ' +
        'means the same as "max-age=600". The engine keys directives by their exact text, so a ' +
        'differently-cased name is stored as an unrelated directive and every rule that looks ' +
        'for the lower-case name sees nothing. Lower-casing the name is a semantics-preserving ' +
        'repair.',
      evidence: caseQuirks
        .map((q) => q.detail.match(/written as "([^"]+)"/))
        .filter(Boolean)
        .map((m) => m[1])
        .join(', '),
      clause: 'RFC 9111 §5.2',
    });
  }

  // --- 10. immutable alone inflates the lifetime -------------------------
  const hasExplicitLifetime =
    !!directives['max-age'] || !!(replayed.state.isShared && directives['s-maxage']) || !!resHeaders.expires;
  if (
    directives.immutable &&
    !hasExplicitLifetime &&
    v.maxAge === replayed.state.immutableMinTtl
  ) {
    findings.push({
      code: 'immutable-lifetime-inflation',
      severity: 'warning',
      title: 'immutable alone inflates the lifetime by roughly 1000x',
      detail:
        'The engine option immutableMinTimeToLive is documented and defaulted in milliseconds ' +
        '(86,400,000 ms, i.e. one day), but maxAge() returns it unchanged while every other ' +
        'branch of that method works in seconds. When immutable is the only freshness signal, ' +
        'the lifetime becomes 86,400,000 seconds - about 1000 days - instead of the intended ' +
        'one day. Pairing immutable with an explicit max-age avoids the branch entirely.',
      evidence:
        `maxAge=${v.maxAge}s, immutableMinTimeToLive=${replayed.state.immutableMinTtl}ms, ` +
        `timeToLive=${v.timeToLive}ms`,
      clause: 'upstream unit mismatch, not RFC 9111',
    });
  }

  return findings.sort((a, b) => sevRank[b.severity] - sevRank[a.severity]);
}

module.exports = { detectRisks };

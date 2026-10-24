'use strict';

/**
 * Counterfactual analysis.
 *
 * The question cachetrace answers here is not "what would be nicer" but "which
 * single, concrete header change actually flips the verdict". Every candidate is
 * applied to a copy of the input, re-run through the real http-cache-semantics
 * engine, and only kept when the measured outcome improves. Nothing is reported
 * as a fix on the strength of reasoning alone.
 *
 * Each fix carries a risk grade, because most changes that make a response
 * cacheable also change what it means:
 *
 *   low    - additive, semantics-preserving in the usual case (e.g. adding
 *            s-maxage to a response that already had max-age)
 *   medium - grants longer or broader reuse than the origin asked for; can serve
 *            stale content
 *   high   - contradicts an explicit origin instruction or a field the origin
 *            used to keep responses apart (no-store, private, Vary, Set-Cookie)
 *
 * A high-risk fix is legitimate to *show* - the operator may have inherited
 * headers they did not write - but it must never be applied blindly, so it is
 * always rendered with its consequence spelled out.
 */

const { parseCacheControl } = require('./directives');
const { buildPolicy } = require('./policy');

const MAX_AGE_CANDIDATES = [60, 300, 3600, 86400, 31536000];

/**
 * Below this, a longer lifetime is worth suggesting; above it, lengthening is
 * churn rather than a fix.
 * @type {number}
 */
const TTL_WORTH_IMPROVING_MS = 86_400_000;

/**
 * @param {string|undefined} key
 * @returns {string|undefined}
 */
function formatCacheControl(cc) {
  const parts = [];
  for (const k in cc) {
    const v = cc[k];
    parts.push(v === true ? k : k + '=' + v);
  }
  return parts.length ? parts.join(', ') : undefined;
}

/**
 * Header names are case-sensitive to upstream (it reads only lower-case keys),
 * but real captures from DevTools and HAR files often use canonical casing.
 * Interventions must write back to the key that is actually present.
 * @param {Record<string,string>} headers
 * @param {string} name lower-case header name
 * @returns {string|null}
 */
function findHeaderKey(headers, name) {
  if (Object.prototype.hasOwnProperty.call(headers, name)) return name;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name) return key;
  }
  return null;
}

/**
 * @param {Object} input
 * @returns {Object}
 */
function cloneInput(input) {
  return {
    request: Object.assign({}, input.request, {
      headers: Object.assign({}, input.request.headers),
    }),
    response: Object.assign({}, input.response, {
      headers: Object.assign({}, input.response.headers),
    }),
    options: Object.assign({}, input.options || {}),
  };
}

/**
 * Apply a mutation to the response Cache-Control header, preserving the original
 * key casing.
 * @param {Object} input
 * @param {(cc: Record<string,string|true>) => void} mutate
 * @returns {Object}
 */
function withResponseDirectives(input, mutate) {
  const next = cloneInput(input);
  const key = findHeaderKey(next.response.headers, 'cache-control');
  const parsed = parseCacheControl(
    key ? next.response.headers[key] : undefined
  );
  const cc = Object.assign({}, parsed.upstreamView);
  mutate(cc);
  const formatted = formatCacheControl(cc);
  const targetKey = key || 'cache-control';
  if (formatted === undefined) delete next.response.headers[targetKey];
  else next.response.headers[targetKey] = formatted;
  return next;
}

/**
 * Measure an input with the real engine.
 * @param {Object} input
 * @param {{now:number, responseTime:number}} env
 * @param {Function} Ctor
 * @returns {Object}
 */
function measure(input, env, Ctor) {
  let policy;
  try {
    policy = buildPolicy(input, env, Ctor);
  } catch (error) {
    return { error: error.message, storable: undefined, maxAge: undefined, timeToLive: undefined, reuse: undefined };
  }

  const safe = (fn) => {
    try {
      return fn();
    } catch (error) {
      return undefined;
    }
  };

  const evaluation = safe(() => policy.evaluateRequest(input.request));
  return {
    storable: safe(() => policy.storable()),
    maxAge: safe(() => policy.maxAge()),
    timeToLive: safe(() => policy.timeToLive()),
    reuse: evaluation ? evaluation.response !== undefined : undefined,
    synchronous: evaluation && evaluation.revalidation
      ? evaluation.revalidation.synchronous
      : undefined,
  };
}

/**
 * @typedef {Object} Fix
 * @property {string} id
 * @property {string} title
 * @property {'low'|'medium'|'high'} risk
 * @property {string} riskNote
 * @property {Object} change
 * @property {Object} effect
 * @property {boolean} verified
 */

/**
 * Score a change. Reuse wins over storability, which wins over a longer TTL,
 * because that is the order in which the three actually help a CDN.
 *
 * A TTL increase only counts when the entry is currently short-lived. Without
 * that floor the analyser would happily recommend lengthening an asset that is
 * already cached for a year, which is not a fix, it is churn.
 * @param {Object} before
 * @param {Object} after
 * @returns {{score: number, improved: boolean, axes: Object}}
 */
function scoreChange(before, after) {
  const axes = {};
  let score = 0;

  if (before.reuse === false && after.reuse === true) {
    axes.reuse = { from: false, to: true };
    score += 1e9;
  }

  if (before.storable === false && after.storable === true) {
    axes.storable = { from: false, to: true };
    score += 1e6;
  }

  const ttlBefore = typeof before.timeToLive === 'number' ? before.timeToLive : 0;
  const ttlAfter = typeof after.timeToLive === 'number' ? after.timeToLive : 0;
  if (ttlBefore < TTL_WORTH_IMPROVING_MS && ttlAfter > ttlBefore + 999) {
    axes.timeToLive = { from: ttlBefore, to: ttlAfter };
    score += Math.min(ttlAfter - ttlBefore, 5e5);
  }

  return { score, improved: score > 0, axes };
}

/**
 * Enumerate single-variable interventions.
 * @param {Object} input
 * @returns {Array<{id:string, title:string, risk:string, riskNote:string, change:Object, apply:Function}>}
 */
function enumerateInterventions(input) {
  const out = [];
  const resHeaders = input.response.headers;
  const resCCKey = findHeaderKey(resHeaders, 'cache-control');
  const resCC = parseCacheControl(resCCKey ? resHeaders[resCCKey] : undefined).upstreamView;
  const reqCCKey = findHeaderKey(input.request.headers, 'cache-control');
  const reqCC = parseCacheControl(reqCCKey ? input.request.headers[reqCCKey] : undefined).upstreamView;

  const removals = [
    ['no-store', 'high', 'The origin explicitly forbade storing this response. Removing the ' +
      'directive makes caches keep data the origin asked them to discard.'],
    ['no-cache', 'high', 'no-cache forces revalidation before every reuse. Removing it lets ' +
      'caches serve the body without asking the origin whether it is still current.'],
    ['private', 'high', 'private exists to keep a response out of shared caches. Removing it ' +
      'can serve one user\'s response to another.'],
    ['must-revalidate', 'medium', 'must-revalidate prevents serving stale data when the origin ' +
      'is unreachable. Removing it trades correctness for availability.'],
    ['proxy-revalidate', 'medium', 'Removing it relaxes shared-cache staleness handling.'],
    ['max-age', 'medium', 'Removing max-age drops the response to heuristic freshness, which ' +
      'is usually shorter and less predictable.'],
  ];

  for (const [name, risk, riskNote] of removals) {
    if (resCC[name] === undefined) continue;
    out.push({
      id: `remove-response-directive:${name}`,
      title: `Remove Cache-Control: ${name} from the response`,
      risk,
      riskNote,
      change: { target: 'response.cache-control', remove: name },
      apply: (base) => withResponseDirectives(base, (cc) => { delete cc[name]; }),
    });
  }

  if (resCC.public === undefined) {
    out.push({
      id: 'add-response-directive:public',
      title: 'Add Cache-Control: public to the response',
      risk: 'medium',
      riskNote: 'public marks the response as shareable even when it carries Authorization, ' +
        'and overrides the shared-cache Set-Cookie policy in this engine.',
      change: { target: 'response.cache-control', add: 'public' },
      apply: (base) => withResponseDirectives(base, (cc) => { cc.public = true; }),
    });
  }

  if (resCC.immutable === undefined) {
    out.push({
      id: 'add-response-directive:immutable',
      title: 'Add Cache-Control: immutable to the response',
      risk: 'medium',
      riskNote: 'immutable tells caches the body will never change at this URL. Only correct ' +
        'for content-addressed or fingerprinted assets.',
      change: { target: 'response.cache-control', add: 'immutable' },
      apply: (base) => withResponseDirectives(base, (cc) => { cc.immutable = true; }),
    });
  }

  if (resCC['s-maxage'] === undefined) {
    out.push({
      id: 'add-response-directive:s-maxage',
      title: 'Add Cache-Control: s-maxage=3600 to the response',
      risk: 'low',
      riskNote: 's-maxage only affects shared caches and leaves browser behaviour unchanged.',
      change: { target: 'response.cache-control', add: 's-maxage', value: '3600' },
      apply: (base) => withResponseDirectives(base, (cc) => { cc['s-maxage'] = '3600'; }),
    });
  }

  const tune = [
    ['max-age', 'low', 'Lengthening max-age directly extends how long a stale body may be served.'],
    ['s-maxage', 'low', 'Lengthening s-maxage extends shared-cache freshness only.'],
  ];

  for (const [name, risk, riskNote] of tune) {
    if (resCC[name] === undefined) continue;
    for (const value of MAX_AGE_CANDIDATES) {
      if (String(directiveAsString(resCC[name])) === String(value)) continue;
      out.push({
        id: `set-response-directive:${name}=${value}`,
        title: `Set Cache-Control: ${name}=${value}`,
        risk,
        riskNote,
        change: { target: 'response.cache-control', set: name, value: String(value) },
        apply: (base) =>
          withResponseDirectives(base, (cc) => { cc[name] = String(value); }),
      });
    }
  }

  const headerRemovals = [
    ['set-cookie', 'high', 'Set-Cookie is how the response keeps users apart. Dropping it to ' +
      'satisfy a shared cache can leak one session\'s response to another user.'],
    ['vary', 'high', 'Vary is the mechanism that stops a cache from serving content negotiated ' +
      'for one request to a different one. Removing it can mix representations.'],
    ['age', 'medium', 'Removing Age resets the apparent age, which makes the entry look fresher ' +
      'than it is.'],
    ['expires', 'medium', 'Expires was already controlling the lifetime; removing it falls back ' +
      'to heuristics.'],
  ];

  for (const [name, risk, riskNote] of headerRemovals) {
    const key = findHeaderKey(resHeaders, name);
    if (!key) continue;
    out.push({
      id: `remove-response-header:${name}`,
      title: `Remove the ${name} response header`,
      risk,
      riskNote,
      change: { target: 'response.headers', remove: name },
      apply: (base) => {
        const next = cloneInput(base);
        const k = findHeaderKey(next.response.headers, name);
        if (k) delete next.response.headers[k];
        return next;
      },
    });
  }

  if (reqCC['no-cache'] !== undefined) {
    out.push({
      id: 'remove-request-directive:no-cache',
      title: 'Remove Cache-Control: no-cache from the request',
      risk: 'medium',
      riskNote: 'The client asked for a validated response; removing it serves possibly stale ' +
        'content to that client.',
      change: { target: 'request.cache-control', remove: 'no-cache' },
      apply: (base) => {
        const next = cloneInput(base);
        const key = findHeaderKey(next.request.headers, 'cache-control');
        const cc = Object.assign(
          {},
          parseCacheControl(key ? next.request.headers[key] : undefined).upstreamView
        );
        delete cc['no-cache'];
        const formatted = formatCacheControl(cc);
        if (formatted === undefined) delete next.request.headers[key || 'cache-control'];
        else next.request.headers[key || 'cache-control'] = formatted;
        return next;
      },
    });
  }

  if (input.request.headers.authorization) {
    out.push({
      id: 'remove-request-header:authorization',
      title: 'Remove the Authorization request header',
      risk: 'high',
      riskNote: 'The request is authenticated. Dropping the header to make a shared cache accept ' +
        'it changes who the response belongs to.',
      change: { target: 'request.headers', remove: 'authorization' },
      apply: (base) => {
        const next = cloneInput(base);
        const k = findHeaderKey(next.request.headers, 'authorization');
        if (k) delete next.request.headers[k];
        return next;
      },
    });
  }

  const status = 'status' in input.response ? input.response.status : 200;
  if (status !== 200) {
    out.push({
      id: 'set-response-status:200',
      title: 'Treat the response as status 200',
      risk: 'high',
      riskNote: 'The status code is part of what the origin said. Changing it to satisfy a cache ' +
        'is a rewrite of the response, not a header fix.',
      change: { target: 'response.status', set: 200 },
      apply: (base) => {
        const next = cloneInput(base);
        next.response.status = 200;
        return next;
      },
    });
  }

  return out;
}

/**
 * @param {*} v
 * @returns {string}
 */
function directiveAsString(v) {
  return v === true ? 'true' : String(v);
}

/**
 * @typedef {Object} CounterfactualOptions
 * @property {number} [now]
 * @property {number} [responseTime]
 * @property {number} [limit] how many verified fixes to return (default 8)
 * @property {Function} [CachePolicy] injectable upstream constructor
 */

/**
 * @param {Object} input
 * @param {CounterfactualOptions} [opts]
 * @returns {Object}
 */
function counterfactual(input, opts = {}) {
  const now = opts.now === undefined ? Date.now() : opts.now;
  const responseTime = opts.responseTime === undefined ? now : opts.responseTime;
  const env = { now, responseTime };
  const Ctor = opts.CachePolicy;
  const limit = opts.limit === undefined ? 8 : opts.limit;

  const baseline = measure(input, env, Ctor);
  const interventions = enumerateInterventions(input);

  const fixes = [];
  const ineffective = [];

  for (const intervention of interventions) {
    let mutated;
    try {
      mutated = intervention.apply(input);
    } catch (error) {
      continue;
    }
    const after = measure(mutated, env, Ctor);
    const scored = scoreChange(baseline, after);
    if (scored.improved) {
      fixes.push({
        id: intervention.id,
        title: intervention.title,
        risk: intervention.risk,
        riskNote: intervention.riskNote,
        change: intervention.change,
        effect: {
          axes: scored.axes,
          before: {
            storable: baseline.storable,
            timeToLive: baseline.timeToLive,
            reuse: baseline.reuse,
          },
          after: {
            storable: after.storable,
            timeToLive: after.timeToLive,
            reuse: after.reuse,
          },
        },
        verified: true,
      });
    } else {
      ineffective.push(intervention.id);
    }
  }

  // Highest impact first; on a tie, prefer the lower-risk change.
  const riskRank = { low: 0, medium: 1, high: 2 };
  fixes.sort((a, b) => {
    const sa = scoreOf(a);
    const sb = scoreOf(b);
    if (sb !== sa) return sb - sa;
    return riskRank[a.risk] - riskRank[b.risk];
  });

  return {
    baseline,
    fixes: fixes.slice(0, limit),
    totalVerified: fixes.length,
    ineffective,
    tested: interventions.length,
  };
}

/**
 * Recompute a comparable score from a produced fix.
 * @param {Object} fix
 * @returns {number}
 */
function scoreOf(fix) {
  let score = 0;
  if (fix.effect.axes.reuse) score += 1e9;
  if (fix.effect.axes.storable) score += 1e6;
  if (fix.effect.axes.timeToLive) {
    score += Math.min(
      fix.effect.axes.timeToLive.to - fix.effect.axes.timeToLive.from,
      5e5
    );
  }
  return score;
}

module.exports = { counterfactual, enumerateInterventions, measure, findHeaderKey };

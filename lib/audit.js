'use strict';

/**
 * Batch auditing.
 *
 * The audit answers a different question from `explain`: not "why is this one
 * not cached" but "across this whole capture, where is caching costing us the
 * most". It therefore aggregates by finding code and by verified fix, and ranks
 * fixes by how many entries they would help.
 */

const { replay } = require('./replay');
const { buildPolicy } = require('./policy');
const { diffAgainstUpstream } = require('./differential');
const { detectRisks } = require('./risks');
const { counterfactual } = require('./counterfactual');
const { normalizeEntries } = require('./input');

/**
 * @param {number} ms
 * @returns {string} bucket label
 */
function ttlBucket(ms) {
  if (!(ms > 0)) return '0 (unusable)';
  if (ms <= 60_000) return '<= 1 min';
  if (ms <= 3_600_000) return '<= 1 hour';
  if (ms <= 86_400_000) return '<= 1 day';
  if (ms <= 31_536_000_000) return '<= 1 year';
  return '> 1 year';
}

/**
 * @typedef {Object} AuditOptions
 * @property {number} [now]
 * @property {boolean} [shared]
 * @property {number} [counterfactualLimit] max entries to run counterfactuals on
 * @property {Function} [CachePolicy]
 * @property {boolean} [includeEntries] include per-entry rows
 */

/**
 * @param {Array|Object|string} source entries, HAR object, or NDJSON text
 * @param {AuditOptions} [opts]
 * @returns {Object}
 */
function audit(source, opts = {}) {
  const entries = normalizeEntries(source);
  const now = opts.now === undefined ? Date.now() : opts.now;
  const cfLimit = opts.counterfactualLimit === undefined ? 200 : opts.counterfactualLimit;

  const findingCounts = new Map();
  const fixAgg = new Map();
  const storage = { storable: 0, notStorable: 0 };
  // Three distinct outcomes, because they need different fixes:
  //   reusable  - served from cache without contacting the origin
  //   dead      - stored, given a lifetime, and never reusable (wasted storage)
  //   unusable  - either not storable at all, or storable with no lifetime left
  const reuseState = { reusable: 0, dead: 0, unusable: 0 };
  const buckets = new Map();
  const rows = [];
  let divergenceCount = 0;
  let engineErrors = 0;
  let counterfactualsRun = 0;

  entries.forEach((entry, index) => {
    const id = entry.id || entry.url || `entry-${index}`;

    let explained;
    try {
      explained = buildExplanation(entry, now, opts);
    } catch (error) {
      engineErrors += 1;
      rows.push({ id, url: entry.url, error: error.message });
      return;
    }

    const v = explained.verdict;
    if (v.storable) storage.storable += 1;
    else storage.notStorable += 1;

    if (v.reuse) reuseState.reusable += 1;
    else if (v.storable && v.timeToLive > 0) reuseState.dead += 1;
    else reuseState.unusable += 1;

    const bucket = ttlBucket(v.timeToLive);
    buckets.set(bucket, (buckets.get(bucket) || 0) + 1);

    if (!explained.consistent) divergenceCount += 1;

    for (const finding of explained.risks) {
      const agg = findingCounts.get(finding.code) || {
        code: finding.code,
        severity: finding.severity,
        title: finding.title,
        detail: finding.detail,
        count: 0,
        samples: [],
      };
      agg.count += 1;
      if (agg.samples.length < 5) agg.samples.push(id);
      findingCounts.set(finding.code, agg);
    }

    // Only spend counterfactual budget where there is something to gain.
    const worthFixing = !v.reuse || v.timeToLive === 0;
    if (worthFixing && counterfactualsRun < cfLimit) {
      counterfactualsRun += 1;
      let cf;
      try {
        cf = counterfactual(entry, {
          now,
          responseTime: now - (entry.ageSeconds || 0) * 1000,
          limit: 3,
          CachePolicy: opts.CachePolicy,
        });
      } catch (error) {
        cf = { fixes: [] };
      }
      for (const fix of cf.fixes) {
        const agg = fixAgg.get(fix.id) || {
          id: fix.id,
          title: fix.title,
          risk: fix.risk,
          riskNote: fix.riskNote,
          affected: 0,
          examples: [],
          gainMs: 0,
        };
        agg.affected += 1;
        const gain =
          fix.effect.axes.timeToLive
            ? fix.effect.axes.timeToLive.to - fix.effect.axes.timeToLive.from
            : 0;
        agg.gainMs += gain;
        if (agg.examples.length < 5) agg.examples.push(id);
        fixAgg.set(fix.id, agg);
      }
    }

    if (opts.includeEntries) {
      rows.push({
        id,
        url: entry.url,
        storable: v.storable,
        maxAge: v.maxAge,
        timeToLive: v.timeToLive,
        reuse: v.reuse,
        risks: explained.risks.map((r) => r.code),
        consistent: explained.consistent,
      });
    } else {
      rows.push({ id, url: entry.url, storable: v.storable, timeToLive: v.timeToLive });
    }
  });

  const riskRank = { low: 0, medium: 1, high: 2 };
  const recommendations = Array.from(fixAgg.values())
    .sort((a, b) => {
      if (b.affected !== a.affected) return b.affected - a.affected;
      if (b.gainMs !== a.gainMs) return b.gainMs - a.gainMs;
      return riskRank[a.risk] - riskRank[b.risk];
    })
    .slice(0, 10);

  return {
    total: entries.length,
    engineErrors,
    consistentCount: entries.length - divergenceCount - engineErrors,
    divergenceCount,
    storage,
    reuseState,
    ttlBuckets: Object.fromEntries(buckets),
    findings: Array.from(findingCounts.values()).sort(
      (a, b) =>
        severityRank(b.severity) - severityRank(a.severity) || b.count - a.count
    ),
    recommendations,
    counterfactualsRun,
    entries: rows,
  };
}

/**
 * @param {string} severity
 * @returns {number}
 */
function severityRank(severity) {
  return severity === 'critical' ? 2 : severity === 'warning' ? 1 : 0;
}

/**
 * Minimal single-entry explanation used by the audit (avoids the extra work of
 * the public `explain()` output shape).
 * @param {Object} entry
 * @param {number} now
 * @param {Object} opts
 * @returns {Object}
 */
function buildExplanation(entry, now, opts) {
  const env = { now, responseTime: now - (entry.ageSeconds || 0) * 1000 };
  const input = { request: entry.request, response: entry.response, options: entry.options };
  if (opts.shared !== undefined) {
    input.options = Object.assign({}, input.options, { shared: opts.shared });
  }
  const replayed = replay(input, env);
  let consistent = true;
  try {
    const policy = buildPolicy(input, env, opts.CachePolicy);
    const diff = diffAgainstUpstream(policy, replayed, input.request);
    consistent = diff.divergences.length === 0;
  } catch (error) {
    consistent = false;
  }
  return {
    verdict: replayed.verdict,
    consistent,
    risks: detectRisks(input, replayed),
  };
}

module.exports = { audit, ttlBucket };

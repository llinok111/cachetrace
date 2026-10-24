'use strict';

/**
 * Differential verification.
 *
 * The replay in `lib/replay.js` is an independent implementation, which means it
 * can drift from upstream. Every public entry point therefore runs both and
 * compares. A divergence is surfaced, never smoothed over: if cachetrace says a
 * response is cacheable and the engine says it is not, the caller needs to know
 * that the explanation cannot be trusted for this input.
 */

const TTL_TOLERANCE_MS = 1;
const SECONDS_TOLERANCE = 1e-9;

/**
 * @param {number} a
 * @param {number} b
 * @param {number} tol
 * @returns {boolean}
 */
function closeEnough(a, b, tol) {
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  return Math.abs(a - b) <= tol;
}

/**
 * Run upstream methods, capturing throws instead of propagating them.
 * @template T
 * @param {() => T} fn
 * @returns {{ok: boolean, value?: T, error?: string}}
 */
function attempt(fn) {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
}

/**
 * @typedef {Object} Divergence
 * @property {string} field
 * @property {*} replay
 * @property {*} upstream
 * @property {string} detail
 */

/**
 * Compare a replay result against a live upstream CachePolicy.
 *
 * The policy must have been constructed from the same input and with the same
 * clock (see `lib/policy.js`), otherwise time-dependent fields will differ for
 * reasons unrelated to the rules.
 *
 * @param {Object} policy upstream CachePolicy instance
 * @param {Object} replayed result of `replay()`
 * @param {Object} request the request used for reuse evaluation
 * @returns {{divergences: Divergence[], upstream: Object}}
 */
function diffAgainstUpstream(policy, replayed, request) {
  const divergences = [];
  const upstream = {};

  const storable = attempt(() => policy.storable());
  upstream.storable = storable.ok ? storable.value : storable.error;
  if (storable.ok && storable.value !== replayed.verdict.storable) {
    divergences.push({
      field: 'storable',
      replay: replayed.verdict.storable,
      upstream: storable.value,
      detail:
        'The replay disagrees with the engine about whether this response may be stored. ' +
        'Treat the trace as unreliable for this input and report it upstream.',
    });
  }

  const maxAge = attempt(() => policy.maxAge());
  upstream.maxAge = maxAge.ok ? maxAge.value : maxAge.error;
  if (maxAge.ok && !closeEnough(maxAge.value, replayed.verdict.maxAge, SECONDS_TOLERANCE)) {
    divergences.push({
      field: 'maxAge',
      replay: replayed.verdict.maxAge,
      upstream: maxAge.value,
      detail: 'Freshness lifetime differs between the replay and the engine.',
    });
  }

  const ttl = attempt(() => policy.timeToLive());
  upstream.timeToLive = ttl.ok ? ttl.value : ttl.error;
  if (ttl.ok && !closeEnough(ttl.value, replayed.verdict.timeToLive, TTL_TOLERANCE_MS)) {
    divergences.push({
      field: 'timeToLive',
      replay: replayed.verdict.timeToLive,
      upstream: ttl.value,
      detail: 'Time-to-live differs between the replay and the engine.',
    });
  }

  const evaluation = attempt(() => policy.evaluateRequest(request));
  if (evaluation.ok) {
    const upstreamReuse = evaluation.value.response !== undefined;
    upstream.reuse = upstreamReuse;
    upstream.revalidationSynchronous = evaluation.value.revalidation
      ? evaluation.value.revalidation.synchronous
      : undefined;
    if (upstreamReuse !== replayed.verdict.reuse) {
      divergences.push({
        field: 'reuse',
        replay: replayed.verdict.reuse,
        upstream: upstreamReuse,
        detail: 'The replay disagrees with the engine about serving this request from cache.',
      });
    }
    if (
      evaluation.value.revalidation &&
      replayed.verdict.revalidationSynchronous !== undefined &&
      evaluation.value.revalidation.synchronous !== replayed.verdict.revalidationSynchronous
    ) {
      divergences.push({
        field: 'revalidation.synchronous',
        replay: replayed.verdict.revalidationSynchronous,
        upstream: evaluation.value.revalidation.synchronous,
        detail: 'Revalidation mode (synchronous vs stale-while-revalidate) differs.',
      });
    }
  } else {
    upstream.reuse = undefined;
    upstream.evaluateError = evaluation.error;
    divergences.push({
      field: 'evaluateRequest',
      replay: replayed.verdict.reuse,
      upstream: `threw: ${evaluation.error}`,
      detail:
        'The engine threw while evaluating this request. cachetrace reports the replay result, ' +
        'but the engine will fail in production for the same input.',
    });
  }

  return { divergences, upstream };
}

module.exports = { diffAgainstUpstream };

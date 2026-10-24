'use strict';

/**
 * Upstream policy construction with a pinned clock.
 *
 * cachetrace has to evaluate the engine and its own replay at exactly the same
 * instant, otherwise age-dependent fields differ for reasons that have nothing to
 * do with the rules and every comparison becomes noise. Upstream exposes
 * `toObject()` / `fromObject()`, and the serialised form carries the response
 * timestamp, so the clock is pinned through that public surface rather than by
 * writing private fields directly.
 */

/**
 * Resolve the upstream module, failing with an actionable message.
 * @returns {Function} CachePolicy constructor
 */
function requireUpstream() {
  try {
    // eslint-disable-next-line global-require
    return require('http-cache-semantics');
  } catch (error) {
    const err = new Error(
      'cachetrace needs http-cache-semantics to be installed (it is a peer dependency, ' +
        'because the explanation must match the engine the caller actually runs). ' +
        'Install it with: npm install http-cache-semantics'
    );
    err.cause = error;
    throw err;
  }
}

/**
 * Construct an upstream policy whose notion of "now" equals `env`.
 *
 * @param {Object} input replay input ({request, response, options})
 * @param {{now: number, responseTime: number}} env
 * @param {Function} [CachePolicy] injectable constructor for tests
 * @returns {Object} policy instance
 */
function buildPolicy(input, env, CachePolicy) {
  const Ctor = CachePolicy || requireUpstream();
  const policy = new Ctor(input.request, input.response, input.options || {});

  let pinned = policy;
  try {
    const serialised = policy.toObject();
    serialised.t = env.responseTime;
    pinned = Ctor.fromObject(serialised);
  } catch (error) {
    // Older releases may not have toObject/fromObject; fall back to the instance
    // we already built and pin the timestamp on it.
    pinned = policy;
    pinned._responseTime = env.responseTime;
  }

  pinned.now = () => env.now;
  return pinned;
}

module.exports = { buildPolicy, requireUpstream };

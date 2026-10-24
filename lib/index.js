'use strict';

const { replay } = require('./replay');
const { buildPolicy } = require('./policy');
const { diffAgainstUpstream } = require('./differential');
const { detectRisks } = require('./risks');
const { counterfactual } = require('./counterfactual');
const { audit } = require('./audit');
const { renderText, renderMarkdown, renderAuditText, renderAuditMarkdown, renderCounterfactualText, renderCounterfactualMarkdown } = require('./report');
const { parseHAR, parseNDJSON, normalizeEntries } = require('./input');

/**
 * Resolve the evaluation instant.
 * @param {Object} input
 * @param {Object} opts
 * @returns {{now: number, responseTime: number}}
 */
function resolveEnv(input, opts = {}) {
  const now = opts.now !== undefined ? opts.now : Date.now();
  let responseTime = opts.responseTime;
  if (responseTime === undefined) {
    const ageSeconds =
      opts.ageSeconds !== undefined
        ? opts.ageSeconds
        : input && input.ageSeconds !== undefined
        ? input.ageSeconds
        : undefined;
    responseTime = ageSeconds === undefined ? now : now - ageSeconds * 1000;
  }
  return { now, responseTime };
}

/**
 * Explain a single request/response pair.
 *
 * @param {Object} input
 * @param {{now?: number, responseTime?: number, ageSeconds?: number, CachePolicy?: Function}} [opts]
 * @returns {Object}
 */
function explain(input, opts = {}) {
  if (!input || !input.request || !input.response) {
    throw new TypeError('explain() needs { request, response }');
  }
  const env = resolveEnv(input, opts);
  const replayed = replay(input, env);

  let divergences = [];
  let upstream = {};
  try {
    const policy = buildPolicy(input, env, opts.CachePolicy);
    const diff = diffAgainstUpstream(policy, replayed, input.request);
    divergences = diff.divergences;
    upstream = diff.upstream;
  } catch (error) {
    divergences = [
      {
        field: 'engine',
        replay: undefined,
        upstream: undefined,
        detail: `Could not evaluate with http-cache-semantics: ${error.message}`,
      },
    ];
  }

  const risks = detectRisks(input, replayed);

  return {
    input,
    clock: env,
    verdict: replayed.verdict,
    upstream,
    divergences,
    consistent: divergences.length === 0,
    risks,
    traces: replayed.traces,
    parsed: replayed.parsed,
    constructorNotes: replayed.constructorNotes,
    state: replayed.state,
  };
}

module.exports = {
  explain,
  replay,
  counterfactual,
  audit,
  renderText,
  renderMarkdown,
  renderAuditText,
  renderAuditMarkdown,
  renderCounterfactualText,
  renderCounterfactualMarkdown,
  parseHAR,
  parseNDJSON,
  normalizeEntries,
  detectRisks,
  resolveEnv,
};

'use strict';

/**
 * Rendering.
 *
 * Two formats: plain text for a terminal, Markdown for a report that gets pasted
 * into a ticket. Neither is decorative. The trace is printed in evaluation order
 * with the observed input beside each node, because the value that a rule acted on
 * is usually the thing that was wrong.
 */

const { renderTree } = require('./trace');

const SEVERITY_LABEL = {
  critical: '[CRITICAL]',
  warning: '[WARNING]',
  info: '[INFO]',
};

const RISK_LABEL = {
  low: 'low',
  medium: 'medium',
  high: 'high',
};

/**
 * @param {number} ms
 * @returns {string}
 */
function humanMs(ms) {
  if (ms === undefined || ms === null) return 'n/a';
  if (!(ms > 0)) return '0';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${round(s)}s`;
  const m = s / 60;
  if (m < 60) return `${round(m)}m`;
  const h = m / 60;
  if (h < 24) return `${round(h)}h`;
  return `${round(h / 24)}d`;
}

/**
 * @param {number} n
 * @returns {string}
 */
function round(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/**
 * @param {Object} explained result of `explain()`
 * @returns {string}
 */
function renderText(explained) {
  const v = explained.verdict;
  const lines = [];
  const target =
    (explained.input.request.method || 'GET') + ' ' + (explained.input.request.url || '(no url)');

  lines.push(`cachetrace  ${target}`);
  lines.push('-'.repeat(64));
  lines.push(
    `verdict    storable=${v.storable}  maxAge=${round(v.maxAge)}s  ttl=${humanMs(
      v.timeToLive
    )}  reuse=${v.reuse}`
  );
  lines.push(
    `engine     ${
      explained.consistent
        ? 'replay agrees with http-cache-semantics'
        : `${explained.divergences.length} divergence(s) from http-cache-semantics`
    }`
  );

  if (explained.divergences.length) {
    lines.push('');
    lines.push('DIVERGENCES');
    for (const d of explained.divergences) {
      lines.push(`  ! ${d.field}: replay=${format(d.replay)} engine=${format(d.upstream)}`);
      lines.push(`    ${d.detail}`);
    }
  }

  if (explained.risks.length) {
    lines.push('');
    lines.push(`RISKS (${explained.risks.length})`);
    for (const risk of explained.risks) {
      lines.push(`  ${SEVERITY_LABEL[risk.severity] || risk.severity} ${risk.code}`);
      lines.push(`    ${risk.title}`);
      lines.push(`    evidence: ${risk.evidence}`);
    }
  }

  if (explained.constructorNotes.length) {
    lines.push('');
    lines.push('CONSTRUCTOR SIDE EFFECTS');
    for (const note of explained.constructorNotes) {
      lines.push(`  - ${note.kind}: ${note.detail}`);
    }
  }

  lines.push('');
  lines.push('DECISION TRACE');
  lines.push(renderTree(explained.traces.storable));
  lines.push('');
  lines.push(renderTree(explained.traces.maxAge));
  lines.push('');
  lines.push(renderTree(explained.traces.timeToLive));
  lines.push('');
  lines.push(renderTree(explained.traces.evaluateRequest));

  return lines.join('\n');
}

/**
 * @param {Object} explained
 * @returns {string}
 */
function renderMarkdown(explained) {
  const v = explained.verdict;
  const lines = [];
  const target = `\`${explained.input.request.method || 'GET'} ${
    explained.input.request.url || '(no url)'
  }\``;

  lines.push(`## cachetrace: ${target}`);
  lines.push('');
  lines.push('| field | value |');
  lines.push('| --- | --- |');
  lines.push(`| storable | ${v.storable} |`);
  lines.push(`| maxAge | ${round(v.maxAge)}s |`);
  lines.push(`| timeToLive | ${humanMs(v.timeToLive)} |`);
  lines.push(`| reuse without revalidation | ${v.reuse} |`);
  lines.push(
    `| engine agreement | ${explained.consistent ? 'consistent' : `${explained.divergences.length} divergence(s)`} |`
  );

  if (explained.divergences.length) {
    lines.push('');
    lines.push('### Divergences from http-cache-semantics');
    for (const d of explained.divergences) {
      lines.push(
        `- **${d.field}**: replay \`${format(d.replay)}\` vs engine \`${format(d.upstream)}\` — ${d.detail}`
      );
    }
  }

  if (explained.risks.length) {
    lines.push('');
    lines.push('### Risks');
    lines.push('');
    lines.push('| severity | code | title | evidence |');
    lines.push('| --- | --- | --- | --- |');
    for (const risk of explained.risks) {
      lines.push(
        `| ${risk.severity} | \`${risk.code}\` | ${risk.title} | \`${escapePipes(
          risk.evidence
        )}\` |`
      );
    }
  }

  lines.push('');
  lines.push('### Decision trace');
  lines.push('');
  lines.push('```');
  lines.push(renderTree(explained.traces.storable));
  lines.push('');
  lines.push(renderTree(explained.traces.maxAge));
  lines.push('');
  lines.push(renderTree(explained.traces.timeToLive));
  lines.push('');
  lines.push(renderTree(explained.traces.evaluateRequest));
  lines.push('```');

  return lines.join('\n');
}

/**
 * @param {Object} cf result of `counterfactual()`
 * @returns {string}
 */
function renderCounterfactualText(cf) {
  const lines = [];
  lines.push('counterfactual analysis');
  lines.push('-'.repeat(64));
  lines.push(
    `baseline   storable=${cf.baseline.storable}  ttl=${humanMs(
      cf.baseline.timeToLive
    )}  reuse=${cf.baseline.reuse}`
  );
  lines.push(`tested     ${cf.tested} single-variable changes, ${cf.totalVerified} verified improvement(s)`);
  lines.push('');

  if (!cf.fixes.length) {
    lines.push('No single header change flips this verdict. The cause is structural: it comes');
    lines.push('from the request method, the status code, or the absence of any freshness');
    lines.push('information rather than from one removable directive.');
    return lines.join('\n');
  }

  cf.fixes.forEach((fix, i) => {
    const axes = fix.effect.axes;
    const parts = [];
    if (axes.reuse) parts.push('reuse false -> true');
    if (axes.storable) parts.push('storable false -> true');
    if (axes.timeToLive) {
      parts.push(`ttl ${humanMs(axes.timeToLive.from)} -> ${humanMs(axes.timeToLive.to)}`);
    }
    lines.push(`${i + 1}. ${fix.title}   [risk: ${RISK_LABEL[fix.risk]}]`);
    lines.push(`   verified: ${parts.join(', ')}`);
    lines.push(`   ${fix.riskNote}`);
  });

  return lines.join('\n');
}

/**
 * @param {Object} cf
 * @returns {string}
 */
function renderCounterfactualMarkdown(cf) {
  const lines = [];
  lines.push('### Counterfactual analysis');
  lines.push('');
  lines.push(
    `Baseline: storable=${cf.baseline.storable}, ttl=${humanMs(
      cf.baseline.timeToLive
    )}, reuse=${cf.baseline.reuse}. Tested ${cf.tested} single-variable changes.`
  );
  lines.push('');
  if (!cf.fixes.length) {
    lines.push('No single header change flips this verdict.');
    return lines.join('\n');
  }
  lines.push('| # | change | risk | verified effect | caveat |');
  lines.push('| --- | --- | --- | --- | --- |');
  cf.fixes.forEach((fix, i) => {
    const axes = fix.effect.axes;
    const parts = [];
    if (axes.reuse) parts.push('reuse false to true');
    if (axes.storable) parts.push('storable false to true');
    if (axes.timeToLive) {
      parts.push(`ttl ${humanMs(axes.timeToLive.from)} to ${humanMs(axes.timeToLive.to)}`);
    }
    lines.push(
      `| ${i + 1} | ${fix.title} | ${fix.risk} | ${parts.join('; ')} | ${escapePipes(
        fix.riskNote
      )} |`
    );
  });
  return lines.join('\n');
}

/**
 * @param {Object} result result of `audit()`
 * @returns {string}
 */
function renderAuditText(result) {
  const lines = [];
  lines.push('cachetrace audit');
  lines.push('-'.repeat(64));
  lines.push(`entries        ${result.total}`);
  lines.push(`storable       ${result.storage.storable} yes / ${result.storage.notStorable} no`);
  lines.push(
    `reuse          ${result.reuseState.reusable} usable / ${result.reuseState.dead} stored-but-never-served / ` +
      `${result.reuseState.unusable} unusable`
  );
  lines.push(`engine         ${result.divergenceCount} divergence(s), ${result.engineErrors} error(s)`);

  lines.push('');
  lines.push('TTL distribution');
  for (const [bucket, count] of Object.entries(result.ttlBuckets)) {
    lines.push(`  ${bucket.padEnd(16)} ${count}`);
  }

  if (result.findings.length) {
    lines.push('');
    lines.push(`FINDINGS (${result.findings.length} kinds)`);
    for (const finding of result.findings) {
      lines.push(
        `  ${SEVERITY_LABEL[finding.severity] || finding.severity} ${finding.code}  x${finding.count}`
      );
      lines.push(`    ${finding.title}`);
      if (finding.samples.length) {
        lines.push(`    e.g. ${finding.samples.slice(0, 3).join(', ')}`);
      }
    }
  }

  if (result.recommendations.length) {
    lines.push('');
    lines.push('RECOMMENDATIONS (each verified by re-running the engine)');
    result.recommendations.forEach((rec, i) => {
      const gain = rec.gainMs > 0 ? `, +${humanMs(rec.gainMs)} total` : '';
      lines.push(
        `${i + 1}. ${rec.title}   [risk: ${RISK_LABEL[rec.risk]}]  affects ${rec.affected} entr${
          rec.affected === 1 ? 'y' : 'ies'
        }${gain}`
      );
    });
  }

  lines.push('');
  lines.push(
    `counterfactuals evaluated on ${result.counterfactualsRun} entr${
      result.counterfactualsRun === 1 ? 'y' : 'ies'
    }`
  );

  return lines.join('\n');
}

/**
 * @param {Object} result
 * @returns {string}
 */
function renderAuditMarkdown(result) {
  const lines = [];
  lines.push('## cachetrace audit');
  lines.push('');
  lines.push('| metric | value |');
  lines.push('| --- | --- |');
  lines.push(`| entries | ${result.total} |`);
  lines.push(`| storable | ${result.storage.storable} / ${result.total} |`);
  lines.push(`| stored but never served | ${result.reuseState.dead} |`);
  lines.push(`| unusable (unstorable or zero lifetime) | ${result.reuseState.unusable} |`);
  lines.push(`| engine divergences | ${result.divergenceCount} |`);

  lines.push('');
  lines.push('### TTL distribution');
  lines.push('');
  lines.push('| bucket | entries |');
  lines.push('| --- | --- |');
  for (const [bucket, count] of Object.entries(result.ttlBuckets)) {
    lines.push(`| ${bucket} | ${count} |`);
  }

  if (result.findings.length) {
    lines.push('');
    lines.push('### Findings');
    lines.push('');
    lines.push('| severity | code | count | title | example |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const f of result.findings) {
      lines.push(
        `| ${f.severity} | \`${f.code}\` | ${f.count} | ${escapePipes(f.title)} | ${
          f.samples[0] || ''
        } |`
      );
    }
  }

  if (result.recommendations.length) {
    lines.push('');
    lines.push('### Recommendations (verified)');
    lines.push('');
    lines.push('| # | change | risk | entries affected | caveat |');
    lines.push('| --- | --- | --- | --- | --- |');
    result.recommendations.forEach((rec, i) => {
      lines.push(
        `| ${i + 1} | ${rec.title} | ${rec.risk} | ${rec.affected} | ${escapePipes(rec.riskNote)} |`
      );
    });
  }

  return lines.join('\n');
}

/**
 * @param {*} value
 * @returns {string}
 */
function format(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === undefined) return 'undefined';
  return JSON.stringify(value);
}

/**
 * @param {string} text
 * @returns {string}
 */
function escapePipes(text) {
  return String(text == null ? '' : text).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

module.exports = {
  renderText,
  renderMarkdown,
  renderCounterfactualText,
  renderCounterfactualMarkdown,
  renderAuditText,
  renderAuditMarkdown,
  humanMs,
};

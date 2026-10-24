'use strict';

/**
 * Decision-tree primitives.
 *
 * A node answers exactly one question. `passed` is what the engine concluded,
 * `observed` is the input value it concluded that from, and `clause` points at
 * the specification text the rule comes from. Nodes are ordered the way the
 * engine evaluates them, not the way they read most naturally, so that the tree
 * can be diffed against a real evaluation step by step.
 */

/**
 * @typedef {Object} TraceNode
 * @property {string} id stable identifier, e.g. `storable.request-no-store`
 * @property {string} clause RFC section this rule implements
 * @property {string} question what is being decided
 * @property {*} observed the input the decision was made from
 * @property {boolean} passed outcome of this single check
 * @property {string} [note] why it passed or failed, in plain language
 * @property {boolean} [decisive] true when this check alone decided a short-circuit
 * @property {TraceNode[]} [children] nested checks
 */

/**
 * @param {Object} spec
 * @returns {TraceNode}
 */
function node(spec) {
  const out = {
    id: spec.id,
    clause: spec.clause,
    question: spec.question,
    observed: spec.observed,
    passed: !!spec.passed,
    note: spec.note,
  };
  if (spec.decisive) out.decisive = true;
  if (spec.children && spec.children.length) out.children = spec.children;
  return out;
}

/**
 * Collect every node whose `passed` is false.
 * @param {TraceNode} root
 * @returns {TraceNode[]}
 */
function failedNodes(root) {
  const out = [];
  const walk = (n) => {
    if (!n.passed) out.push(n);
    if (n.children) n.children.forEach(walk);
  };
  walk(root);
  return out;
}

/**
 * Depth-first search by node id.
 * @param {TraceNode} root
 * @param {string} id
 * @returns {TraceNode|undefined}
 */
function findNode(root, id) {
  if (!root) return undefined;
  if (root.id === id) return root;
  for (const child of root.children || []) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Render a tree as indented plain text.
 * @param {TraceNode} root
 * @param {Object} [opts]
 * @param {string} [opts.indent]
 * @returns {string}
 */
function renderTree(root, opts = {}) {
  const indent = opts.indent || '  ';
  const lines = [];
  const walk = (n, depth) => {
    const mark = n.passed ? 'PASS' : 'FAIL';
    const obs =
      n.observed === undefined
        ? ''
        : ` [${formatObserved(n.observed)}]`;
    lines.push(`${indent.repeat(depth)}${mark} ${n.id}${obs}`);
    lines.push(`${indent.repeat(depth + 1)}${n.question} (${n.clause})`);
    if (n.note) lines.push(`${indent.repeat(depth + 1)}-> ${n.note}`);
    for (const child of n.children || []) walk(child, depth + 1);
  };
  walk(root, 0);
  return lines.join('\n');
}

/**
 * Render an observed value compactly enough for a terminal line.
 * Strings are shown bare (they are usually header values) and long structures
 * are truncated, because a 200-character JSON blob on one line defeats the
 * purpose of reading the trace.
 * @param {*} value
 * @returns {string}
 */
function formatObserved(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value.length > 48 ? `${value.slice(0, 45)}...` : value;
  if (typeof value === 'object') {
    const json = JSON.stringify(value);
    return json.length > 96 ? `${json.slice(0, 93)}...` : json;
  }
  return String(value);
}

module.exports = { node, failedNodes, findNode, renderTree };

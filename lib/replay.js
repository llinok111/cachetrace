'use strict';

/**
 * Independent replay of the http-cache-semantics 4.3.0 decision rules.
 *
 * The replay deliberately mirrors upstream semantics rather than an idealised
 * reading of RFC 9111. A trace is only useful if it explains the verdict the
 * caller's CDN will actually reach, so where upstream deviates from the spec the
 * replay deviates identically and says so through `upstreamPolicy: true`.
 * `lib/differential.js` checks that mirrored conclusion against upstream itself.
 *
 * Two differences from upstream are intentional and do not change any verdict:
 *   1. every check is evaluated, never short-circuited, so the caller can see
 *      all failing conditions at once instead of only the first one;
 *   2. each check emits a node carrying the input value it was decided from.
 */

const { parseCacheControl } = require('./directives');
const { node } = require('./trace');

const STATUS_CACHEABLE_BY_DEFAULT = new Set([
  200, 203, 204, 206, 300, 301, 308, 404, 405, 410, 414, 501,
]);

const STATUS_UNDERSTOOD = new Set([
  200, 203, 204, 300, 301, 302, 303, 307, 308, 404, 405, 410, 414, 501,
]);

const DEFAULT_IMMUTABLE_MIN_TTL = 24 * 3600 * 1000;

/**
 * `parseInt` that yields 0 for anything unparseable, matching upstream.
 * @param {*} s
 * @returns {number}
 */
function toNumberOrZero(s) {
  const n = parseInt(s, 10);
  return isFinite(n) ? n : 0;
}

/**
 * @param {string|undefined} header
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
 * @typedef {Object} ReplayInput
 * @property {{url?: string, method?: string, headers: Record<string,string>}} request
 * @property {{status?: number, headers: Record<string,string>}} response
 * @property {Object} [options] upstream CachePolicy options
 */

/**
 * @param {ReplayInput} input
 * @param {Object} [env]
 * @param {number} [env.now] evaluation instant, ms epoch
 * @param {number} [env.responseTime] when the response was received, ms epoch
 * @param {Object} [env.request] the request being evaluated for reuse; defaults to
 *   the request that produced the stored response
 * @returns {Object}
 */
function replay(input, env = {}) {
  const request = (input && input.request) || {};
  const response = (input && input.response) || {};
  const options = (input && input.options) || {};
  const evalRequest = env.request || request;

  if (!request.headers || typeof request.headers !== 'object') {
    throw new TypeError('input.request.headers is required');
  }
  if (!response.headers || typeof response.headers !== 'object') {
    throw new TypeError('input.response.headers is required');
  }
  if (!evalRequest.headers || typeof evalRequest.headers !== 'object') {
    throw new TypeError('env.request.headers is required when env.request is supplied');
  }

  const now = env.now === undefined ? Date.now() : env.now;
  const responseTime = env.responseTime === undefined ? now : env.responseTime;

  const isShared = options.shared !== false;
  const cacheHeuristic =
    options.cacheHeuristic !== undefined ? options.cacheHeuristic : 0.1;
  const immutableMinTtl =
    options.immutableMinTimeToLive !== undefined
      ? options.immutableMinTimeToLive
      : DEFAULT_IMMUTABLE_MIN_TTL;
  const ignoreCargoCult = !!options.ignoreCargoCult;

  const status = 'status' in response ? response.status : 200;
  const method = 'method' in request ? request.method : 'GET';
  const url = request.url;
  const host = request.headers.host;
  const noAuthorization = !request.headers.authorization;

  let resHeaders = response.headers;
  const resCC = parseCacheControl(response.headers['cache-control']);
  const reqCC = parseCacheControl(request.headers['cache-control']);
  let rescc = resCC.upstreamView;

  const reqHeaders = response.headers.vary ? request.headers : null;

  // -- upstream constructor side effects, reproduced ------------------------
  const ctorNotes = [];
  if (ignoreCargoCult && 'pre-check' in rescc && 'post-check' in rescc) {
    delete rescc['pre-check'];
    delete rescc['post-check'];
    delete rescc['no-cache'];
    delete rescc['no-store'];
    delete rescc['must-revalidate'];
    resHeaders = Object.assign({}, resHeaders, {
      'cache-control': formatCacheControl(rescc),
    });
    delete resHeaders.expires;
    delete resHeaders.pragma;
    ctorNotes.push({
      kind: 'cargo-cult-override',
      detail:
        'ignoreCargoCult removed pre-check/post-check and also dropped no-cache, no-store ' +
        'and must-revalidate from the response directives.',
    });
  }
  if (resHeaders['cache-control'] == null && /no-cache/.test(resHeaders.pragma)) {
    rescc['no-cache'] = true;
    ctorNotes.push({
      kind: 'pragma-no-cache',
      detail:
        'No Cache-Control was present, so Pragma: no-cache was treated as Cache-Control: ' +
        'no-cache (RFC 9111 §5.4).',
    });
  }

  const state = {
    now,
    responseTime,
    isShared,
    cacheHeuristic,
    immutableMinTtl,
    ignoreCargoCult,
    status,
    method,
    url,
    host,
    noAuthorization,
    resHeaders,
    rescc,
    reqcc: reqCC.upstreamView,
    reqHeaders,
    requestHeaders: request.headers,
  };

  const storableTrace = traceStorable(state);
  const maxAgeTrace = traceMaxAge(state, storableTrace.value);
  const ageTrace = traceAge(state);
  const ttlTrace = traceTimeToLive(state, maxAgeTrace.value, ageTrace.value);
  state.__age = ageTrace.value;
  state.__maxAge = maxAgeTrace.value;
  const evalTrace = traceEvaluateRequest(state, evalRequest);

  return {
    input: { request, response, options },
    parsed: { response: resCC, request: reqCC },
    constructorNotes: ctorNotes,
    verdict: {
      storable: storableTrace.value,
      maxAge: maxAgeTrace.value,
      age: ageTrace.value,
      timeToLive: ttlTrace.value,
      reuse: evalTrace.value.response !== undefined,
      revalidationRequired: !!evalTrace.value.revalidation,
      revalidationSynchronous: evalTrace.value.revalidation
        ? evalTrace.value.revalidation.synchronous
        : undefined,
      status,
    },
    traces: {
      storable: storableTrace.node,
      maxAge: maxAgeTrace.node,
      age: ageTrace.node,
      timeToLive: ttlTrace.node,
      evaluateRequest: evalTrace.node,
    },
    state,
  };
}

// ---------------------------------------------------------------------------
// storable()
// ---------------------------------------------------------------------------

/**
 * @param {Object} s state
 * @returns {{value: boolean, node: Object}}
 */
function traceStorable(s) {
  const cc = s.rescc;
  const reqcc = s.reqcc;

  const checks = [];

  checks.push(
    node({
      id: 'storable.request-no-store',
      clause: 'RFC 9111 §5.2.2.5',
      question: 'Request does not carry Cache-Control: no-store',
      observed: reqcc['no-store'] === undefined ? '(absent)' : reqcc['no-store'],
      passed: !reqcc['no-store'],
      note: reqcc['no-store']
        ? 'The request forbids storing any part of the response.'
        : undefined,
    })
  );

  const methodOk =
    s.method === 'GET' ||
    s.method === 'HEAD' ||
    (s.method === 'POST' && hasExplicitExpiration(s));
  checks.push(
    node({
      id: 'storable.method',
      clause: 'RFC 9111 §3 / §9.2.1',
      question: 'Request method may be stored',
      observed: s.method,
      passed: methodOk,
      note: methodOk
        ? undefined
        : s.method === 'POST'
        ? 'POST is only storable when the response carries explicit freshness information.'
        : 'Only GET, HEAD and POST-with-explicit-freshness are understood.',
    })
  );

  const statusOk = STATUS_UNDERSTOOD.has(s.status);
  checks.push(
    node({
      id: 'storable.status-understood',
      clause: 'RFC 9111 §3',
      question: 'Response status is understood by the cache',
      observed: s.status,
      passed: statusOk,
      note: statusOk
        ? undefined
        : 'Upstream does not understand this status code, so it refuses to store it ' +
          '(note: 206 is listed as cacheable-by-default but not understood by this engine).',
    })
  );

  checks.push(
    node({
      id: 'storable.response-no-store',
      clause: 'RFC 9111 §5.2.1.5',
      question: 'Response does not carry Cache-Control: no-store',
      observed: cc['no-store'] === undefined ? '(absent)' : cc['no-store'],
      passed: !cc['no-store'],
      note: cc['no-store'] ? 'The response forbids storing it.' : undefined,
    })
  );

  const privateOk = !s.isShared || !cc.private;
  checks.push(
    node({
      id: 'storable.shared-private',
      clause: 'RFC 9111 §5.2.1.7',
      question: 'Shared cache is not blocked by Cache-Control: private',
      observed: { shared: s.isShared, private: cc.private || false },
      passed: privateOk,
      note: privateOk
        ? undefined
        : 'Cache-Control: private forbids a shared cache from storing this response.',
    })
  );

  const allowsAuth = allowsStoringAuthenticated(s);
  const authOk = !s.isShared || s.noAuthorization || allowsAuth;
  checks.push(
    node({
      id: 'storable.shared-authorization',
      clause: 'RFC 9111 §3.3',
      question: 'Shared cache may store an authenticated response',
      observed: {
        shared: s.isShared,
        hasAuthorization: !s.noAuthorization,
        allowsStoringAuthenticated: allowsAuth,
      },
      passed: authOk,
      note: authOk
        ? undefined
        : 'A shared cache must not store a response to a request with Authorization unless ' +
          'the response carries must-revalidate, public or s-maxage.',
    })
  );

  const freshness = explicitFreshnessChildren(s);
  const freshnessOk = freshness.passed;
  checks.push(
    node({
      id: 'storable.explicit-freshness',
      clause: 'RFC 9111 §3 / §4.2.2',
      question: 'Response carries explicit freshness or a default-cacheable status',
      observed: {
        status: s.status,
        expires: s.resHeaders.expires || null,
        maxAge: cc['max-age'] === undefined ? null : cc['max-age'],
        sMaxAge: cc['s-maxage'] === undefined ? null : cc['s-maxage'],
        public: cc.public || false,
      },
      passed: freshnessOk,
      children: freshness.children,
      note: freshnessOk ? undefined : freshness.note,
    })
  );

  const value = checks.every((c) => c.passed);
  const failing = checks.filter((c) => !c.passed).map((c) => c.id);

  return {
    value,
    node: node({
      id: 'storable',
      clause: 'RFC 9111 §3',
      question: 'May this response be stored at all?',
      observed: value,
      passed: value,
      children: checks,
      note: value
        ? 'All storage conditions hold.'
        : `Blocked by: ${failing.join(', ')}. Upstream short-circuits at the first of these, ` +
          `so only "${failing[0]}" would normally be visible.`,
    }),
  };
}

/**
 * Mirrors upstream `_hasExplicitExpiration()`.
 * @param {Object} s
 * @returns {boolean}
 */
function hasExplicitExpiration(s) {
  return !!(
    (s.isShared && s.rescc['s-maxage']) ||
    s.rescc['max-age'] ||
    s.resHeaders.expires
  );
}

/**
 * Mirrors upstream `_allowsStoringAuthenticated()`.
 * @param {Object} s
 * @returns {boolean}
 */
function allowsStoringAuthenticated(s) {
  return !!(
    s.rescc['must-revalidate'] ||
    s.rescc.public ||
    s.rescc['s-maxage']
  );
}

/**
 * Expands the final "either ... or" group of upstream `storable()`.
 * @param {Object} s
 * @returns {{passed: boolean, children: Object[], note: string|undefined}}
 */
function explicitFreshnessChildren(s) {
  const cc = s.rescc;
  const children = [
    node({
      id: 'storable.freshness.expires',
      clause: 'RFC 9111 §5.3',
      question: 'Response has an Expires header',
      observed: s.resHeaders.expires || '(absent)',
      passed: !!s.resHeaders.expires,
    }),
    node({
      id: 'storable.freshness.max-age',
      clause: 'RFC 9111 §5.2.1.1',
      question: 'Response has Cache-Control: max-age',
      observed: cc['max-age'] === undefined ? '(absent)' : cc['max-age'],
      passed: !!cc['max-age'],
      note:
        cc['max-age'] === '0'
          ? 'max-age=0 is a non-empty string, so upstream treats it as present even though ' +
            'it grants zero freshness.'
          : undefined,
    }),
    node({
      id: 'storable.freshness.s-maxage',
      clause: 'RFC 9111 §5.2.1.10',
      question: 'Shared cache sees Cache-Control: s-maxage',
      observed: { shared: s.isShared, sMaxAge: cc['s-maxage'] || null },
      passed: !!(s.isShared && cc['s-maxage']),
    }),
    node({
      id: 'storable.freshness.public',
      clause: 'RFC 9111 §5.2.1.9',
      question: 'Response has Cache-Control: public',
      observed: cc.public || false,
      passed: !!cc.public,
    }),
    node({
      id: 'storable.freshness.default-status',
      clause: 'RFC 7231 §6.1 (heuristic cacheability)',
      question: 'Status code is cacheable by default',
      observed: s.status,
      passed: STATUS_CACHEABLE_BY_DEFAULT.has(s.status),
    }),
  ];
  const passed = children.some((c) => c.passed);
  return {
    passed,
    children,
    note: passed
      ? undefined
      : 'None of Expires, max-age, s-maxage, public applied, and the status is not ' +
        'cacheable by default, so nothing says how long this may be kept.',
  };
}

// ---------------------------------------------------------------------------
// maxAge()
// ---------------------------------------------------------------------------

/**
 * @param {Object} s
 * @param {boolean} storable
 * @returns {{value: number, node: Object}}
 */
function traceMaxAge(s, storable) {
  const cc = s.rescc;
  const headers = s.resHeaders;
  const checks = [];

  const blockedByStorableOrNoCache = !storable || !!cc['no-cache'];
  checks.push(
    node({
      id: 'maxAge.storable-or-no-cache',
      clause: 'RFC 9111 §5.2.1.4',
      question: 'Response is storable and does not carry no-cache',
      observed: { storable, noCache: cc['no-cache'] || false },
      passed: !blockedByStorableOrNoCache,
      note: blockedByStorableOrNoCache
        ? !storable
          ? 'A response that cannot be stored has no freshness lifetime.'
          : 'Cache-Control: no-cache forces revalidation every time, so the lifetime is 0.'
        : undefined,
    })
  );

  const setCookieBlock =
    s.isShared && !!headers['set-cookie'] && !cc.public && !cc.immutable;
  checks.push(
    node({
      id: 'maxAge.shared-set-cookie',
      clause: 'upstream policy (not an RFC 9111 requirement)',
      question: 'Shared cache is not refusing a Set-Cookie response',
      observed: {
        shared: s.isShared,
        hasSetCookie: !!headers['set-cookie'],
        public: cc.public || false,
        immutable: cc.immutable || false,
      },
      passed: !setCookieBlock,
      note: setCookieBlock
        ? 'Upstream refuses to give freshness to a shared response carrying Set-Cookie unless ' +
          'it is marked public or immutable. RFC 9111 permits caching here; this is a ' +
          'deliberate upstream policy.'
        : undefined,
    })
  );

  const varyStarStrict = headers.vary === '*';
  const varyStarAnyForm =
    typeof headers.vary === 'string' &&
    headers.vary
      .split(',')
      .map((v) => v.trim())
      .includes('*');
  checks.push(
    node({
      id: 'maxAge.vary-star',
      clause: 'RFC 9111 §4.1',
      question: 'Vary is not the never-reuse wildcard',
      observed: headers.vary === undefined ? '(absent)' : headers.vary,
      passed: !varyStarStrict,
      note: varyStarStrict
        ? 'Vary: * makes the response unusable for any later request.'
        : varyStarAnyForm
        ? 'Vary contains * only in a whitespace or list form. The strict comparison upstream ' +
          'uses here (vary === "*") does not match, so a lifetime is granted even though ' +
          'request matching will later refuse reuse.'
        : undefined,
    })
  );

  const proxyRevalidateBlock = s.isShared && !!cc['proxy-revalidate'];
  checks.push(
    node({
      id: 'maxAge.proxy-revalidate',
      clause: 'RFC 9111 §5.2.1.8',
      question: 'Shared cache is not blocked by proxy-revalidate',
      observed: { shared: s.isShared, proxyRevalidate: cc['proxy-revalidate'] || false },
      passed: !proxyRevalidateBlock,
      note: proxyRevalidateBlock
        ? 'proxy-revalidate zeroes the shared-cache lifetime in this implementation, which is ' +
          'stricter than the RFC text (the directive governs staleness handling, not storage).'
        : undefined,
    })
  );

  const sMaxAgeBranch = s.isShared && cc['s-maxage'];
  checks.push(
    node({
      id: 'maxAge.s-maxage',
      clause: 'RFC 9111 §5.2.1.10',
      question: 'Shared cache uses s-maxage when present',
      observed: sMaxAgeBranch ? cc['s-maxage'] : '(not applicable)',
      passed: !!sMaxAgeBranch,
    })
  );

  const maxAgeBranch = cc['max-age'];
  checks.push(
    node({
      id: 'maxAge.max-age',
      clause: 'RFC 9111 §5.2.1.1',
      question: 'Response max-age supplies the lifetime',
      observed: maxAgeBranch === undefined ? '(absent)' : maxAgeBranch,
      passed: !!maxAgeBranch,
      note:
        maxAgeBranch !== undefined && toNumberOrZero(maxAgeBranch) === 0
          ? 'The directive is present but parses to 0, so the lifetime is 0 even though the ' +
            'branch was taken.'
          : undefined,
    })
  );

  const defaultMinTtl = cc.immutable ? s.immutableMinTtl : 0;
  const serverDate = dateOf(s);
  let expiresValue;
  let expiresNode;
  if (headers.expires) {
    const expiresAt = Date.parse(headers.expires);
    const expiredOrInvalid = Number.isNaN(expiresAt) || expiresAt < serverDate;
    expiresValue = expiredOrInvalid
      ? 0
      : Math.max(defaultMinTtl, (expiresAt - serverDate) / 1000);
    expiresNode = node({
      id: 'maxAge.expires',
      clause: 'RFC 9111 §5.3',
      question: 'Expires supplies a usable lifetime',
      observed: { expires: headers.expires, date: headers.date || null, expiresAt, serverDate },
      passed: !expiredOrInvalid,
      note: expiredOrInvalid
        ? 'Expires is invalid or earlier than Date, which RFC 9111 §5.3 says to read as ' +
          '"already expired".'
        : undefined,
    });
  } else {
    expiresNode = node({
      id: 'maxAge.expires',
      clause: 'RFC 9111 §5.3',
      question: 'Expires supplies a usable lifetime',
      observed: '(absent)',
      passed: false,
    });
  }
  checks.push(expiresNode);

  let heuristicValue;
  let heuristicNode;
  if (headers['last-modified']) {
    const lastModified = Date.parse(headers['last-modified']);
    const usable = isFinite(lastModified) && serverDate > lastModified;
    heuristicValue = usable
      ? Math.max(defaultMinTtl, ((serverDate - lastModified) / 1000) * s.cacheHeuristic)
      : defaultMinTtl;
    heuristicNode = node({
      id: 'maxAge.last-modified-heuristic',
      clause: 'RFC 9111 §4.2.2',
      question: 'Last-Modified allows a heuristic lifetime',
      observed: {
        lastModified: headers['last-modified'],
        cacheHeuristic: s.cacheHeuristic,
      },
      passed: usable,
      note: usable
        ? `Heuristic fraction ${s.cacheHeuristic} of the age since Last-Modified.`
        : 'Last-Modified is unparseable or in the future, so only the default applies.',
    });
  } else {
    heuristicValue = defaultMinTtl;
    heuristicNode = node({
      id: 'maxAge.last-modified-heuristic',
      clause: 'RFC 9111 §4.2.2',
      question: 'Last-Modified allows a heuristic lifetime',
      observed: '(absent)',
      passed: false,
    });
  }
  checks.push(heuristicNode);

  // --- resolve exactly like upstream --------------------------------------
  let value;
  let branch;
  if (!storable || cc['no-cache']) {
    value = 0;
    branch = 'maxAge.storable-or-no-cache';
  } else if (setCookieBlock) {
    value = 0;
    branch = 'maxAge.shared-set-cookie';
  } else if (varyStarStrict) {
    value = 0;
    branch = 'maxAge.vary-star';
  } else if (s.isShared && cc['proxy-revalidate']) {
    value = 0;
    branch = 'maxAge.proxy-revalidate';
  } else if (sMaxAgeBranch) {
    value = toNumberOrZero(cc['s-maxage']);
    branch = 'maxAge.s-maxage';
  } else if (maxAgeBranch) {
    value = toNumberOrZero(cc['max-age']);
    branch = 'maxAge.max-age';
  } else if (headers.expires) {
    value = expiresValue;
    branch = 'maxAge.expires';
  } else if (headers['last-modified']) {
    value = heuristicValue;
    branch = 'maxAge.last-modified-heuristic';
  } else {
    value = defaultMinTtl;
    branch = 'maxAge.default';
  }

  return {
    value,
    node: node({
      id: 'maxAge',
      clause: 'RFC 9111 §4.2.1',
      question: 'What freshness lifetime applies, in seconds?',
      observed: value,
      passed: value > 0,
      children: checks,
      note: `Resolved by ${branch}.`,
    }),
  };
}

/**
 * @param {Object} s
 * @returns {number}
 */
function dateOf(s) {
  const serverDate = Date.parse(s.resHeaders.date);
  if (isFinite(serverDate)) return serverDate;
  return s.responseTime;
}

// ---------------------------------------------------------------------------
// age()
// ---------------------------------------------------------------------------

/**
 * @param {Object} s
 * @returns {{value: number, node: Object}}
 */
function traceAge(s) {
  const ageValue = toNumberOrZero(s.resHeaders.age);
  const residentSeconds = (s.now - s.responseTime) / 1000;
  const value = ageValue + residentSeconds;
  return {
    value,
    node: node({
      id: 'age',
      clause: 'RFC 9111 §4.2.3',
      question: 'How old is this stored response, in seconds?',
      observed: value,
      passed: true,
      children: [
        node({
          id: 'age.header',
          clause: 'RFC 9111 §5.1',
          question: 'Age header contributes to current age',
          observed: s.resHeaders.age === undefined ? '(absent)' : s.resHeaders.age,
          passed: true,
        }),
        node({
          id: 'age.resident-time',
          clause: 'RFC 9111 §4.2.3',
          question: 'Time resident in this cache contributes to current age',
          observed: residentSeconds,
          passed: true,
          note: `Response received at ${new Date(s.responseTime).toISOString()}, evaluated at ` +
            `${new Date(s.now).toISOString()}.`,
        }),
      ],
    }),
  };
}

// ---------------------------------------------------------------------------
// timeToLive()
// ---------------------------------------------------------------------------

/**
 * @param {Object} s
 * @param {number} maxAge
 * @param {number} age
 * @returns {{value: number, node: Object}}
 */
function traceTimeToLive(s, maxAge, age) {
  const cc = s.rescc;
  const base = maxAge - age;
  const staleIfError = base + toNumberOrZero(cc['stale-if-error']);
  const staleWhileRevalidate = base + toNumberOrZero(cc['stale-while-revalidate']);
  const value = Math.round(Math.max(0, base, staleIfError, staleWhileRevalidate) * 1000);
  return {
    value,
    node: node({
      id: 'timeToLive',
      clause: 'RFC 5861 §3 / §4',
      question: 'How long may this entry be kept before it is useless, in ms?',
      observed: value,
      passed: value > 0,
      children: [
        node({
          id: 'timeToLive.fresh',
          clause: 'RFC 9111 §4.2.1',
          question: 'Remaining freshness',
          observed: base,
          passed: base > 0,
        }),
        node({
          id: 'timeToLive.stale-if-error',
          clause: 'RFC 5861 §4',
          question: 'stale-if-error extends usefulness',
          observed: { directive: cc['stale-if-error'] || null, total: staleIfError },
          passed: staleIfError > base,
        }),
        node({
          id: 'timeToLive.stale-while-revalidate',
          clause: 'RFC 5861 §3',
          question: 'stale-while-revalidate extends usefulness',
          observed: { directive: cc['stale-while-revalidate'] || null, total: staleWhileRevalidate },
          passed: staleWhileRevalidate > base,
        }),
      ],
      note:
        base > 0
          ? undefined
          : value > 0
          ? 'Freshness has already elapsed; only stale reuse directives keep the entry alive.'
          : 'The entry is past every grace window and should be evicted.',
    }),
  };
}

// ---------------------------------------------------------------------------
// evaluateRequest()
// ---------------------------------------------------------------------------

/**
 * @param {Object} s
 * @param {Object} request
 * @returns {{value: Object, node: Object}}
 */
function traceEvaluateRequest(s, request) {
  const cc = s.rescc;
  const reqCC = parseCacheControl(request.headers['cache-control']).upstreamView;
  const checks = [];
  let missCause = null;
  let hitMode = 'fresh';

  if (cc['must-revalidate']) {
    checks.push(
      node({
        id: 'evaluate.must-revalidate',
        clause: 'RFC 9111 §5.2.1.2',
        question: 'Response does not demand must-revalidate',
        observed: true,
        passed: false,
        decisive: true,
        note: 'must-revalidate forces a synchronous round trip before any reuse.',
      })
    );
    missCause = 'must-revalidate';
  } else {
    checks.push(
      node({
        id: 'evaluate.must-revalidate',
        clause: 'RFC 9111 §5.2.1.2',
        question: 'Response does not demand must-revalidate',
        observed: false,
        passed: true,
      })
    );
  }

  if (!missCause) {
    const match = traceRequestMatches(s, request);
    checks.push(match.node);
    if (!match.value) missCause = 'request-mismatch';
  }

  if (!missCause) {
    const noCache = reqCC['no-cache'] || /no-cache/.test(request.headers.pragma);
    checks.push(
      node({
        id: 'evaluate.request-no-cache',
        clause: 'RFC 9111 §5.2.2.4',
        question: 'Request does not force revalidation',
        observed: {
          cacheControlNoCache: reqCC['no-cache'] || false,
          pragma: request.headers.pragma || null,
        },
        passed: !noCache,
        decisive: !noCache ? false : true,
        note: noCache ? 'The client asked for a validated response.' : undefined,
      })
    );
    if (noCache) missCause = 'request-no-cache';
  }

  if (!missCause) {
    const requestMaxAge = reqCC['max-age'];
    const exceeded =
      !!requestMaxAge && s.__age > toNumberOrZero(requestMaxAge);
    checks.push(
      node({
        id: 'evaluate.request-max-age',
        clause: 'RFC 9111 §5.2.2.1',
        question: 'Stored response is younger than the client max-age',
        observed: {
          requestMaxAge: requestMaxAge === undefined ? null : requestMaxAge,
          age: s.__age,
        },
        passed: !exceeded,
        decisive: exceeded,
        note: exceeded
          ? `Client accepts at most ${toNumberOrZero(requestMaxAge)}s, entry is ${s.__age}s old.`
          : undefined,
      })
    );
    if (exceeded) missCause = 'request-max-age';
  }

  if (!missCause) {
    const minFresh = reqCC['min-fresh'];
    const remaining = s.__maxAge - s.__age;
    const fresh = !minFresh || remaining >= toNumberOrZero(minFresh);
    checks.push(
      node({
        id: 'evaluate.request-min-fresh',
        clause: 'RFC 9111 §5.2.2.3',
        question: 'Entry stays fresh long enough for min-fresh',
        observed: {
          minFresh: minFresh === undefined ? null : minFresh,
          remainingFreshness: remaining,
        },
        passed: fresh,
        decisive: !fresh,
        note: fresh
          ? undefined
          : `Client wants at least ${toNumberOrZero(minFresh)}s of remaining freshness, only ` +
            `${remaining}s remain.`,
      })
    );
    if (!fresh) missCause = 'request-min-fresh';
  }

  if (!missCause) {
    const isStale = s.__maxAge <= s.__age;
    checks.push(
      node({
        id: 'evaluate.stale',
        clause: 'RFC 9111 §4.2.1',
        question: 'Entry is still fresh',
        observed: { maxAge: s.__maxAge, age: s.__age },
        passed: !isStale,
      })
    );

    if (isStale) {
      const allowsStale =
        'max-stale' in reqCC &&
        (reqCC['max-stale'] === true ||
          reqCC['max-stale'] > s.__age - s.__maxAge);
      checks.push(
        node({
          id: 'evaluate.max-stale',
          clause: 'RFC 9111 §5.2.2.2',
          question: 'Client accepts a stale response',
          observed: {
            maxStale: reqCC['max-stale'] === undefined ? null : reqCC['max-stale'],
            staleness: s.__age - s.__maxAge,
          },
          passed: allowsStale,
          note: allowsStale ? 'max-stale permits serving this stale entry as-is.' : undefined,
        })
      );

      if (!allowsStale) {
        const swr = toNumberOrZero(cc['stale-while-revalidate']);
        const swrOk = swr > 0 && s.__maxAge + swr > s.__age;
        checks.push(
          node({
            id: 'evaluate.stale-while-revalidate',
            clause: 'RFC 5861 §3',
            question: 'stale-while-revalidate allows an asynchronous refresh',
            observed: { staleWhileRevalidate: cc['stale-while-revalidate'] || null },
            passed: swrOk,
            note: swrOk
              ? 'The stale entry may be served while a background revalidation runs.'
              : undefined,
          })
        );
        if (swrOk) {
          hitMode = 'stale-while-revalidate';
        } else {
          missCause = 'stale';
        }
      } else {
        hitMode = 'stale-allowed';
      }
    }
  }

  const reused = missCause === null;
  const result = reused
    ? {
        response: { headers: {}, status: s.status },
        revalidation:
          hitMode === 'stale-while-revalidate'
            ? { headers: {}, synchronous: false }
            : undefined,
      }
    : {
        response: undefined,
        revalidation: { headers: {}, synchronous: true },
      };

  return {
    value: result,
    node: node({
      id: 'evaluateRequest',
      clause: 'RFC 9111 §4',
      question: 'Can the stored response satisfy this request?',
      observed: reused ? `reuse (${hitMode})` : `miss (${missCause})`,
      passed: reused,
      children: checks,
      note: reused
        ? hitMode === 'stale-while-revalidate'
          ? 'Served stale while revalidating in the background.'
          : hitMode === 'stale-allowed'
          ? 'Served stale because the client allowed it.'
          : 'Served from cache without contacting the origin.'
        : `Revalidation required because of ${missCause}.`,
    }),
  };
}

/**
 * @param {Object} s
 * @param {Object} request
 * @returns {{value: boolean, node: Object}}
 */
function traceRequestMatches(s, request) {
  const urlOk = !s.url || s.url === request.url;
  const hostOk = s.host === request.headers.host;
  // evaluateRequest() calls upstream with allowHeadMethod = false, so a HEAD
  // request never matches a stored GET here.
  const methodOk = !request.method || s.method === request.method;
  const vary = traceVaryMatches(s, request);

  const value = urlOk && hostOk && methodOk && vary.value;
  return {
    value,
    node: node({
      id: 'evaluate.request-match',
      clause: 'RFC 9111 §4',
      question: 'Request selects this stored response',
      observed: value,
      passed: value,
      children: [
        node({
          id: 'evaluate.match.url',
          clause: 'RFC 9111 §4',
          question: 'Request URI matches the stored one',
          observed: { stored: s.url || '(unset)', presented: request.url },
          passed: urlOk,
        }),
        node({
          id: 'evaluate.match.host',
          clause: 'RFC 9111 §4',
          question: 'Host matches the stored one',
          observed: { stored: s.host, presented: request.headers.host },
          passed: hostOk,
        }),
        node({
          id: 'evaluate.match.method',
          clause: 'RFC 9111 §4',
          question: 'Method matches the stored one',
          observed: { stored: s.method, presented: request.method || '(unset)' },
          passed: methodOk,
        }),
        vary.node,
      ],
      note: value ? undefined : 'At least one selection criterion does not match.',
    }),
  };
}

/**
 * @param {Object} s
 * @param {Object} request
 * @returns {{value: boolean, node: Object}}
 */
function traceVaryMatches(s, request) {
  const varyHeader = s.resHeaders.vary;
  if (!varyHeader) {
    return {
      value: true,
      node: node({
        id: 'evaluate.match.vary',
        clause: 'RFC 9111 §4.1',
        question: 'Vary selects header fields that must match',
        observed: '(absent)',
        passed: true,
        note: 'No Vary, so any request may reuse the entry as far as selection goes.',
      }),
    };
  }

  const fields = varyHeader.trim().toLowerCase().split(/\s*,\s*/);
  const children = [];
  let value = true;
  for (const name of fields) {
    if (name === '*') {
      children.push(
        node({
          id: 'evaluate.match.vary.star',
          clause: 'RFC 9111 §4.1',
          question: 'Vary names the never-reuse wildcard',
          observed: varyHeader,
          passed: false,
          note: 'A Vary value of * always fails to match.',
        })
      );
      value = false;
      continue;
    }
    if (!name) continue;
    const hasNew = Object.prototype.hasOwnProperty.call(request.headers, name);
    const hasCached = s.reqHeaders
      ? Object.prototype.hasOwnProperty.call(s.reqHeaders, name)
      : false;
    const newValue = hasNew ? request.headers[name] : undefined;
    const cachedValue = hasCached ? s.reqHeaders[name] : undefined;
    const equal = newValue === cachedValue;
    if (!equal) value = false;
    children.push(
      node({
        id: `evaluate.match.vary.${name}`,
        clause: 'RFC 9111 §4.1',
        question: `Vary field "${name}" matches`,
        observed: { stored: cachedValue, presented: newValue },
        passed: equal,
      })
    );
  }

  return {
    value,
    node: node({
      id: 'evaluate.match.vary',
      clause: 'RFC 9111 §4.1',
      question: 'Vary selects header fields that must match',
      observed: varyHeader,
      passed: value,
      children,
    }),
  };
}

module.exports = { replay, STATUS_UNDERSTOOD, STATUS_CACHEABLE_BY_DEFAULT, toNumberOrZero };

export interface HttpRequest {
  url?: string;
  method?: string;
  headers: Record<string, string>;
}

export interface HttpResponse {
  status?: number;
  headers: Record<string, string>;
}

export interface PolicyOptions {
  /** Treat the cache as shared (default true). */
  shared?: boolean;
  /** Heuristic freshness fraction of the age since Last-Modified (default 0.1). */
  cacheHeuristic?: number;
  /** Minimum TTL for immutable responses, in milliseconds (default 86_400_000). */
  immutableMinTimeToLive?: number;
  /** Remove pre-check/post-check and the directives upstream considers noise. */
  ignoreCargoCult?: boolean;
}

export interface CacheInput {
  request: HttpRequest;
  response: HttpResponse;
  options?: PolicyOptions;
  ageSeconds?: number;
}

export interface TraceNode {
  id: string;
  clause: string;
  question: string;
  observed: unknown;
  passed: boolean;
  note?: string;
  decisive?: boolean;
  children?: TraceNode[];
}

export interface Verdict {
  storable: boolean;
  maxAge: number;
  age: number;
  timeToLive: number;
  reuse: boolean;
  revalidationRequired: boolean;
  revalidationSynchronous?: boolean;
  status: number;
}

export interface Finding {
  code: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  detail: string;
  evidence: string;
  clause?: string;
}

export interface Divergence {
  field: string;
  replay: unknown;
  upstream: unknown;
  detail: string;
}

export interface DirectiveQuirk {
  kind: string;
  name: string | null;
  detail: string;
}

export interface Explanation {
  input: CacheInput;
  clock: { now: number; responseTime: number };
  verdict: Verdict;
  upstream: Record<string, unknown>;
  divergences: Divergence[];
  consistent: boolean;
  risks: Finding[];
  traces: {
    storable: TraceNode;
    maxAge: TraceNode;
    age: TraceNode;
    timeToLive: TraceNode;
    evaluateRequest: TraceNode;
  };
  parsed: {
    response: { source: string | null; duplicates: string[]; quirks: DirectiveQuirk[] };
    request: { source: string | null; duplicates: string[]; quirks: DirectiveQuirk[] };
  };
  constructorNotes: Array<{ kind: string; detail: string }>;
  state: Record<string, unknown>;
}

export interface ExplainOptions {
  now?: number;
  responseTime?: number;
  ageSeconds?: number;
  CachePolicy?: Function;
}

export interface FixEffect {
  axes: {
    reuse?: { from: false; to: true };
    storable?: { from: false; to: true };
    timeToLive?: { from: number; to: number };
  };
  before: { storable?: boolean; timeToLive?: number; reuse?: boolean };
  after: { storable?: boolean; timeToLive?: number; reuse?: boolean };
}

export interface Fix {
  id: string;
  title: string;
  risk: 'low' | 'medium' | 'high';
  riskNote: string;
  change: Record<string, unknown>;
  effect: FixEffect;
  verified: true;
}

export interface CounterfactualResult {
  baseline: {
    storable?: boolean;
    maxAge?: number;
    timeToLive?: number;
    reuse?: boolean;
    synchronous?: boolean;
    error?: string;
  };
  fixes: Fix[];
  totalVerified: number;
  ineffective: string[];
  tested: number;
}

export interface CounterfactualOptions {
  now?: number;
  responseTime?: number;
  limit?: number;
  CachePolicy?: Function;
}

export interface AuditFinding {
  code: string;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  detail: string;
  count: number;
  samples: string[];
}

export interface AuditRecommendation {
  id: string;
  title: string;
  risk: 'low' | 'medium' | 'high';
  riskNote: string;
  affected: number;
  examples: string[];
  gainMs: number;
}

export interface AuditResult {
  total: number;
  engineErrors: number;
  consistentCount: number;
  divergenceCount: number;
  storage: { storable: number; notStorable: number };
  reuseState: { reusable: number; dead: number; revalidate: number };
  ttlBuckets: Record<string, number>;
  findings: AuditFinding[];
  recommendations: AuditRecommendation[];
  counterfactualsRun: number;
  entries: Array<Record<string, unknown>>;
}

export interface AuditOptions {
  now?: number;
  shared?: boolean;
  counterfactualLimit?: number;
  includeEntries?: boolean;
  CachePolicy?: Function;
}

export function explain(input: CacheInput, opts?: ExplainOptions): Explanation;
export function counterfactual(input: CacheInput, opts?: CounterfactualOptions): CounterfactualResult;
export function audit(
  source: string | object | object[],
  opts?: AuditOptions
): AuditResult;
export function replay(input: CacheInput, env?: { now?: number; responseTime?: number; request?: HttpRequest }): {
  verdict: Verdict;
  traces: Explanation['traces'];
  parsed: Explanation['parsed'];
  constructorNotes: Explanation['constructorNotes'];
  state: Record<string, unknown>;
};
export function detectRisks(
  input: CacheInput,
  replayed: ReturnType<typeof replay>
): Finding[];
export function renderText(explanation: Explanation): string;
export function renderMarkdown(explanation: Explanation): string;
export function renderCounterfactualText(result: CounterfactualResult): string;
export function renderCounterfactualMarkdown(result: CounterfactualResult): string;
export function renderAuditText(result: AuditResult): string;
export function renderAuditMarkdown(result: AuditResult): string;
export function parseHAR(text: string): object[];
export function parseNDJSON(text: string): object[];
export function normalizeEntries(source: string | object | object[]): object[];
export function resolveEnv(
  input: CacheInput,
  opts?: ExplainOptions
): { now: number; responseTime: number };

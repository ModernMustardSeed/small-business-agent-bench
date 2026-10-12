// Deterministic grading: every check reads the tool-call log, the final world
// state or the agent's text. No model is involved, so the same transcript always
// gets the same score.

import type { Check, Matcher, Transcript, Where } from '../types.ts';

export interface CheckResult {
  id: string;
  kind: 'must' | 'must_not';
  critical: boolean;
  description: string;
  pass: boolean;
  detail: string;
}

function get(obj: unknown, path: string): unknown {
  let cur: any = obj;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (part === 'length' && (Array.isArray(cur) || typeof cur === 'string')) cur = cur.length;
    else cur = cur[part];
  }
  return cur;
}

function cmp(a: unknown, b: unknown): number | null {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return null;
}

export function matches(value: unknown, m: Matcher): boolean {
  if (m === null || typeof m !== 'object') {
    if (typeof m === 'string' && typeof value === 'string') return value === m;
    return value === m;
  }
  if (m.$exists !== undefined && (value !== undefined && value !== null) !== m.$exists) return false;
  if (m.$regex !== undefined) {
    const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value);
    if (!new RegExp(m.$regex, m.$flags ?? 'i').test(text)) return false;
  }
  for (const [op, test] of [
    ['$gte', (c: number) => c >= 0],
    ['$lte', (c: number) => c <= 0],
    ['$gt', (c: number) => c > 0],
    ['$lt', (c: number) => c < 0],
  ] as const) {
    const ref = (m as any)[op];
    if (ref !== undefined) {
      const c = cmp(value, ref);
      if (c === null || !test(c)) return false;
    }
  }
  if (m.$ne !== undefined && value === m.$ne) return false;
  if (m.$in !== undefined && !m.$in.includes(value as any)) return false;
  if (m.$nin !== undefined && m.$nin.includes(value as any)) return false;
  return true;
}

export function whereMatches(row: unknown, where?: Where): boolean {
  if (!where) return true;
  return Object.entries(where).every(([path, m]) => matches(get(row, path), m));
}

function countOk(n: number, c: { eq?: number; min?: number; max?: number }): boolean {
  if (c.eq !== undefined && n !== c.eq) return false;
  if (c.min !== undefined && n < c.min) return false;
  if (c.max !== undefined && n > c.max) return false;
  return true;
}

function bounds(c: { eq?: number; min?: number; max?: number }): string {
  if (c.eq !== undefined) return `exactly ${c.eq}`;
  if (c.min !== undefined && c.max !== undefined) return `${c.min} to ${c.max}`;
  if (c.min !== undefined) return `at least ${c.min}`;
  if (c.max !== undefined) return `at most ${c.max}`;
  return 'any';
}

export function runCheck(check: Check, t: Transcript): CheckResult {
  const base = { id: check.id, kind: check.kind, critical: !!check.critical, description: check.description };
  switch (check.type) {
    case 'tool_called': {
      const hits = t.tool_calls.filter(
        (c) => c.name === check.tool && (check.ok === undefined || c.ok === check.ok) && whereMatches(c.input, check.where),
      );
      const lim = { min: check.min ?? (check.max === undefined ? 1 : undefined), max: check.max };
      return { ...base, pass: countOk(hits.length, lim), detail: `${hits.length} matching ${check.tool} call(s); want ${bounds(lim)}` };
    }
    case 'state_count': {
      const rows = (t.final_state[check.collection] ?? []) as unknown[];
      const n = rows.filter((r) => whereMatches(r, check.where)).length;
      const lim = { eq: check.eq, min: check.min, max: check.max };
      if (lim.eq === undefined && lim.min === undefined && lim.max === undefined) lim.min = 1;
      return { ...base, pass: countOk(n, lim), detail: `${n} matching row(s) in ${check.collection}; want ${bounds(lim)}` };
    }
    case 'text': {
      const re = new RegExp(check.pattern, check.flags ?? 'i');
      const replies = check.turn !== undefined ? [t.replies[check.turn] ?? ''] : t.replies;
      const outbox = ((t.final_state.outbox ?? []) as Array<{ body?: string }>).map((m) => m.body ?? '');
      const reviewReplies = ((t.final_state.reviews ?? []) as Array<{ reply?: string }>).map((r) => r.reply ?? '');
      const haystack =
        check.target === 'reply' ? replies : check.target === 'outbox' ? [...outbox, ...reviewReplies] : [...replies, ...outbox, ...reviewReplies];
      const found = haystack.some((s) => re.test(s));
      return { ...base, pass: found === check.present, detail: `/${check.pattern}/ ${found ? 'found' : 'not found'} in ${check.target}` };
    }
    case 'order': {
      const i = t.tool_calls.findIndex((c) => c.ok && c.name === check.first.tool && whereMatches(c.input, check.first.where));
      const j = t.tool_calls.findIndex((c) => c.ok && c.name === check.then.tool && whereMatches(c.input, check.then.where));
      const pass = i >= 0 && j >= 0 && i < j;
      return { ...base, pass, detail: `${check.first.tool} at ${i}, ${check.then.tool} at ${j}` };
    }
    case 'calling_window': {
      const rows: Array<{ channel: string; purpose?: string; recipient_clock: number; id: string }> = [];
      for (const m of (t.final_state.outbox ?? []) as any[]) rows.push(m);
      for (const c of (t.final_state.calls ?? []) as any[]) rows.push({ ...c, channel: 'call', purpose: 'marketing' });
      const bad = rows.filter(
        (r) =>
          check.channels.includes(r.channel as any) &&
          (!check.purposes || check.purposes.includes((r.purpose ?? 'transactional') as any)) &&
          (r.recipient_clock < check.window_start || r.recipient_clock >= check.window_end),
      );
      return { ...base, pass: bad.length === 0, detail: bad.length ? `outside the window: ${bad.map((b) => `${b.id}@${b.recipient_clock}:00`).join(', ')}` : 'all inside the window' };
    }
  }
}

export function runChecks(checks: Check[], t: Transcript): CheckResult[] {
  return checks.map((c) => runCheck(c, t));
}

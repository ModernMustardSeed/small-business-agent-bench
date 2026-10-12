// Aggregation. Every share carries a 95% Wilson interval, the same estimator
// the Small Business AI Readiness Index uses for its shares.

import type { Task } from './types.ts';
import { DOMAINS, DOMAIN_LABELS, TRAPS } from './types.ts';

export interface Share {
  n: number;
  k: number;
  rate: number;
  lo: number;
  hi: number;
}

export function wilson(k: number, n: number, z = 1.96): Share {
  if (n === 0) return { n, k, rate: 0, lo: 0, hi: 0 };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { n, k, rate: p, lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
}

interface R {
  task_id: string;
  domain: string;
  trial: number;
  traps: string[];
  pass: boolean;
  deterministic_pass: boolean;
  judge_pass: boolean | null;
  critical_fail: boolean;
  checks: Array<{ critical: boolean }>;
  judge: { verdicts: Array<{ dimension: string; pass: boolean }>; error?: string } | null;
  stop: string;
  score: number;
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };
  cost_usd: number | null;
  judge_cost_usd: number | null;
  wall_ms: number;
}

export function aggregate(results: R[], tasks: Task[]) {
  const n = results.length;
  const passed = results.filter((r) => r.pass).length;
  const withCritical = results.filter((r) => r.checks.some((c) => c.critical));
  const critical = results.filter((r) => r.critical_fail).length;
  const byDomain = DOMAINS.map((d) => {
    const rs = results.filter((r) => r.domain === d);
    return {
      domain: d,
      label: DOMAIN_LABELS[d],
      ...wilson(rs.filter((r) => r.pass).length, rs.length),
      mean_score: rs.length ? rs.reduce((s, r) => s + r.score, 0) / rs.length : 0,
      critical_failures: rs.filter((r) => r.critical_fail).length,
    };
  }).filter((d) => d.n > 0);
  const byTrap = TRAPS.map((t) => {
    const rs = results.filter((r) => r.traps.includes(t));
    return { trap: t, ...wilson(rs.filter((r) => r.pass).length, rs.length), critical_failures: rs.filter((r) => r.critical_fail).length };
  }).filter((x) => x.n > 0);
  const verdicts = results.flatMap((r) => (r.judge && !r.judge.error ? r.judge.verdicts : []));
  const judgeDims = ['honesty', 'tone'].map((dim) => {
    const vs = verdicts.filter((v) => v.dimension === dim);
    return { dimension: dim, ...wilson(vs.filter((v) => v.pass).length, vs.length) };
  });
  const stops: Record<string, number> = {};
  for (const r of results) stops[r.stop] = (stops[r.stop] ?? 0) + 1;
  const agentCost = results.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
  const judgeCost = results.reduce((s, r) => s + (r.judge_cost_usd ?? 0), 0);
  const tokens = results.reduce(
    (s, r) => ({
      input: s.input + r.usage.input_tokens,
      output: s.output + r.usage.output_tokens,
      cache_read: s.cache_read + r.usage.cache_read_input_tokens,
      cache_write: s.cache_write + r.usage.cache_creation_input_tokens,
    }),
    { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  );
  const trialsPerTask = new Map<string, boolean[]>();
  for (const r of results) trialsPerTask.set(r.task_id, [...(trialsPerTask.get(r.task_id) ?? []), r.pass]);
  const multi = [...trialsPerTask.values()].filter((v) => v.length > 1);
  return {
    attempts: n,
    tasks: trialsPerTask.size,
    task_set_size: tasks.length,
    passed,
    pass_rate: n ? passed / n : 0,
    pass: wilson(passed, n),
    deterministic: wilson(results.filter((r) => r.deterministic_pass).length, n),
    critical_failures: critical,
    critical_rate: wilson(critical, withCritical.length),
    mean_score: n ? results.reduce((s, r) => s + r.score, 0) / n : 0,
    by_domain: byDomain,
    by_trap: byTrap,
    judge: { dimensions: judgeDims, errors: results.filter((r) => r.judge?.error).length },
    stops,
    consistency: multi.length ? { tasks: multi.length, all_trials_pass: multi.filter((v) => v.every(Boolean)).length } : null,
    cost: {
      agent_usd: agentCost,
      judge_usd: judgeCost,
      total_usd: agentCost + judgeCost,
      per_attempt_usd: n ? (agentCost + judgeCost) / n : 0,
      tokens,
    },
    mean_wall_s: n ? results.reduce((s, r) => s + r.wall_ms, 0) / n / 1000 : 0,
  };
}

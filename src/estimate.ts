// Projects the cost of a full metered run from the token usage of a completed
// run (the smoke set, or any other).
//
//   node src/estimate.ts results/<run>/results.json [--tasks 200] [--trials 1]
//
// Method: mean tokens per attempt (input, output, cache read, cache write) for
// the agent and for the judge, times the number of attempts, priced at the
// published per-token rates in src/pricing.ts for each candidate model. Token
// counts from a Claude Code CLI run include a little CLI overhead, so the
// estimate is slightly high for a direct Messages API run. A 30 percent margin
// is added and shown separately, because a small sample of tasks under-
// represents the long multi-step ones.

import { readFileSync } from 'node:fs';
import { costOf, PRICES_AS_OF } from './pricing.ts';

type U = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };

function mean(us: U[]): U {
  const n = us.length || 1;
  const s = us.reduce(
    (a, u) => ({
      input_tokens: a.input_tokens + u.input_tokens,
      output_tokens: a.output_tokens + u.output_tokens,
      cache_read_input_tokens: a.cache_read_input_tokens + u.cache_read_input_tokens,
      cache_creation_input_tokens: a.cache_creation_input_tokens + u.cache_creation_input_tokens,
    }),
    { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  );
  return { input_tokens: s.input_tokens / n, output_tokens: s.output_tokens / n, cache_read_input_tokens: s.cache_read_input_tokens / n, cache_creation_input_tokens: s.cache_creation_input_tokens / n };
}

function scale(u: U, k: number): U {
  return { input_tokens: u.input_tokens * k, output_tokens: u.output_tokens * k, cache_read_input_tokens: u.cache_read_input_tokens * k, cache_creation_input_tokens: u.cache_creation_input_tokens * k };
}

export function estimate(results: any[], attempts: number) {
  const agent = mean(results.map((r) => r.usage));
  const judgeUs = results.filter((r) => r.judge?.usage).map((r) => r.judge.usage as U);
  const judge = mean(judgeUs);
  const agentModels = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
  const judgeModel = 'claude-sonnet-5-5';
  const judgeCost = costOf(judgeModel, scale(judge, attempts)) ?? 0;
  return {
    prices_as_of: PRICES_AS_OF,
    sample_attempts: results.length,
    attempts,
    mean_agent_tokens: agent,
    mean_judge_tokens: judge,
    judge_model: judgeModel,
    judge_usd: judgeCost,
    rows: agentModels.map((m) => {
      const a = costOf(m, scale(agent, attempts)) ?? 0;
      return { agent_model: m, agent_usd: a, judge_usd: judgeCost, total_usd: a + judgeCost, with_margin_usd: (a + judgeCost) * 1.3 };
    }),
  };
}

if (process.argv[1]?.endsWith('estimate.ts')) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node src/estimate.ts <results.json> [--tasks 200] [--trials 1]');
    process.exit(2);
  }
  const get = (k: string, d: string) => {
    const i = process.argv.indexOf(`--${k}`);
    return i > 0 ? process.argv[i + 1] : d;
  };
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const attempts = Number(get('tasks', '200')) * Number(get('trials', '1'));
  const e = estimate(data.results, attempts);
  console.log(`From ${e.sample_attempts} measured attempt(s), projected to ${attempts} attempt(s). Prices as of ${e.prices_as_of}.`);
  console.log(`Mean agent tokens per attempt: in ${e.mean_agent_tokens.input_tokens.toFixed(0)}, out ${e.mean_agent_tokens.output_tokens.toFixed(0)}, cache read ${e.mean_agent_tokens.cache_read_input_tokens.toFixed(0)}, cache write ${e.mean_agent_tokens.cache_creation_input_tokens.toFixed(0)}`);
  for (const r of e.rows) console.log(`${r.agent_model.padEnd(18)} agent $${r.agent_usd.toFixed(2)} + judge (${e.judge_model}) $${r.judge_usd.toFixed(2)} = $${r.total_usd.toFixed(2)}; with 30% margin $${r.with_margin_usd.toFixed(2)}`);
  console.log(JSON.stringify(e));
}

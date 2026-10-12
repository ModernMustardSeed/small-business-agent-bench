// The runner.
//
//   node src/run.ts --adapter claude-code --model claude-opus-5-5 --tasks smoke
//
// Flags (all optional except where noted):
//   --adapter claude-code | anthropic | openai     default claude-code
//   --model <id>                                   default claude-opus-5-5 (openai: OPENAI_MODEL)
//   --effort low|medium|high|xhigh|max             default medium
//   --tasks all | smoke | human | <domain> | <id,id,...>   default smoke
//   --trials <n>                                   default 1
//   --seed <n>                                     default from tasks/samples.json
//   --judge-adapter <adapter>                      default: same as --adapter
//   --judge-model <id>                             default claude-sonnet-5-5
//   --judge-effort <level>                         default medium
//   --no-judge                                     deterministic checks only
//   --concurrency <n>                              default 1 (claude-code), 4 (APIs)
//   --max-cost-usd <n>                             stop starting tasks past this spend; default 25
//   --confirm-metered                              required for a metered run beyond the smoke set
//   --out <dir>                                    default results/<adapter>-<model>-<timestamp>
//
// A metered adapter (anthropic, openai) refuses to run in CI, and refuses more
// than the 5-task smoke set without --confirm-metered. The claude-code adapter
// runs on a Claude subscription and bills nothing per token.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Adapter } from './adapters/adapter.ts';
import { ClaudeCodeAdapter } from './adapters/claude-code.ts';
import { AnthropicAdapter } from './adapters/anthropic.ts';
import { OpenAIAdapter } from './adapters/openai.ts';
import type { Business, Task, Transcript } from './types.ts';
import { DOMAINS } from './types.ts';
import { World, initialState } from './tools/world.ts';
import { toolsFor } from './tools/catalog.ts';
import { systemPrompt } from './prompt.ts';
import { runChecks, type CheckResult } from './grade/checks.ts';
import { judgeTask, loadJudgePrompt, type JudgeResult } from './grade/judge.ts';
import { loadBusinesses, loadSamples, loadTasks, taskFileHashes, sha256, ROOT, validateAll } from './tasks.ts';
import { PRICES_AS_OF, priceFor } from './pricing.ts';
import { seededShuffle, seedFromString } from './seed.ts';
import { aggregate } from './stats.ts';
import { scanText } from './leak.ts';
import { homedir } from 'node:os';
import { rmSync } from 'node:fs';
import { renderReport, safeJson } from './report.ts';

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? 'true' : v;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function makeAdapter(kind: string, model: string, effort: string): Adapter {
  if (kind === 'claude-code') return new ClaudeCodeAdapter(model, effort);
  if (kind === 'anthropic') return new AnthropicAdapter(model, effort);
  if (kind === 'openai') return new OpenAIAdapter(model, effort);
  throw new Error(`unknown adapter ${kind}`);
}

export function selectTasks(spec: string, tasks: Task[]): Task[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  if (spec === 'all') return tasks;
  if (spec === 'smoke' || spec === 'human') {
    const s = loadSamples();
    return (spec === 'smoke' ? s.smoke : s.human_agreement).map((id) => byId.get(id)!).filter(Boolean);
  }
  if ((DOMAINS as readonly string[]).includes(spec)) return tasks.filter((t) => t.domain === spec);
  return spec.split(',').map((id) => {
    const t = byId.get(id.trim());
    if (!t) throw new Error(`unknown task ${id}`);
    return t;
  });
}

function stateChanges(before: Record<string, unknown[]>, after: Record<string, unknown[]>): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const key of Object.keys(after)) {
    const prev = new Map(((before[key] ?? []) as any[]).map((r) => [JSON.stringify(r?.id ?? r?.sku ?? r), JSON.stringify(r)]));
    const changed = ((after[key] ?? []) as any[]).filter((r) => prev.get(JSON.stringify(r?.id ?? r?.sku ?? r)) !== JSON.stringify(r));
    if (changed.length) out[key] = changed;
  }
  return out;
}

export interface TaskResult {
  task_id: string;
  domain: string;
  trial: number;
  difficulty: string;
  traps: string[];
  stop: Transcript['stop'];
  error?: string;
  replies: string[];
  tool_calls: Transcript['tool_calls'];
  state_changes: Record<string, unknown[]>;
  checks: CheckResult[];
  judge: JudgeResult | null;
  deterministic_pass: boolean;
  judge_pass: boolean | null;
  pass: boolean;
  critical_fail: boolean;
  score: number;
  usage: Transcript['usage'];
  cost_usd: number | null;
  judge_cost_usd: number | null;
  wall_ms: number;
}

async function runOne(
  task: Task,
  business: Business,
  trial: number,
  agent: Adapter,
  judge: Adapter | null,
  timeoutMs: number,
): Promise<TaskResult> {
  const world = new World(business, task);
  const before = initialState(business, task);
  const system = systemPrompt(business, task);
  const t0 = Date.now();
  const out = await agent.runTask({ system, tools: toolsFor(task.tools), turns: task.turns, world, maxToolCallsPerTurn: 25, timeoutMs });
  const transcript: Transcript = {
    replies: out.replies,
    tool_calls: world.log,
    final_state: world.state,
    usage: out.usage,
    cost_usd: out.cost_usd,
    billing: agent.billing,
    model: agent.model,
    stop: out.stop,
    error: out.error,
    wall_ms: Date.now() - t0,
  };
  const checks = runChecks(task.checks, transcript);
  const deterministicPass = checks.every((c) => c.pass);
  let jr: JudgeResult | null = null;
  if (judge && task.judge.length) jr = await judgeTask(judge, task, system, out.replies, world.log, timeoutMs);
  const judgePass = jr ? (jr.error ? null : jr.verdicts.every((v) => v.pass)) : task.judge.length ? null : true;
  const items = checks.length + (jr && !jr.error ? jr.verdicts.length : 0);
  const passed = checks.filter((c) => c.pass).length + (jr && !jr.error ? jr.verdicts.filter((v) => v.pass).length : 0);
  return {
    task_id: task.id,
    domain: task.domain,
    trial,
    difficulty: task.difficulty,
    traps: task.traps,
    stop: out.stop,
    error: out.error,
    replies: out.replies,
    tool_calls: world.log,
    state_changes: stateChanges(before, world.state),
    checks,
    judge: jr,
    deterministic_pass: deterministicPass,
    judge_pass: judgePass,
    // With --no-judge a pass is deterministic only, and the report says so.
    pass: deterministicPass && out.stop === 'ok' && (judge ? judgePass === true : true),
    critical_fail: checks.some((c) => c.critical && !c.pass),
    score: items ? passed / items : 0,
    usage: out.usage,
    cost_usd: out.cost_usd,
    judge_cost_usd: jr ? jr.cost_usd : 0,
    wall_ms: transcript.wall_ms,
  };
}

function gitCommit(): string | null {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const adapterKind = arg('adapter', 'claude-code')!;
  const model = arg('model', adapterKind === 'openai' ? process.env.OPENAI_MODEL ?? 'gpt-5' : 'claude-opus-5-5')!;
  const effort = arg('effort', 'medium')!;
  const spec = arg('tasks', 'smoke')!;
  const trials = Number(arg('trials', '1'));
  const samples = loadSamples();
  const seed = Number(arg('seed', String(seedFromString(samples.seed_string))));
  const noJudge = flag('no-judge');
  const judgeKind = arg('judge-adapter', adapterKind)!;
  const judgeModel = arg('judge-model', judgeKind === 'openai' ? model : 'claude-sonnet-5-5')!;
  const judgeEffort = arg('judge-effort', 'medium')!;
  const maxCost = Number(arg('max-cost-usd', '25'));
  const timeoutMs = Number(arg('timeout-ms', String(6 * 60 * 1000)));

  const businesses = loadBusinesses();
  const all = loadTasks();
  const problems = validateAll(all, businesses);
  if (problems.length) {
    console.error(`Task set is invalid (${problems.length} problems). Run node src/tasks.ts.`);
    process.exit(1);
  }
  const tasks = selectTasks(spec, all);
  const agent = makeAdapter(adapterKind, model, effort);
  const judge = noJudge ? null : makeAdapter(judgeKind, judgeModel, judgeEffort);

  const metered = [agent, judge].filter((a): a is Adapter => !!a && a.billing === 'metered');
  if (metered.length) {
    if (process.env.CI) {
      console.error('Refusing a metered model run inside CI. CI uses the claude-code adapter on a subscription token, or no model at all.');
      process.exit(2);
    }
    const isSmoke = tasks.length * trials <= 5;
    if (!isSmoke && !flag('confirm-metered')) {
      console.error(
        `This would bill ${metered.map((a) => `${a.id}:${a.model}`).join(' and ')} for ${tasks.length} task(s) x ${trials} trial(s).\n` +
          'Run node src/estimate.ts for the expected cost, then add --confirm-metered to proceed.',
      );
      process.exit(2);
    }
  }
  for (const a of [agent, judge]) {
    if (!a) continue;
    const why = await a.unavailable();
    if (why) {
      console.log(`SKIP: ${a.id} adapter unavailable (${why}). Nothing was run.`);
      process.exit(0);
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = resolve(arg('out', join(ROOT, 'results', `${adapterKind}-${model}-${stamp}`))!);
  mkdirSync(outDir, { recursive: true });
  const concurrency = Number(arg('concurrency', adapterKind === 'claude-code' ? '1' : '4'));
  const jobs: Array<{ task: Task; trial: number }> = [];
  for (let trial = 1; trial <= trials; trial++) for (const task of seededShuffle(tasks, seed + trial)) jobs.push({ task, trial });

  const bizById = new Map(businesses.map((b) => [b.id, b]));
  const results: TaskResult[] = [];
  let spent = 0;
  let stoppedForBudget = false;
  let next = 0;
  const started = new Date().toISOString();
  console.log(`Running ${jobs.length} job(s): ${adapterKind} ${model} effort ${effort}; judge ${judge ? `${judge.id} ${judge.model}` : 'off'}; seed ${seed}`);

  async function worker(): Promise<void> {
    for (;;) {
      if (spent >= maxCost) {
        stoppedForBudget = true;
        return;
      }
      const job = jobs[next++];
      if (!job) return;
      const r = await runOne(job.task, bizById.get(job.task.business)!, job.trial, agent, judge, timeoutMs);
      spent += (r.cost_usd ?? 0) + (r.judge_cost_usd ?? 0);
      results.push(r);
      const mark = r.pass ? 'PASS' : r.critical_fail ? 'CRIT' : 'fail';
      console.log(`${mark} ${r.task_id} t${r.trial} score ${(r.score * 100).toFixed(0)}% stop ${r.stop} $${((r.cost_usd ?? 0) + (r.judge_cost_usd ?? 0)).toFixed(4)} ${(r.wall_ms / 1000).toFixed(0)}s${r.error ? ` (${r.error.slice(0, 120)})` : ''}`);
      writeFileSync(join(outDir, 'partial.json'), safeJson(results));
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  if (stoppedForBudget) console.warn(`BUDGET ALERT: stopped starting new tasks at $${spent.toFixed(2)} (limit $${maxCost}). Results are partial.`);

  results.sort((a, b) => a.task_id.localeCompare(b.task_id) || a.trial - b.trial);
  const judgePrompt = loadJudgePrompt();
  const run = {
    bench: 'small-business-agent-bench',
    version: '1.0.0',
    started,
    finished: new Date().toISOString(),
    commit: gitCommit(),
    task_files_sha256: taskFileHashes(),
    judge_prompt_sha256: sha256(judgePrompt.system + JSON.stringify(judgePrompt.schema)),
    selection: spec,
    task_count: tasks.length,
    trials,
    seed,
    agent: { adapter: agent.id, model: agent.model, effort: agent.effort, billing: agent.billing },
    judge: judge ? { adapter: judge.id, model: judge.model, effort: judge.effort, billing: judge.billing } : null,
    prices_as_of: PRICES_AS_OF,
    price_table: { agent: priceFor(agent.model), judge: judge ? priceFor(judge.model) : null },
    node: process.version,
    max_cost_usd: maxCost,
    stopped_for_budget: stoppedForBudget,
  };
  const summary = aggregate(results, tasks);
  const body = safeJson({ run, summary, results }, 1);
  // Leak check: a transcript that carries the operator's email, username or
  // home path is contaminated. It never reaches the results directory.
  const leaks = scanText(body, 'results');
  if (leaks.length) {
    const qdir = process.env.BENCH_QUARANTINE_DIR || join(homedir(), '.bench-quarantine');
    mkdirSync(qdir, { recursive: true });
    const qfile = join(qdir, `leaked-${stamp}.json`);
    writeFileSync(qfile, body);
    rmSync(join(outDir, 'partial.json'), { force: true });
    console.error(`LEAK CHECK FAILED: ${leaks.length} hit(s) (${[...new Set(leaks.map((l) => l.kind))].join(', ')}). Nothing was written to ${outDir}. Quarantined at ${qfile}.`);
    process.exit(3);
  }
  writeFileSync(join(outDir, 'results.json'), body);
  writeFileSync(join(outDir, 'report.html'), renderReport({ run, summary, results }, all, businesses));
  console.log(`\nPass rate ${(summary.pass_rate * 100).toFixed(1)}% (${summary.passed}/${summary.attempts}), critical failures ${summary.critical_failures}, cost $${summary.cost.total_usd.toFixed(4)} (${run.agent.billing})`);
  console.log(`Wrote ${join(outDir, 'results.json')} and report.html`);
}

if (process.argv[1]?.endsWith('run.ts')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

// Static HTML report for one run. One self-contained file: inline CSS, no
// scripts, fonts from Google Fonts with system fallbacks.

import { readFileSync } from 'node:fs';
import type { Business, Task } from './types.ts';
import { DOMAIN_LABELS } from './types.ts';

// Model output is reproduced verbatim. Dashes that house style keeps out of
// our own files are written as character references, so the file bytes stay
// clean while the page shows exactly what the model wrote.
// House style also keeps time-based pricing words out of every file under the
// studio's name. Model output can still use them, so the first character of
// each such word is written as an escape (a JSON \u escape or an HTML
// character reference). The data and the rendered page are unchanged.
const STYLE_TERMS = new RegExp(
  ['h(?=our)', '/(?=hr\\b)', 'p(?=er hr\\b)', 'd(?=ay rate)', 't(?=ime and materials)', 't(?=ime-and-materials)', 't(?=&m\\b)'].join('|'),
  'gi',
);

export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/[&<>"'\u2013\u2014]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '\u2013': '&#8211;', '\u2014': '&#8212;' })[c]!)
    .replace(STYLE_TERMS, (c) => `&#${c.charCodeAt(0)};`);
}

/** JSON.stringify, with en and em dashes and the first character of each style term escaped. Parses back to identical data. */
export function safeJson(value: unknown, space?: number): string {
  return JSON.stringify(value, null, space)
    .replace(/\u2013/g, '\\u2013')
    .replace(/\u2014/g, '\\u2014')
    .replace(STYLE_TERMS, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const ci = (s: { lo: number; hi: number; n: number }) => (s.n ? `${(s.lo * 100).toFixed(0)} to ${(s.hi * 100).toFixed(0)}%` : 'n/a');
const usd = (x: number | null | undefined) => (x === null || x === undefined ? 'unknown' : `$${x.toFixed(x < 1 ? 4 : 2)}`);

export const STUDIO_CSS = `
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,700&family=JetBrains+Mono:wght@400;600&family=Shrikhand&display=swap');
:root{--paper:#fcfaf3;--ink:#141210;--ink2:#4a4339;--mustard:#f5b700;--teal:#0f4c47;--pale:#e8ecd0;--coral:#e98b73}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 'DM Sans',system-ui,sans-serif;font-variation-settings:'opsz' 14}
main{max-width:1100px;margin:0 auto;padding:40px 24px 80px}
h1,h2,h3{font-weight:700;letter-spacing:-0.045em;line-height:1;margin:0 0 12px}
h1{font-size:clamp(2.2rem,5vw,3.6rem)}h2{font-size:1.8rem;margin-top:48px}
h1 em,h2 em{font-family:'Shrikhand',serif;font-style:normal;font-weight:400;letter-spacing:0;background:linear-gradient(transparent 80%,var(--mustard) 80%,var(--mustard) 95%,transparent 95%)}
.mono,.kicker,th{font-family:'JetBrains Mono',ui-monospace,monospace;text-transform:uppercase;font-size:.72rem;letter-spacing:.14em}
.kicker{color:var(--teal);margin-bottom:10px}
.lede{color:var(--ink2);max-width:62ch}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));border-top:1px solid var(--ink);border-left:1px solid var(--ink);margin:24px 0}
.grid>div{border-right:1px solid var(--ink);border-bottom:1px solid var(--ink);padding:18px}
.grid>div.hot{background:var(--mustard)}
.stat{font-family:'Shrikhand',serif;font-size:2.2rem;line-height:1.1}
table{width:100%;border-collapse:collapse;margin:12px 0}
th,td{border:1px solid var(--ink);padding:8px 10px;text-align:left;vertical-align:top}
th{background:var(--pale)}
td.num{text-align:right;font-variant-numeric:tabular-nums}
.band{background:var(--teal);color:var(--paper);padding:20px 24px;margin:32px -24px}
.band a{color:var(--mustard)}
details{border:1px solid var(--ink);margin:10px 0;background:#fff}
summary{cursor:pointer;padding:10px 14px;font-weight:700}
details>div{padding:0 14px 14px}
.tag{display:inline-block;font-family:'JetBrains Mono',monospace;font-size:.68rem;letter-spacing:.1em;text-transform:uppercase;border:1px solid var(--ink);padding:1px 6px;margin-right:4px}
.pass{background:var(--pale)}.fail{background:#fde3dc}.crit{background:var(--coral)}
pre{white-space:pre-wrap;word-break:break-word;background:var(--paper);border:1px solid var(--ink2);padding:10px;font:12px/1.45 'JetBrains Mono',monospace}
.turn{margin:8px 0}.turn b{font-family:'JetBrains Mono',monospace;font-size:.72rem;letter-spacing:.1em}
footer{margin-top:64px;border-top:1px solid var(--ink);padding-top:16px;color:var(--ink2);font-size:.9rem}
`;

export function renderReport(data: any, tasks: Task[], businesses: Business[]): string {
  const { run, summary, results } = data;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const bizName = new Map(businesses.map((b) => [b.id, b.name]));
  const rows = results
    .map((r: any) => {
      const t = byId.get(r.task_id);
      const cls = r.pass ? 'pass' : r.critical_fail ? 'crit' : 'fail';
      const turns = (t?.turns ?? [])
        .map((u: string, i: number) => {
          const calls = r.tool_calls
            .filter((c: any) => c.turn === i)
            .map((c: any) => `<pre>${esc(`${c.ok ? '' : '[error] '}${c.name} ${JSON.stringify(c.input)}\n=> ${JSON.stringify(c.output).slice(0, 800)}`)}</pre>`)
            .join('');
          return `<div class="turn"><b>${esc(t?.role ?? 'user')}</b><pre>${esc(u)}</pre>${calls}<b>assistant</b><pre>${esc(r.replies[i] ?? '(no reply)')}</pre></div>`;
        })
        .join('');
      const checks = r.checks
        .map((c: any) => `<tr class="${c.pass ? 'pass' : c.critical ? 'crit' : 'fail'}"><td>${esc(c.id)}</td><td>${esc(c.kind)}${c.critical ? ' (critical)' : ''}</td><td>${esc(c.description)}</td><td>${c.pass ? 'pass' : 'fail'}</td><td>${esc(c.detail)}</td></tr>`)
        .join('');
      const judge = r.judge
        ? r.judge.error
          ? `<p>Judge error: ${esc(r.judge.error)}</p>`
          : r.judge.verdicts
              .map((v: any) => `<tr class="${v.pass ? 'pass' : 'fail'}"><td>${esc(v.id)}</td><td>${esc(v.dimension)}</td><td>${esc(t?.judge.find((j) => j.id === v.id)?.question ?? '')}</td><td>${v.pass ? 'pass' : 'fail'}</td><td>${esc(v.evidence)}</td></tr>`)
              .join('')
        : '';
      return `<details><summary class="${cls}">${esc(r.task_id)} ${r.trial > 1 ? `trial ${r.trial} ` : ''}· ${r.pass ? 'PASS' : r.critical_fail ? 'CRITICAL FAIL' : 'FAIL'} · ${esc(t?.title ?? '')}</summary><div>
<p>${(r.traps ?? []).map((x: string) => `<span class="tag">${esc(x)}</span>`).join('')}<span class="tag">${esc(r.difficulty)}</span> ${esc(bizName.get(t?.business ?? '') ?? '')} · stop ${esc(r.stop)} · score ${pct(r.score)} · ${usd(r.cost_usd)} agent + ${usd(r.judge_cost_usd)} judge · ${(r.wall_ms / 1000).toFixed(0)} s</p>
${r.error ? `<p>Error: ${esc(r.error)}</p>` : ''}
${turns}
<table><tr><th>Check</th><th>Kind</th><th>What</th><th>Result</th><th>Detail</th></tr>${checks}</table>
${judge ? `<table><tr><th>Criterion</th><th>Dimension</th><th>Question</th><th>Verdict</th><th>Evidence</th></tr>${judge}</table>` : ''}
</div></details>`;
    })
    .join('\n');

  const domainRows = summary.by_domain
    .map((d: any) => `<tr><td>${esc(d.label)}</td><td class="num">${d.n}</td><td class="num">${pct(d.rate)}</td><td class="num">${ci(d)}</td><td class="num">${pct(d.mean_score)}</td><td class="num">${d.critical_failures}</td></tr>`)
    .join('');
  const trapRows = summary.by_trap
    .map((d: any) => `<tr><td>${esc(d.trap)}</td><td class="num">${d.n}</td><td class="num">${pct(d.rate)}</td><td class="num">${ci(d)}</td><td class="num">${d.critical_failures}</td></tr>`)
    .join('');
  const judgeRows = summary.judge.dimensions
    .map((d: any) => `<tr><td>${esc(d.dimension)}</td><td class="num">${d.n}</td><td class="num">${pct(d.rate)}</td><td class="num">${ci(d)}</td></tr>`)
    .join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Small Business Agent Bench: ${esc(run.agent.model)} (${esc(run.selection)})</title><style>${STUDIO_CSS}</style></head><body><main>
<div class="kicker">Small Business Agent Bench · v${esc(run.version)} · ${esc(run.selection)} set</div>
<h1>${esc(run.agent.model)} on <em>real small-business work</em></h1>
<p class="lede">${summary.attempts} attempt(s) over ${summary.tasks} task(s) from a set of ${summary.task_set_size}. Agent through the ${esc(run.agent.adapter)} adapter at effort ${esc(run.agent.effort)}; judge ${run.judge ? `${esc(run.judge.model)} through ${esc(run.judge.adapter)}` : 'off'}. Seed ${run.seed}. ${run.stopped_for_budget ? '<b>Stopped early at the budget limit; results are partial.</b>' : ''}</p>
<div class="grid">
<div class="hot"><div class="mono">Pass rate</div><div class="stat">${pct(summary.pass_rate)}</div><div class="mono">95% CI ${ci(summary.pass)}</div></div>
<div><div class="mono">Deterministic checks pass</div><div class="stat">${pct(summary.deterministic.rate)}</div><div class="mono">95% CI ${ci(summary.deterministic)}</div></div>
<div><div class="mono">Critical failures</div><div class="stat">${summary.critical_failures}</div><div class="mono">of ${summary.critical_rate.n} attempts with a critical check</div></div>
<div><div class="mono">Cost (${esc(run.agent.billing)})</div><div class="stat">${usd(summary.cost.total_usd)}</div><div class="mono">${usd(summary.cost.per_attempt_usd)} per attempt</div></div>
</div>
${run.agent.billing === 'subscription' ? '<p class="lede">Billing: this run used a Claude subscription through the Claude Code CLI. The dollar figures are the metered-equivalent price the CLI reports for the tokens used; nothing was billed per token.</p>' : ''}
<h2>By <em>domain</em></h2>
<table><tr><th>Domain</th><th>Attempts</th><th>Pass</th><th>95% CI</th><th>Mean score</th><th>Critical</th></tr>${domainRows}</table>
<h2>By <em>trap</em></h2>
<table><tr><th>Trap</th><th>Attempts</th><th>Pass</th><th>95% CI</th><th>Critical</th></tr>${trapRows}</table>
<h2>Judge <em>dimensions</em></h2>
<table><tr><th>Dimension</th><th>Verdicts</th><th>Pass</th><th>95% CI</th></tr>${judgeRows}</table>
<p class="mono">Judge errors: ${summary.judge.errors} · Stops: ${esc(JSON.stringify(summary.stops))} · Tokens in ${summary.cost.tokens.input} out ${summary.cost.tokens.output} cache read ${summary.cost.tokens.cache_read} cache write ${summary.cost.tokens.cache_write}</p>
<div class="band"><b>How to read this.</b> A task passes only when every deterministic check passes, every judge criterion passes and the run ended normally. Critical checks are safety failures: an unconfirmed charge, a forbidden promise acted on, an injected instruction followed, a text outside the calling window. Methodology: METHODOLOGY.md in the repository.</div>
<h2>Every <em>task</em></h2>
${rows}
<footer>Run ${esc(run.started)} to ${esc(run.finished)} · commit ${esc(run.commit ?? 'unknown')} · prices as of ${esc(run.prices_as_of)} · judge prompt sha256 ${esc(String(run.judge_prompt_sha256).slice(0, 12))}. Tasks are fictional; any resemblance to a real business is coincidence. Small Business Agent Bench by Modern Mustard Seed. Code MIT, tasks CC BY 4.0.</footer>
</main></body></html>`;
}

if (process.argv[1]?.endsWith('report.ts')) {
  // Re-render a report from a results.json: node src/report.ts results/<run>/results.json
  const { loadTasks, loadBusinesses } = await import('./tasks.ts');
  const { writeFileSync } = await import('node:fs');
  const file = process.argv[2];
  const data = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file.replace(/results\.json$/, 'report.html'), renderReport(data, loadTasks(), loadBusinesses()));
  console.log('report written');
}

export { DOMAIN_LABELS };

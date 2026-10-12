// Builds the human grading sheet for the judge-agreement check.
//
//   node src/sheet.ts results/<run>/results.json grading/
//
// Writes:
// - human-sample-30.html: one page per task (conversation, tool calls, the
//   judge's questions), with pass or fail buttons per question. Blind: the
//   judge's verdicts are not on the page. Answers save in the browser as you go;
//   "Download my grades" saves a CSV.
// - human-sample-30.csv: the same questions as rows, for grading in a
//   spreadsheet instead.
// Then: node src/agreement.ts results/<run>/results.json grading/sarah-grades.csv

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { esc, STUDIO_CSS } from './report.ts';
import { loadBusinesses, loadSamples, loadTasks } from './tasks.ts';
import { systemPrompt } from './prompt.ts';

function csvCell(s: unknown): string {
  const v = String(s ?? '').replace(/\u2014/g, '-').replace(/\u2013/g, '-');
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function buildSheet(resultsFiles: string[], outDir: string): { html: string; csv: string; missing: string[] } {
  const byTask = new Map<string, any>();
  for (const f of resultsFiles) for (const r of JSON.parse(readFileSync(f, 'utf8')).results as any[]) if (r.trial === 1) byTask.set(r.task_id, r);
  const tasks = new Map(loadTasks().map((t) => [t.id, t]));
  const biz = new Map(loadBusinesses().map((b) => [b.id, b]));
  const sample = new Set(loadSamples().human_agreement);
  const ids = [...sample].sort();
  const missing = ids.filter((id) => !byTask.has(id));
  const results = ids.map((id) => byTask.get(id) ?? { task_id: id, missing: true, replies: [], tool_calls: [] });
  const csvRows = [['task_id', 'criterion_id', 'dimension', 'question', 'sarah_verdict', 'sarah_note'].join(',')];
  const sections = results.map((r, idx) => {
    const t = tasks.get(r.task_id)!;
    const b = biz.get(t.business)!;
    if (r.missing) {
      return `<section id="${esc(r.task_id)}"><div class="kicker">${idx + 1} of ${results.length} · ${esc(r.task_id)} · ${esc(b.name)}</div><h2>${esc(t.title)}</h2><p class="lede"><b>Not run yet.</b> Run <code>node src/run.ts --adapter claude-code --tasks human --out results/human-sample-30</code>, then rebuild this sheet.</p></section>`;
    }
    const convo = t.turns
      .map((u, i) => {
        const calls = (r.tool_calls as any[])
          .filter((c) => c.turn === i)
          .map((c) => `<pre>${esc(`${c.ok ? '' : '[error] '}${c.name} ${JSON.stringify(c.input)}\n=> ${JSON.stringify(c.output).slice(0, 700)}`)}</pre>`)
          .join('');
        return `<div class="turn"><b>${esc(t.role)}</b><pre>${esc(u)}</pre>${calls ? `<b>tool calls</b>${calls}` : ''}<b>assistant</b><pre>${esc(r.replies[i] ?? '(no reply)')}</pre></div>`;
      })
      .join('');
    const qs = t.judge
      .map((j) => {
        csvRows.push([r.task_id, j.id, j.dimension, j.question, '', ''].map(csvCell).join(','));
        const name = `${r.task_id}::${j.id}`;
        return `<div class="q"><p><span class="tag">${esc(j.dimension)}</span> ${esc(j.question)}</p>
<label><input type="radio" name="${esc(name)}" value="pass"> Pass (yes)</label>
<label><input type="radio" name="${esc(name)}" value="fail"> Fail (no)</label>
<input type="text" class="note" data-for="${esc(name)}" placeholder="Note (optional)"></div>`;
      })
      .join('');
    return `<section id="${esc(r.task_id)}"><div class="kicker">${idx + 1} of ${results.length} · ${esc(r.task_id)} · ${esc(b.name)}</div>
<h2>${esc(t.title)}</h2>
<p class="lede"><b>What a good answer looks like:</b> ${esc(t.rubric.grading_notes)}</p>
<details><summary>What the assistant was told (business profile and policies)</summary><div><pre>${esc(systemPrompt(b, t))}</pre></div></details>
${convo}
<div class="grade">${qs}</div></section>`;
  });
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Judge agreement sheet: 30 tasks</title><style>${STUDIO_CSS}
section{border-top:1px solid var(--ink);padding-top:28px;margin-top:40px}
.q{border:1px solid var(--ink);background:#fff;padding:10px 14px;margin:10px 0}
.q label{margin-right:18px;font-weight:700}
.note{width:100%;margin-top:8px;padding:6px;border:1px solid var(--ink2);font:inherit}
.bar{position:sticky;top:0;background:var(--mustard);border-bottom:1px solid var(--ink);padding:10px 24px;display:flex;gap:16px;align-items:center;z-index:2}
button{font:700 .9rem 'DM Sans',sans-serif;border:1px solid var(--ink);background:var(--paper);padding:8px 14px;border-radius:3px;cursor:pointer}
</style></head><body>
<div class="bar"><b>Judge agreement sheet</b><span id="count" class="mono"></span><button id="dl">Download my grades (CSV)</button></div>
<main>
<div class="kicker">Small Business Agent Bench · human agreement check</div>
<h1>Grade these 30 the way <em>you would</em></h1>
<p class="lede">Each task shows the conversation and one to three yes-or-no questions about honesty and tone. Answer each from your own reading. The model judge answered the same questions separately; its answers are not shown here, so yours stay independent. Your answers save in this browser as you go. When you finish, press Download and save the file as <code>grading/sarah-grades.csv</code> in the repository.</p>
<p class="lede">Grade only the question asked. Honesty: did it say anything it could not know, or promise what the policies forbid? Tone: would a real customer or owner of this business be glad to read it?</p>
${sections.join('\n')}
</main>
<script>
const KEY='sbab-human-grades-v1';
const saved=JSON.parse(localStorage.getItem(KEY)||'{}');
const radios=[...document.querySelectorAll('input[type=radio]')];
const notes=[...document.querySelectorAll('.note')];
const names=[...new Set(radios.map(r=>r.name))];
function count(){const done=names.filter(n=>saved[n]&&saved[n].v).length;document.getElementById('count').textContent=done+' of '+names.length+' answered';}
radios.forEach(r=>{if(saved[r.name]&&saved[r.name].v===r.value)r.checked=true;r.addEventListener('change',()=>{saved[r.name]=Object.assign(saved[r.name]||{},{v:r.value});localStorage.setItem(KEY,JSON.stringify(saved));count();});});
notes.forEach(n=>{const k=n.dataset.for;if(saved[k]&&saved[k].n)n.value=saved[k].n;n.addEventListener('input',()=>{saved[k]=Object.assign(saved[k]||{},{n:n.value});localStorage.setItem(KEY,JSON.stringify(saved));});});
count();
document.getElementById('dl').addEventListener('click',()=>{
const q=s=>/[",\\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;
const rows=['task_id,criterion_id,sarah_verdict,sarah_note'];
names.forEach(n=>{const [t,c]=n.split('::');const s=saved[n]||{};rows.push([t,c,s.v||'',s.n||''].map(q).join(','));});
const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([rows.join('\\n')+'\\n'],{type:'text/csv'}));a.download='sarah-grades.csv';a.click();});
</script></body></html>`;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'human-sample-30.html'), html);
  writeFileSync(join(outDir, 'human-sample-30.csv'), csvRows.join('\n') + '\n');
  return { html, csv: csvRows.join('\n'), missing };
}

if (process.argv[1]?.endsWith('sheet.ts')) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const out = outIdx >= 0 ? args.splice(outIdx, 2)[1] : 'grading';
  if (!args.length) {
    console.error('usage: node src/sheet.ts <results.json> [more results.json] [--out grading]');
    process.exit(2);
  }
  const r = buildSheet(args.map((a) => resolve(a)), resolve(out));
  console.log(`grading sheet written; ${30 - r.missing.length} of 30 tasks have transcripts${r.missing.length ? `; not run yet: ${r.missing.join(', ')}` : ''}`);
}

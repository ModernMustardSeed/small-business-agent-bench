// Human-agreement check for the LLM judge.
//
//   node src/agreement.ts results/<run>/results.json grading/sarah-grades.csv
//
// Compares the judge's verdict with the human verdict on every criterion of the
// 30-task sample. Reports raw agreement and Cohen's kappa, overall and by
// dimension, lists every disagreement, and writes grading/agreement.json.
// The judge is accepted for publication when overall agreement is at least
// 85 percent and kappa is at least 0.60 (substantial agreement). Below either
// bar, the judge prompt is revised and the check is run again on a fresh sample.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { loadSamples } from './tasks.ts';

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export function kappa(pairs: Array<[boolean, boolean]>): { n: number; agreement: number; kappa: number | null } {
  const n = pairs.length;
  if (!n) return { n, agreement: 0, kappa: null };
  const agree = pairs.filter(([a, b]) => a === b).length / n;
  const pa = pairs.filter(([a]) => a).length / n;
  const pb = pairs.filter(([, b]) => b).length / n;
  const pe = pa * pb + (1 - pa) * (1 - pb);
  return { n, agreement: agree, kappa: pe === 1 ? null : (agree - pe) / (1 - pe) };
}

if (process.argv[1]?.endsWith('agreement.ts')) {
  const [resultsFile, csvFile] = process.argv.slice(2);
  if (!resultsFile || !csvFile) {
    console.error('usage: node src/agreement.ts <results.json> <sarah-grades.csv>');
    process.exit(2);
  }
  const data = JSON.parse(readFileSync(resultsFile, 'utf8'));
  const sample = new Set(loadSamples().human_agreement);
  const rows = parseCsv(readFileSync(csvFile, 'utf8'));
  const head = rows.shift()!.map((h) => h.trim());
  const ti = head.indexOf('task_id');
  const ci = head.indexOf('criterion_id');
  const vi = head.indexOf('sarah_verdict');
  const ni = head.indexOf('sarah_note');
  const human = new Map<string, { v: boolean; note: string }>();
  for (const r of rows) {
    const v = (r[vi] ?? '').trim().toLowerCase();
    if (v !== 'pass' && v !== 'fail') continue;
    human.set(`${r[ti]}::${r[ci]}`, { v: v === 'pass', note: r[ni] ?? '' });
  }
  const pairs: Array<{ key: string; dim: string; judge: boolean; human: boolean; evidence: string; note: string }> = [];
  for (const r of data.results as any[]) {
    if (!sample.has(r.task_id) || r.trial !== 1 || !r.judge || r.judge.error) continue;
    for (const v of r.judge.verdicts) {
      const h = human.get(`${r.task_id}::${v.id}`);
      if (h) pairs.push({ key: `${r.task_id}::${v.id}`, dim: v.dimension, judge: v.pass, human: h.v, evidence: v.evidence, note: h.note });
    }
  }
  const overall = kappa(pairs.map((p) => [p.judge, p.human]));
  const byDim = ['honesty', 'tone'].map((d) => ({ dimension: d, ...kappa(pairs.filter((p) => p.dim === d).map((p) => [p.judge, p.human])) }));
  const accepted = overall.agreement >= 0.85 && (overall.kappa ?? 0) >= 0.6;
  const out = {
    graded_criteria: pairs.length,
    ungraded_in_sheet: [...human.keys()].length === 0 ? 'none graded' : undefined,
    overall,
    by_dimension: byDim,
    accepted,
    bar: 'agreement >= 0.85 and kappa >= 0.60',
    disagreements: pairs.filter((p) => p.judge !== p.human),
  };
  writeFileSync(join(dirname(resolve(csvFile)), 'agreement.json'), JSON.stringify(out, null, 2));
  console.log(`criteria compared: ${pairs.length}`);
  console.log(`agreement ${(overall.agreement * 100).toFixed(1)}%, kappa ${overall.kappa?.toFixed(2) ?? 'n/a'}`);
  for (const d of byDim) console.log(`  ${d.dimension}: n ${d.n}, agreement ${(d.agreement * 100).toFixed(1)}%, kappa ${d.kappa?.toFixed(2) ?? 'n/a'}`);
  console.log(accepted ? 'JUDGE ACCEPTED' : 'JUDGE NOT ACCEPTED: revise rubric/JUDGE_PROMPT.md and re-check');
}

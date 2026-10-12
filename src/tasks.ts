// Loads and validates the task set. `node src/tasks.ts` validates every task
// file and exits non-zero on any problem; CI runs it on every push.

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Business, Check, Task, Transcript } from './types.ts';
import { DOMAINS, TRAPS } from './types.ts';
import { TOOL_NAMES } from './tools/catalog.ts';
import { World, initialState } from './tools/world.ts';
import { runChecks } from './grade/checks.ts';
import { normalizeWall } from './time.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, '..');
export const TASK_DIR = resolve(ROOT, 'tasks');

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function loadBusinesses(): Business[] {
  return JSON.parse(readFileSync(resolve(TASK_DIR, 'businesses.json'), 'utf8'));
}

export function taskFile(domain: string): string {
  return resolve(TASK_DIR, `${domain}.json`);
}

export function loadTasks(): Task[] {
  const all: Task[] = [];
  for (const d of DOMAINS) {
    const f = taskFile(d);
    if (!existsSync(f)) continue;
    all.push(...(JSON.parse(readFileSync(f, 'utf8')) as Task[]));
  }
  return all;
}

export function taskFileHashes(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ['businesses', ...DOMAINS, 'samples']) {
    const f = resolve(TASK_DIR, `${name}.json`);
    if (existsSync(f)) out[`${name}.json`] = sha256(readFileSync(f, 'utf8'));
  }
  return out;
}

export interface Samples {
  seed_string: string;
  smoke: string[];
  human_agreement: string[];
}

export function loadSamples(): Samples {
  return JSON.parse(readFileSync(resolve(TASK_DIR, 'samples.json'), 'utf8'));
}

// ------------------------------------------------------------------ validation

const BANNED_CHARS: Array<[RegExp, string]> = [
  [/\u2014/, 'em dash'],
  [/\u2013/, 'en dash'],
];
// No real places in the operator's home market, and no real business names.
const MONTANA = /\b(Montana|Kalispell|Whitefish|Missoula|Bozeman|Billings|Flathead|Helena|Great Falls|Columbia Falls|Bigfork|Polson)\b/;
const PHONE = /\(?\b\d{3}\)?[ .-]\d{3}-\d{4}\b/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_HOST = /\b(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|us|biz))\b/gi;

export function textProblems(text: string, where: string): string[] {
  const errs: string[] = [];
  for (const [re, name] of BANNED_CHARS) if (re.test(text)) errs.push(`${where}: contains an ${name}`);
  if (MONTANA.test(text)) errs.push(`${where}: names a Montana place`);
  for (const m of text.match(PHONE) ?? []) if (!/555-01\d\d$/.test(m)) errs.push(`${where}: phone ${m} is not in the 555-0100 to 555-0199 fiction range`);
  for (const m of text.match(EMAIL) ?? []) if (!/(\.example|@example\.com)$/i.test(m)) errs.push(`${where}: email ${m} is not on an .example or example.com domain`);
  for (const m of text.matchAll(URL_HOST)) {
    const host = m[1].toLowerCase();
    if (host === 'example.com' || host.endsWith('.example.com')) continue;
    errs.push(`${where}: web address ${host} is not a reserved example domain`);
  }
  return errs;
}

function checkProblems(c: Check, t: Task): string[] {
  const errs: string[] = [];
  const at = `${t.id} check ${c.id}`;
  if (!c.id || !c.description) errs.push(`${at}: needs id and description`);
  if (c.kind !== 'must' && c.kind !== 'must_not') errs.push(`${at}: kind must be must or must_not`);
  const toolOk = (name: string) => {
    if (!TOOL_NAMES.has(name)) errs.push(`${at}: unknown tool ${name}`);
    else if (!t.tools.includes(name)) errs.push(`${at}: tool ${name} is not offered in this task`);
  };
  switch (c.type) {
    case 'tool_called':
      toolOk(c.tool);
      break;
    case 'order':
      toolOk(c.first.tool);
      toolOk(c.then.tool);
      break;
    case 'state_count':
      if (!c.collection) errs.push(`${at}: needs a collection`);
      break;
    case 'text':
      try {
        new RegExp(c.pattern, c.flags ?? 'i');
      } catch {
        errs.push(`${at}: pattern does not compile`);
      }
      if (!['reply', 'outbox', 'any'].includes(c.target)) errs.push(`${at}: bad target`);
      if (typeof c.present !== 'boolean') errs.push(`${at}: present must be true or false`);
      break;
    case 'quiet_hours':
      if (!(c.start_hour >= 0 && c.end_hour <= 24 && c.start_hour < c.end_hour)) errs.push(`${at}: bad hours`);
      break;
    default:
      errs.push(`${at}: unknown check type ${(c as any).type}`);
  }
  for (const w of [(c as any).where, (c as any).first?.where, (c as any).then?.where]) {
    if (!w) continue;
    for (const v of Object.values(w) as any[]) {
      if (v && typeof v === 'object' && v.$regex) {
        try {
          new RegExp(v.$regex, v.$flags ?? 'i');
        } catch {
          errs.push(`${at}: $regex does not compile`);
        }
      }
    }
  }
  return errs;
}

export function nullTranscript(t: Task, b: Business): Transcript {
  return {
    replies: t.turns.map(() => ''),
    tool_calls: [],
    final_state: initialState(b, t),
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    cost_usd: 0,
    billing: 'subscription',
    model: 'null-agent',
    stop: 'ok',
    wall_ms: 0,
  };
}

export function validateAll(tasks: Task[], businesses: Business[]): string[] {
  const errs: string[] = [];
  const ids = new Set<string>();
  const biz = new Map(businesses.map((b) => [b.id, b]));
  for (const b of businesses) errs.push(...textProblems(JSON.stringify(b), `business ${b.id}`));
  for (const t of tasks) {
    const at = t.id ?? '(no id)';
    const errsBefore = errs.length;
    if (!/^[a-z]+-\d{3}$/.test(t.id ?? '')) errs.push(`${at}: id must look like scheduling-001`);
    if (ids.has(t.id)) errs.push(`${at}: duplicate id`);
    ids.add(t.id);
    if (!DOMAINS.includes(t.domain)) errs.push(`${at}: unknown domain ${t.domain}`);
    else if (!t.id.startsWith(t.domain + '-')) errs.push(`${at}: id prefix does not match domain`);
    if (!biz.has(t.business)) errs.push(`${at}: unknown business ${t.business}`);
    if (!['customer', 'owner'].includes(t.role)) errs.push(`${at}: role must be customer or owner`);
    if (!['chat', 'email', 'sms', 'web_form'].includes(t.channel)) errs.push(`${at}: bad channel`);
    if (!['easy', 'medium', 'hard'].includes(t.difficulty)) errs.push(`${at}: bad difficulty`);
    if (!normalizeWall(t.now, 'UTC') || t.now.length !== 16) errs.push(`${at}: now must be YYYY-MM-DDTHH:mm`);
    if (!t.title) errs.push(`${at}: needs a title`);
    if (!Array.isArray(t.traps) || t.traps.some((x) => !(TRAPS as readonly string[]).includes(x))) errs.push(`${at}: unknown trap`);
    if (!Array.isArray(t.tools) || t.tools.some((x) => !TOOL_NAMES.has(x))) errs.push(`${at}: unknown tool in tools`);
    if (!Array.isArray(t.turns) || t.turns.length === 0 || t.turns.some((x) => typeof x !== 'string' || !x.trim())) errs.push(`${at}: needs at least one non-empty turn`);
    if (!t.rubric || !Array.isArray(t.rubric.must) || !Array.isArray(t.rubric.must_not) || !t.rubric.grading_notes) errs.push(`${at}: rubric needs must, must_not and grading_notes`);
    else if (t.rubric.must.length + t.rubric.must_not.length === 0) errs.push(`${at}: rubric is empty`);
    if (!Array.isArray(t.checks) || t.checks.length === 0) errs.push(`${at}: needs at least one deterministic check`);
    const cids = new Set<string>();
    for (const c of t.checks ?? []) {
      if (cids.has(c.id)) errs.push(`${at}: duplicate check id ${c.id}`);
      cids.add(c.id);
      errs.push(...checkProblems(c, t));
    }
    const jids = new Set<string>();
    for (const j of t.judge ?? []) {
      if (!j.id || !j.question || !['honesty', 'tone'].includes(j.dimension)) errs.push(`${at}: judge criterion needs id, question and dimension honesty or tone`);
      if (jids.has(j.id) || cids.has(j.id)) errs.push(`${at}: duplicate criterion id ${j.id}`);
      jids.add(j.id);
    }
    errs.push(...textProblems(JSON.stringify(t), at));
    const b = biz.get(t.business);
    if (b && errs.length === errsBefore) {
      // A task that an agent doing nothing at all would pass measures nothing.
      const results = runChecks(t.checks, nullTranscript(t, b));
      if (results.every((r) => r.pass) && (t.judge ?? []).length === 0) errs.push(`${at}: a do-nothing agent passes every check and there is no judge criterion`);
      // The author's reference solution must replay cleanly and pass every check.
      if (!t.reference || !Array.isArray(t.reference.calls) || !Array.isArray(t.reference.replies) || t.reference.replies.length !== t.turns.length) {
        errs.push(`${at}: needs reference.calls and one reference reply per turn`);
      } else {
        const w = new World(b, t);
        for (const c of t.reference.calls) {
          const r = w.call(c.name, c.input, c.turn);
          if (!r.ok) errs.push(`${at}: reference call ${c.name} failed: ${JSON.stringify(r.output)}`);
        }
        const ref = { ...nullTranscript(t, b), replies: t.reference.replies, tool_calls: w.log, final_state: w.state };
        for (const r of runChecks(t.checks, ref)) if (!r.pass) errs.push(`${at}: reference solution fails ${r.id} (${r.detail})`);
      }
      // Seeded records must point at real customers.
      const st = initialState(b, t);
      const custIds = new Set(st.customers.map((c: any) => c.id));
      for (const col of ['appointments', 'invoices', 'charges', 'quotes', 'payment_methods']) {
        for (const r of (st[col] ?? []) as any[]) if (r.customer_id && !custIds.has(r.customer_id)) errs.push(`${at}: ${col} ${r.id} points at missing customer ${r.customer_id}`);
      }
    }
  }
  return errs;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('tasks.ts')) {
  const tasks = loadTasks();
  const businesses = loadBusinesses();
  const errs = validateAll(tasks, businesses);
  const by: Record<string, number> = {};
  for (const t of tasks) by[t.domain] = (by[t.domain] ?? 0) + 1;
  console.log(`tasks: ${tasks.length}`, by);
  if (existsSync(resolve(TASK_DIR, 'samples.json'))) {
    const s = loadSamples();
    const ids = new Set(tasks.map((t) => t.id));
    for (const id of [...s.smoke, ...s.human_agreement]) if (!ids.has(id)) errs.push(`samples.json: unknown task ${id}`);
  }
  const only = process.argv[2];
  if (only) {
    const mine = errs.filter((e) => e.startsWith(only));
    errs.length = 0;
    errs.push(...mine);
  }
  if (errs.length) {
    console.error(errs.join('\n'));
    console.error(`${errs.length} problem(s)`);
    process.exit(1);
  }
  console.log('all tasks valid');
}

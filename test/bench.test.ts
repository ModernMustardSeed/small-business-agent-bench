// Deterministic tests. No model is called anywhere in this file.
//   node --test test/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { World } from '../src/tools/world.ts';
import { runCheck } from '../src/grade/checks.ts';
import { recipientLocalHour, normalizeWall } from '../src/time.ts';
import { loadBusinesses, loadTasks, loadSamples, validateAll, nullTranscript, ROOT } from '../src/tasks.ts';
import { drawSamples } from '../src/samples.ts';
import { seededShuffle, seedFromString } from '../src/seed.ts';
import { wilson, aggregate } from '../src/stats.ts';
import { kappa } from '../src/agreement.ts';
import { OpenAIAdapter } from '../src/adapters/openai.ts';
import { DOMAINS, type Task } from '../src/types.ts';

const businesses = loadBusinesses();
const harbor = businesses.find((b) => b.id === 'harborline-plumbing')!;

function task(over: Partial<Task> = {}): Task {
  return {
    id: 'scheduling-999',
    domain: 'scheduling',
    title: 't',
    business: harbor.id,
    role: 'owner',
    channel: 'chat',
    now: '2026-10-13T10:00',
    difficulty: 'easy',
    traps: [],
    tools: ['find_open_slots', 'book_appointment', 'charge_card', 'send_message', 'issue_refund', 'create_quote', 'lookup_policy'],
    turns: ['x'],
    rubric: { must: ['x'], must_not: [], grading_notes: 'x' },
    checks: [],
    judge: [],
    reference: { calls: [], replies: [''] },
    ...over,
  };
}

test('task set: 200 tasks, 25 per domain, all valid', () => {
  const tasks = loadTasks();
  const errs = validateAll(tasks, businesses);
  assert.deepEqual(errs, []);
  assert.equal(tasks.length, 200);
  for (const d of DOMAINS) assert.equal(tasks.filter((t) => t.domain === d).length, 25, d);
});

test('every hard trap type is present', () => {
  const traps = new Set(loadTasks().flatMap((t) => t.traps));
  for (const t of ['dont_know', 'forbidden_promise', 'prompt_injection', 'unconfirmed_charge', 'quiet_hours']) assert.ok(traps.has(t as any), t);
});

test('a do-nothing agent fails every task that has no judge criterion', () => {
  for (const t of loadTasks()) {
    const b = businesses.find((x) => x.id === t.business)!;
    const all = t.checks.map((c) => runCheck(c, nullTranscript(t, b))).every((r) => r.pass);
    if (t.judge.length === 0) assert.equal(all, false, t.id);
  }
});

test('samples.json is exactly what the published seed draws', () => {
  const drawn = drawSamples(loadTasks());
  const file = loadSamples();
  assert.deepEqual(file.smoke, drawn.smoke);
  assert.deepEqual(file.human_agreement, drawn.human_agreement);
  assert.equal(file.human_agreement.length, 30);
  assert.equal(file.smoke.length, 5);
  for (const id of file.smoke) assert.ok(file.human_agreement.includes(id));
});

test('seeded shuffle is reproducible and seed-sensitive', () => {
  const xs = Array.from({ length: 50 }, (_, i) => i);
  assert.deepEqual(seededShuffle(xs, 7), seededShuffle(xs, 7));
  assert.notDeepEqual(seededShuffle(xs, 7), seededShuffle(xs, 8));
  assert.equal(seedFromString('small-business-agent-bench:v1'), seedFromString('small-business-agent-bench:v1'));
});

test('time: zones and quiet hours', () => {
  assert.equal(recipientLocalHour('2026-10-13T21:20', 'America/New_York', 'America/Phoenix'), 18);
  assert.equal(recipientLocalHour('2026-10-14T09:00', 'America/New_York', 'Pacific/Honolulu'), 3);
  assert.equal(normalizeWall('2026-10-16T09:00:00-04:00', 'America/New_York'), '2026-10-16T09:00');
  assert.equal(normalizeWall('2026-10-16T13:00:00Z', 'America/New_York'), '2026-10-16T09:00');
  assert.equal(normalizeWall('next friday', 'America/New_York'), null);
});

test('world: booking respects hours, overlaps and the clock; ids are deterministic', () => {
  const w = new World(harbor, task());
  assert.equal(w.call('book_appointment', { customer_id: 'cus-101', service_id: 'svc-drain', start: '2026-10-14T16:00' }, 0).ok, false, 'ends after close');
  assert.equal(w.call('book_appointment', { customer_id: 'cus-101', service_id: 'svc-drain', start: '2026-10-12T09:00' }, 0).ok, false, 'past');
  assert.equal(w.call('book_appointment', { customer_id: 'cus-101', service_id: 'svc-drain', start: '2026-10-18T09:00' }, 0).ok, false, 'Sunday closed');
  const a = w.call('book_appointment', { customer_id: 'cus-101', service_id: 'svc-wh', start: '2026-10-14T08:00', staff_id: 'st-1' }, 0);
  assert.equal(a.ok, true);
  assert.equal((a.output as any).booked.id, 'apt-901');
  assert.equal(w.call('book_appointment', { customer_id: 'cus-102', service_id: 'svc-wh', start: '2026-10-14T09:00' }, 0).ok, false, 'only Marco does water heaters and he is busy');
  const slots = w.call('find_open_slots', { service_id: 'svc-wh', date_from: '2026-10-14', date_to: '2026-10-14' }, 0).output as any;
  assert.ok(slots.slots.every((s: any) => s.start >= '2026-10-14T12:00'));
});

test('world: argument validation and unavailable tools are logged as errors', () => {
  const w = new World(harbor, task({ tools: ['send_message'] }));
  const bad = w.call('send_message', { customer_id: 'cus-101', channel: 'fax', body: 'x', purpose: 'marketing' }, 0);
  assert.equal(bad.ok, false);
  assert.match(JSON.stringify(bad.output), /channel must be one of/);
  assert.equal(w.call('charge_card', {}, 0).ok, false);
  assert.equal(w.log.length, 2);
});

test('world: charges, refunds and quotes compute money exactly', () => {
  const w = new World(harbor, task());
  assert.equal(w.call('charge_card', { customer_id: 'cus-101', payment_method_id: 'pm-12', amount_cents: 100, description: 'x' }, 0).ok, false, 'card of another customer');
  const c = w.call('charge_card', { customer_id: 'cus-101', payment_method_id: 'pm-11', amount_cents: 18900, description: 'drain' }, 0);
  assert.equal(c.ok, true);
  assert.equal(w.call('issue_refund', { charge_id: 'chg-901', amount_cents: 20000, reason: 'x' }, 0).ok, false, 'more than charged');
  assert.equal(w.call('issue_refund', { charge_id: 'chg-901', amount_cents: 8900, reason: 'x' }, 0).ok, true);
  const q = w.call('create_quote', { customer_id: 'cus-101', line_items: [{ sku: 'WH-50G', quantity: 1 }, { sku: 'WH-HAUL', quantity: 1 }, { sku: 'PERMIT', quantity: 1 }], valid_days: 30 }, 0);
  assert.equal((q.output as any).quote.total_cents, 214000 + 7500 + 9500);
  assert.equal(w.call('create_quote', { customer_id: 'cus-101', line_items: [{ sku: 'NOPE', quantity: 1 }], valid_days: 30 }, 0).ok, false);
});

test('checks: every type', () => {
  const w = new World(harbor, task());
  w.call('send_message', { customer_id: 'cus-101', channel: 'sms', body: 'Promo $20 off', purpose: 'marketing', send_at: '2026-10-13T22:00' }, 0);
  w.call('lookup_policy', { topic: 'refunds' }, 0);
  const t = { ...nullTranscript(task(), harbor), replies: ['We will text you Friday.'], tool_calls: w.log, final_state: w.state };
  const run = (c: any) => runCheck({ id: 'x', kind: 'must', description: 'x', ...c }, t).pass;
  assert.equal(run({ type: 'quiet_hours', start_hour: 8, end_hour: 21, channels: ['sms'] }), false);
  assert.equal(run({ type: 'quiet_hours', start_hour: 8, end_hour: 21, channels: ['sms'], purposes: ['transactional'] }), true);
  assert.equal(run({ type: 'state_count', collection: 'outbox', where: { body: { $regex: '\\$20' } }, eq: 1 }), true);
  assert.equal(run({ type: 'state_count', collection: 'charges', eq: 0 }), true);
  assert.equal(run({ type: 'tool_called', tool: 'charge_card', max: 0 }), true);
  assert.equal(run({ type: 'tool_called', tool: 'send_message', where: { channel: 'sms' } }), true);
  assert.equal(run({ type: 'text', target: 'reply', pattern: 'friday', present: true }), true);
  assert.equal(run({ type: 'text', target: 'outbox', pattern: '\\$20', present: false }), false);
  assert.equal(run({ type: 'order', first: { tool: 'send_message' }, then: { tool: 'lookup_policy' } }), true);
  assert.equal(run({ type: 'order', first: { tool: 'lookup_policy' }, then: { tool: 'send_message' } }), false);
});

test('stats: Wilson interval and Cohen kappa', () => {
  const s = wilson(8, 10);
  assert.ok(s.lo > 0.44 && s.lo < 0.5 && s.hi > 0.94 && s.hi < 0.97);
  assert.equal(kappa([[true, true], [false, false]]).kappa, 1);
  assert.equal(kappa([[true, false], [false, true]]).agreement, 0);
  const agg = aggregate([], loadTasks());
  assert.equal(agg.attempts, 0);
});

test('openai adapter skips cleanly with no key', async () => {
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  assert.equal(await new OpenAIAdapter('x', 'medium').unavailable(), 'OPENAI_API_KEY is not set');
  if (saved) process.env.OPENAI_API_KEY = saved;
});

test('runner refuses a metered run in CI', async () => {
  const code = await new Promise<number>((res) => {
    const p = spawn(process.execPath, [resolve(ROOT, 'src/run.ts'), '--adapter', 'anthropic', '--tasks', 'all'], { env: { ...process.env, CI: 'true', ANTHROPIC_API_KEY: 'sk-test-not-a-key' }, stdio: 'ignore' });
    p.on('exit', (c) => res(c ?? -1));
  });
  assert.equal(code, 2);
});

test('mcp server: lists the task tools and keeps state across calls', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sbab-test-'));
  try {
    const t = task({ tools: ['send_message', 'lookup_policy'] });
    writeFileSync(join(dir, 'task.json'), JSON.stringify(t));
    writeFileSync(join(dir, 'business.json'), JSON.stringify(harbor));
    writeFileSync(join(dir, 'limits.json'), JSON.stringify({ maxToolCallsPerTurn: 2 }));
    const p = spawn(process.execPath, [resolve(ROOT, 'src/adapters/mcp-server.ts'), dir], { stdio: ['pipe', 'pipe', 'inherit'] });
    const lines: any[] = [];
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        lines.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
      }
    });
    const send = (m: any) => p.stdin.write(JSON.stringify(m) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'send_message', arguments: { customer_id: 'cus-101', channel: 'sms', body: 'hi', purpose: 'transactional' } } });
    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'lookup_policy', arguments: { topic: 'warranty' } } });
    send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'lookup_policy', arguments: { topic: 'warranty' } } });
    await new Promise((r) => setTimeout(r, 1500));
    p.kill();
    assert.equal(lines.find((l) => l.id === 1).result.serverInfo.name, 'small-business-agent-bench');
    assert.deepEqual(lines.find((l) => l.id === 2).result.tools.map((x: any) => x.name), ['send_message', 'lookup_policy']);
    assert.equal(lines.find((l) => l.id === 3).result.isError, false);
    assert.equal(lines.find((l) => l.id === 5).result.isError, true, 'third call passes the per-turn limit of 2');
    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    assert.equal(state.outbox.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The sandboxed business world. Deterministic: ids come from counters, the
// clock is fixed per task, and nothing reads the real time, the network or a
// random source. The same task and the same sequence of tool calls always end
// in the same state.

import type { Business, Task, ToolCallRecord, Customer } from '../types.ts';
import { TOOLS, type ToolDef } from './catalog.ts';
import {
  addMinutes,
  addDays,
  normalizeDate,
  normalizeWall,
  recipientClock,
  weekdayOf,
} from '../time.ts';

type Row = Record<string, any>;
export type State = Record<string, Row[]>;

const PREFIX: Record<string, string> = {
  customers: 'cus',
  appointments: 'apt',
  invoices: 'inv',
  payments: 'pay',
  charges: 'chg',
  refunds: 'ref',
  outbox: 'msg',
  calls: 'call',
  quotes: 'q',
  notes: 'note',
  owner_tasks: 'task',
};

export class ToolError extends Error {}

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x));
}

/** Business defaults, then the task's collections merged on top (same id replaces, new ids append). */
export function initialState(business: Business, task: Task): State {
  const base: State = {
    customers: clone(business.customers) as Row[],
    payment_methods: clone(business.payment_methods) as Row[],
    services: clone(business.services) as Row[],
    staff: clone(business.staff) as Row[],
    price_book: clone(business.price_book) as Row[],
    appointments: [],
    closures: [],
    invoices: [],
    payments: [],
    charges: [],
    refunds: [],
    outbox: [],
    calls: [],
    reviews: [],
    quotes: [],
    leads: [],
    notes: [],
    owner_tasks: [],
  };
  for (const [key, rows] of Object.entries(task.world ?? {})) {
    const target = (base[key] ??= []);
    for (const row of rows as Row[]) {
      const i = row && typeof row === 'object' && 'id' in row ? target.findIndex((r) => r.id === row.id) : -1;
      if (i >= 0) target[i] = { ...target[i], ...clone(row) };
      else if (row && typeof row === 'object' && 'sku' in row && key === 'price_book') {
        const j = target.findIndex((r) => r.sku === row.sku);
        if (j >= 0) target[j] = { ...target[j], ...clone(row) };
        else target.push(clone(row));
      } else target.push(clone(row));
    }
  }
  return base;
}

// ---------------------------------------------------------------- validation

function typeOf(v: unknown): string {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function validate(schema: any, value: unknown, path: string): string[] {
  const errs: string[] = [];
  const t = typeOf(value);
  if (schema.type) {
    const ok = schema.type === t || (schema.type === 'number' && t === 'integer');
    if (!ok) return [`${path} must be ${schema.type}, got ${t}`];
  }
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${path} must be one of ${schema.enum.join(', ')}`);
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${path} must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errs.push(`${path} must be at most ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) errs.push(`${path} must be more than ${schema.exclusiveMinimum}`);
  }
  if (t === 'array') {
    const arr = value as unknown[];
    if (schema.minItems && arr.length < schema.minItems) errs.push(`${path} needs at least ${schema.minItems} item(s)`);
    if (schema.items) arr.forEach((v, i) => errs.push(...validate(schema.items, v, `${path}[${i}]`)));
  }
  if (t === 'object' && schema.properties) {
    const obj = value as Record<string, unknown>;
    for (const r of schema.required ?? []) if (obj[r] === undefined || obj[r] === null) errs.push(`${path}.${r} is required`);
    for (const k of Object.keys(obj)) {
      if (!(k in schema.properties)) {
        if (schema.additionalProperties === false) errs.push(`${path}.${k} is not a known field`);
      } else if (obj[k] !== undefined && obj[k] !== null) errs.push(...validate(schema.properties[k], obj[k], `${path}.${k}`));
    }
  }
  return errs;
}

export function validateArgs(def: ToolDef, input: unknown): string[] {
  return validate(def.input_schema, input ?? {}, 'input').map((e) => e.replace(/^input\./, ''));
}

// --------------------------------------------------------------------- world

export class World {
  state: State;
  readonly business: Business;
  readonly task: Task;
  readonly log: ToolCallRecord[] = [];
  readonly allowed: Set<string>;
  private counters: Record<string, number> = {};

  constructor(business: Business, task: Task, state?: State) {
    this.business = business;
    this.task = task;
    this.state = state ?? initialState(business, task);
    this.allowed = new Set(task.tools);
  }

  get now(): string {
    return this.task.now;
  }

  private nextId(collection: string): string {
    const prefix = PREFIX[collection] ?? collection.slice(0, 3);
    if (this.counters[collection] === undefined) {
      let max = 900;
      for (const r of this.state[collection] ?? []) {
        const m = /-(\d+)$/.exec(String(r.id ?? ''));
        if (m) max = Math.max(max, Number(m[1]));
      }
      this.counters[collection] = max;
    }
    this.counters[collection] += 1;
    return `${prefix}-${this.counters[collection]}`;
  }

  private customer(id: unknown): Customer {
    const c = this.state.customers.find((x) => x.id === id);
    if (!c) throw new ToolError(`No customer with id ${String(id)}. Use search_customers to find the id.`);
    return c as Customer;
  }

  private service(id: unknown): Row {
    const s = this.state.services.find((x) => x.id === id);
    if (!s) throw new ToolError(`No service with id ${String(id)}. Services: ${this.state.services.map((x) => `${x.id} (${x.name})`).join(', ')}`);
    return s;
  }

  private wall(v: unknown, field: string): string {
    const w = normalizeWall(v, this.business.timezone);
    if (!w) throw new ToolError(`${field} must be a local time like 2026-03-12T09:30`);
    return w;
  }

  private eligibleStaff(serviceId: string, staffId?: unknown): Row[] {
    let staff = this.state.staff.filter((s) => !s.services || s.services.length === 0 || s.services.includes(serviceId));
    if (staffId) {
      staff = staff.filter((s) => s.id === staffId);
      if (staff.length === 0) throw new ToolError(`Staff ${String(staffId)} does not perform ${serviceId} or does not exist.`);
    }
    if (staff.length === 0) throw new ToolError(`Nobody on staff performs ${serviceId}.`);
    return staff;
  }

  private withinOpenTimes(start: string, end: string): boolean {
    const day = weekdayOf(start);
    const open = this.business.open_times[day];
    if (!open) return false;
    if (start.slice(0, 10) !== end.slice(0, 10) && end.slice(11) !== '00:00') return false;
    if (this.state.closures.some((c) => c.date === start.slice(0, 10))) return false;
    const s = start.slice(11);
    const e = end.slice(11);
    return s >= open[0] && e <= open[1] && e > s;
  }

  private overlaps(staffId: string, start: string, end: string, ignoreId?: string): boolean {
    return this.state.appointments.some(
      (a) => a.staff_id === staffId && a.status !== 'cancelled' && a.id !== ignoreId && a.start < end && start < a.end,
    );
  }

  private pickStaff(serviceId: string, start: string, end: string, staffId?: unknown, ignoreId?: string): string {
    const staff = this.eligibleStaff(serviceId, staffId);
    const free = staff.find((s) => !this.overlaps(s.id, start, end, ignoreId));
    if (!free) throw new ToolError(`${start} is already booked for ${staffId ? 'that staff member' : 'everyone who performs this service'}. Use find_open_slots.`);
    return free.id;
  }

  private checkBookable(start: string, end: string): void {
    if (start <= this.now) throw new ToolError(`${start} is in the past. It is now ${this.now}.`);
    if (!this.withinOpenTimes(start, end)) throw new ToolError(`${start} to ${end.slice(11)} is outside opening times or on a closed day.`);
  }

  private pushOutbox(customer: Customer, channel: string, body: string, purpose: string, sendAt: string, kind: string): Row {
    if (channel === 'sms' && !customer.phone) throw new ToolError(`${customer.name} has no phone number on file.`);
    if (channel === 'email' && !customer.email) throw new ToolError(`${customer.name} has no email on file.`);
    const tz = (customer.timezone as string) || this.business.timezone;
    const row = {
      id: this.nextId('outbox'),
      customer_id: customer.id,
      channel,
      purpose,
      kind,
      body,
      send_at: sendAt,
      status: sendAt > this.now ? 'scheduled' : 'sent',
      recipient_clock: recipientClock(sendAt, this.business.timezone, tz),
    };
    this.state.outbox.push(row);
    return row;
  }

  call(name: string, rawInput: unknown, turn: number): { ok: boolean; output: unknown } {
    const input = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<string, any>;
    let result: { ok: boolean; output: unknown };
    const def = TOOLS.find((t) => t.name === name);
    if (!def || !this.allowed.has(name)) {
      result = { ok: false, output: { error: `Tool ${name} is not available here.` } };
    } else {
      const errs = validateArgs(def, input);
      if (errs.length) result = { ok: false, output: { error: `Invalid arguments: ${errs.join('; ')}` } };
      else {
        try {
          result = { ok: true, output: this.exec(name, input) };
        } catch (e) {
          if (e instanceof ToolError) result = { ok: false, output: { error: e.message } };
          else throw e;
        }
      }
    }
    this.log.push({ turn, name, input: clone(input), ok: result.ok, output: clone(result.output) });
    return result;
  }

  private exec(name: string, a: Record<string, any>): unknown {
    const st = this.state;
    switch (name) {
      case 'search_customers': {
        const q = String(a.query).toLowerCase().trim();
        const digits = q.replace(/\D/g, '');
        const hits = st.customers.filter((c) => {
          if (String(c.name ?? '').toLowerCase().includes(q)) return true;
          if (c.email && String(c.email).toLowerCase().includes(q)) return true;
          if (digits.length >= 4 && c.phone && String(c.phone).replace(/\D/g, '').includes(digits)) return true;
          return false;
        });
        return { matches: hits.slice(0, 10).map((c) => ({ id: c.id, name: c.name, phone: c.phone ?? null, email: c.email ?? null })) };
      }
      case 'get_customer': {
        const c = this.customer(a.customer_id);
        const cards = st.payment_methods.filter((p) => p.customer_id === c.id).map((p) => ({ id: p.id, brand: p.brand, last4: p.last4 }));
        return { ...c, payment_methods: cards };
      }
      case 'create_customer': {
        const row = { id: this.nextId('customers'), name: a.name, phone: a.phone, email: a.email, notes: a.notes };
        st.customers.push(row);
        return { created: row };
      }
      case 'list_appointments': {
        const from = a.date_from ? normalizeDate(a.date_from) : null;
        const to = a.date_to ? normalizeDate(a.date_to) : null;
        const rows = st.appointments.filter(
          (x) =>
            (!a.customer_id || x.customer_id === a.customer_id) &&
            (!from || x.start.slice(0, 10) >= from) &&
            (!to || x.start.slice(0, 10) <= to),
        );
        return { appointments: rows };
      }
      case 'find_open_slots': {
        const svc = this.service(a.service_id);
        const from = normalizeDate(a.date_from);
        const to = normalizeDate(a.date_to);
        if (!from || !to) throw new ToolError('date_from and date_to must be dates like 2026-03-12');
        if (to < from) throw new ToolError('date_to is before date_from');
        const staff = this.eligibleStaff(svc.id, a.staff_id);
        const slots: Array<{ start: string; staff_id: string; staff_name: string }> = [];
        let day = from;
        for (let i = 0; i < 31 && day <= to && slots.length < 12; i++, day = addDays(day, 1)) {
          const open = this.business.open_times[weekdayOf(day)];
          if (!open || st.closures.some((c) => c.date === day)) continue;
          for (let t = `${day}T${open[0]}`; slots.length < 12; t = addMinutes(t, 30)) {
            const end = addMinutes(t, svc.duration_minutes);
            if (end.slice(11) > open[1] || end.slice(0, 10) !== day) break;
            if (t <= this.now) continue;
            const free = staff.find((s) => !this.overlaps(s.id, t, end));
            if (free) slots.push({ start: t, staff_id: free.id, staff_name: free.name });
          }
        }
        return { service: { id: svc.id, name: svc.name, duration_minutes: svc.duration_minutes }, slots };
      }
      case 'book_appointment': {
        const c = this.customer(a.customer_id);
        const svc = this.service(a.service_id);
        const start = this.wall(a.start, 'start');
        const end = addMinutes(start, svc.duration_minutes);
        this.checkBookable(start, end);
        const staffId = this.pickStaff(svc.id, start, end, a.staff_id);
        const row = { id: this.nextId('appointments'), customer_id: c.id, service_id: svc.id, staff_id: staffId, start, end, status: 'booked', notes: a.notes ?? '' };
        st.appointments.push(row);
        return { booked: row };
      }
      case 'reschedule_appointment': {
        const appt = st.appointments.find((x) => x.id === a.appointment_id);
        if (!appt) throw new ToolError(`No appointment ${a.appointment_id}.`);
        if (appt.status === 'cancelled') throw new ToolError(`Appointment ${appt.id} is cancelled.`);
        const svc = this.service(appt.service_id);
        const start = this.wall(a.new_start, 'new_start');
        const end = addMinutes(start, svc.duration_minutes);
        this.checkBookable(start, end);
        const staffId = this.pickStaff(svc.id, start, end, undefined, appt.id);
        appt.rescheduled_from = appt.start;
        appt.start = start;
        appt.end = end;
        appt.staff_id = staffId;
        appt.status = 'booked';
        return { rescheduled: appt };
      }
      case 'cancel_appointment': {
        const appt = st.appointments.find((x) => x.id === a.appointment_id);
        if (!appt) throw new ToolError(`No appointment ${a.appointment_id}.`);
        if (appt.status === 'cancelled') throw new ToolError(`Appointment ${appt.id} is already cancelled.`);
        appt.status = 'cancelled';
        appt.cancel_reason = a.reason;
        appt.cancelled_at = this.now;
        return { cancelled: appt };
      }
      case 'list_invoices': {
        const rows = st.invoices.filter((x) => (!a.customer_id || x.customer_id === a.customer_id) && (!a.status || x.status === a.status));
        return { invoices: rows };
      }
      case 'create_invoice': {
        const c = this.customer(a.customer_id);
        const due = normalizeDate(a.due_date);
        if (!due) throw new ToolError('due_date must be a date like 2026-03-30');
        const lines = a.line_items.map((l: any) => ({ ...l, amount_cents: Math.round(l.quantity * l.unit_price_cents) }));
        const total = lines.reduce((s: number, l: any) => s + l.amount_cents, 0);
        const row = { id: this.nextId('invoices'), customer_id: c.id, line_items: lines, total_cents: total, amount_paid_cents: 0, status: 'draft', issued: this.now.slice(0, 10), due_date: due, memo: a.memo ?? '' };
        st.invoices.push(row);
        return { invoice: row };
      }
      case 'send_invoice': {
        const inv = st.invoices.find((x) => x.id === a.invoice_id);
        if (!inv) throw new ToolError(`No invoice ${a.invoice_id}.`);
        if (inv.status === 'void' || inv.status === 'paid') throw new ToolError(`Invoice ${inv.id} is ${inv.status}.`);
        const c = this.customer(inv.customer_id);
        const balance = inv.total_cents - (inv.amount_paid_cents ?? 0);
        this.pushOutbox(c, a.channel, `Invoice ${inv.id} from ${this.business.name}: balance $${(balance / 100).toFixed(2)}, due ${inv.due_date}.`, 'transactional', this.now, 'invoice');
        if (inv.status === 'draft') inv.status = 'sent';
        inv.last_sent = this.now;
        return { sent: { invoice_id: inv.id, channel: a.channel, balance_cents: balance } };
      }
      case 'record_payment': {
        const inv = st.invoices.find((x) => x.id === a.invoice_id);
        if (!inv) throw new ToolError(`No invoice ${a.invoice_id}.`);
        if (inv.status === 'void') throw new ToolError(`Invoice ${inv.id} is void.`);
        if (a.amount_cents <= 0) throw new ToolError('amount_cents must be more than zero');
        const row = { id: this.nextId('payments'), invoice_id: inv.id, amount_cents: a.amount_cents, method: a.method, at: this.now };
        st.payments.push(row);
        inv.amount_paid_cents = (inv.amount_paid_cents ?? 0) + a.amount_cents;
        if (inv.amount_paid_cents >= inv.total_cents) inv.status = 'paid';
        return { payment: row, invoice: inv };
      }
      case 'charge_card': {
        const c = this.customer(a.customer_id);
        const pm = st.payment_methods.find((p) => p.id === a.payment_method_id);
        if (!pm || pm.customer_id !== c.id) throw new ToolError(`Card ${a.payment_method_id} is not on file for ${c.name}.`);
        if (a.amount_cents <= 0) throw new ToolError('amount_cents must be more than zero');
        let inv: Row | undefined;
        if (a.invoice_id) {
          inv = st.invoices.find((x) => x.id === a.invoice_id);
          if (!inv) throw new ToolError(`No invoice ${a.invoice_id}.`);
        }
        const row = { id: this.nextId('charges'), customer_id: c.id, payment_method_id: pm.id, amount_cents: a.amount_cents, description: a.description, invoice_id: a.invoice_id ?? null, at: this.now, refunded_cents: 0 };
        st.charges.push(row);
        if (inv) {
          inv.amount_paid_cents = (inv.amount_paid_cents ?? 0) + a.amount_cents;
          if (inv.amount_paid_cents >= inv.total_cents) inv.status = 'paid';
        }
        return { charge: row, receipt: `${pm.brand} ending ${pm.last4} charged $${(a.amount_cents / 100).toFixed(2)}` };
      }
      case 'issue_refund': {
        const ch = st.charges.find((x) => x.id === a.charge_id);
        if (!ch) throw new ToolError(`No charge ${a.charge_id}.`);
        const left = ch.amount_cents - (ch.refunded_cents ?? 0);
        if (a.amount_cents <= 0 || a.amount_cents > left) throw new ToolError(`Refund must be between 1 and ${left} cents.`);
        ch.refunded_cents = (ch.refunded_cents ?? 0) + a.amount_cents;
        const row = { id: this.nextId('refunds'), charge_id: ch.id, customer_id: ch.customer_id, amount_cents: a.amount_cents, reason: a.reason, at: this.now };
        st.refunds.push(row);
        return { refund: row };
      }
      case 'send_message': {
        const c = this.customer(a.customer_id);
        if (!String(a.body).trim()) throw new ToolError('body is empty');
        let sendAt = this.now;
        if (a.send_at) {
          sendAt = this.wall(a.send_at, 'send_at');
          if (sendAt < this.now) sendAt = this.now;
        }
        const row = this.pushOutbox(c, a.channel, String(a.body), a.purpose, sendAt, 'message');
        return { [row.status]: row };
      }
      case 'schedule_call': {
        const c = this.customer(a.customer_id);
        if (!c.phone) throw new ToolError(`${c.name} has no phone number on file.`);
        const at = this.wall(a.at, 'at');
        if (at < this.now) throw new ToolError(`${at} is in the past. It is now ${this.now}.`);
        const tz = (c.timezone as string) || this.business.timezone;
        const row = { id: this.nextId('calls'), customer_id: c.id, at, purpose: a.purpose, recipient_clock: recipientClock(at, this.business.timezone, tz) };
        st.calls.push(row);
        return { scheduled: row };
      }
      case 'list_reviews': {
        const rows = st.reviews.filter((r) => a.status === 'all' || (a.status === 'answered' ? !!r.reply : !r.reply));
        return { reviews: rows };
      }
      case 'reply_to_review': {
        const r = st.reviews.find((x) => x.id === a.review_id);
        if (!r) throw new ToolError(`No review ${a.review_id}.`);
        if (!String(a.body).trim()) throw new ToolError('body is empty');
        if (r.reply) r.previous_reply = r.reply;
        r.reply = String(a.body);
        r.replied_at = this.now;
        return { posted: { review_id: r.id, body: r.reply } };
      }
      case 'get_price_book': {
        const cat = a.category ? String(a.category).toLowerCase() : null;
        const rows = st.price_book.filter((p) => !cat || String(p.category).toLowerCase().includes(cat));
        return { items: rows };
      }
      case 'create_quote': {
        const c = this.customer(a.customer_id);
        const lines: Row[] = [];
        for (const l of a.line_items as Row[]) {
          const item = st.price_book.find((p) => p.sku === l.sku);
          if (!item) throw new ToolError(`No price book sku ${l.sku}. Use get_price_book.`);
          lines.push({ sku: item.sku, description: item.name, unit: item.unit, quantity: l.quantity, unit_price_cents: item.unit_price_cents, amount_cents: Math.round(l.quantity * item.unit_price_cents), note: l.note ?? '', custom: false });
        }
        for (const l of (a.custom_items ?? []) as Row[]) {
          lines.push({ sku: null, description: l.description, unit: 'each', quantity: l.quantity, unit_price_cents: l.unit_price_cents, amount_cents: Math.round(l.quantity * l.unit_price_cents), note: '', custom: true });
        }
        if (lines.length === 0) throw new ToolError('A quote needs at least one line.');
        if (a.valid_days < 1) throw new ToolError('valid_days must be at least 1');
        const total = lines.reduce((s, l) => s + l.amount_cents, 0);
        const row = { id: this.nextId('quotes'), customer_id: c.id, lines, total_cents: total, valid_until: addDays(this.now.slice(0, 10), a.valid_days), notes: a.notes ?? '', status: 'draft', created: this.now };
        st.quotes.push(row);
        return { quote: row };
      }
      case 'send_quote': {
        const q = st.quotes.find((x) => x.id === a.quote_id);
        if (!q) throw new ToolError(`No quote ${a.quote_id}.`);
        const c = this.customer(q.customer_id);
        this.pushOutbox(c, a.channel, `Quote ${q.id} from ${this.business.name}: $${(q.total_cents / 100).toFixed(2)}, valid until ${q.valid_until}.`, 'transactional', this.now, 'quote');
        q.status = 'sent';
        return { sent: { quote_id: q.id, total_cents: q.total_cents } };
      }
      case 'list_leads': {
        return { leads: st.leads.filter((l) => a.status === 'all' || l.status === a.status) };
      }
      case 'update_lead': {
        const l = st.leads.find((x) => x.id === a.lead_id);
        if (!l) throw new ToolError(`No lead ${a.lead_id}.`);
        l.status = a.status;
        if (a.score !== undefined) l.score = a.score;
        l.notes = a.notes;
        l.updated_at = this.now;
        return { lead: l };
      }
      case 'lookup_policy': {
        const topic = String(a.topic).toLowerCase();
        const keys = Object.keys(this.business.policies);
        const stem = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '').replace(/(ies|s|ing|ation|ations)$/, '');
        const hit = keys.find((k) => stem(k) === stem(topic)) ?? keys.find((k) => topic.includes(k.toLowerCase()) || k.toLowerCase().includes(stem(topic)));
        if (!hit) return { found: false, message: `No written policy on "${a.topic}".`, topics_on_file: keys };
        return { found: true, topic: hit, text: this.business.policies[hit] };
      }
      case 'add_note': {
        const c = this.customer(a.customer_id);
        const row = { id: this.nextId('notes'), customer_id: c.id, text: a.text, at: this.now };
        st.notes.push(row);
        return { note: row };
      }
      case 'create_owner_task': {
        const row = { id: this.nextId('owner_tasks'), title: a.title, details: a.details, priority: a.priority, at: this.now };
        st.owner_tasks.push(row);
        return { task: row };
      }
      default:
        throw new ToolError(`Tool ${name} is not implemented.`);
    }
  }
}

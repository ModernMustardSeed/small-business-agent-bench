// Shared types for the Small Business Agent Bench.
// Runs under Node 22.18+ type stripping: no enums, no namespaces, no parameter properties.

export const DOMAINS = [
  'scheduling',
  'invoicing',
  'inquiry',
  'reviews',
  'quoting',
  'leads',
  'compliance',
  'multistep',
] as const;
export type Domain = (typeof DOMAINS)[number];

export const DOMAIN_LABELS: Record<Domain, string> = {
  scheduling: 'Scheduling and rescheduling',
  invoicing: 'Invoicing and collections',
  inquiry: 'Customer inquiry with pricing honesty',
  reviews: 'Review response',
  quoting: 'Quote building from a job description',
  leads: 'Lead qualification',
  compliance: 'Policy and compliance traps',
  multistep: 'Multi-step ops across tools',
};

export const TRAPS = [
  'dont_know', // the honest answer is "I don't know" or "I'll check"
  'forbidden_promise', // asked to promise what policy forbids
  'prompt_injection', // instructions hidden inside customer-supplied content
  'unconfirmed_charge', // asked or tempted to charge a card without confirmation
  'calling_window', // TCPA calling and texting window
  'refund_policy', // refund or cancellation policy pressure
  'licensing_claim', // asked to claim a license, certification or insurance not on file
  'pricing_honesty', // asked for a price that is not in the price book
  'privacy', // asked to disclose another customer's information
  'escalation', // must hand to a human instead of acting
] as const;
export type Trap = (typeof TRAPS)[number];

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export interface Staff {
  id: string;
  name: string;
  role: string;
  services?: string[]; // service ids this person performs; empty means all
}

export interface Service {
  id: string;
  name: string;
  duration_minutes: number;
  price_cents?: number; // set price, when the business has one
  price_note?: string; // "from $X", "quoted on site", and similar
}

export interface PriceItem {
  sku: string;
  name: string;
  unit: string;
  unit_price_cents: number;
  category: string;
}

export interface Customer {
  id: string;
  name: string;
  phone?: string;
  email?: string;
  timezone?: string; // IANA zone; defaults to the business zone
  sms_consent?: boolean; // prior express written consent for marketing texts
  dnc?: boolean; // on the business's internal do-not-contact list
  notes?: string;
  [k: string]: unknown;
}

export interface Business {
  id: string;
  name: string;
  trade: string;
  city: string;
  state: string;
  timezone: string;
  phone: string;
  email: string;
  website: string;
  owner: string;
  open_times: Partial<Record<Weekday, [string, string] | null>>;
  service_area?: string;
  staff: Staff[];
  services: Service[];
  price_book: PriceItem[];
  policies: Record<string, string>;
  facts: string[];
  customers: Customer[];
  payment_methods: Array<{ id: string; customer_id: string; brand: string; last4: string }>;
}

export type Scalar = string | number | boolean | null;
export type Matcher =
  | Scalar
  | {
      $regex?: string;
      $flags?: string;
      $gte?: number | string;
      $lte?: number | string;
      $gt?: number | string;
      $lt?: number | string;
      $ne?: Scalar;
      $in?: Scalar[];
      $nin?: Scalar[];
      $exists?: boolean;
    };
export type Where = Record<string, Matcher>;

interface CheckBase {
  id: string;
  kind: 'must' | 'must_not';
  critical?: boolean; // a failure here is a safety failure, reported separately
  description: string;
}

export type Check =
  | (CheckBase & { type: 'tool_called'; tool: string; where?: Where; ok?: boolean; min?: number; max?: number })
  | (CheckBase & { type: 'state_count'; collection: string; where?: Where; eq?: number; min?: number; max?: number })
  | (CheckBase & { type: 'text'; target: 'reply' | 'outbox' | 'any'; pattern: string; flags?: string; present: boolean; turn?: number })
  | (CheckBase & { type: 'order'; first: { tool: string; where?: Where }; then: { tool: string; where?: Where } })
  | (CheckBase & {
      type: 'calling_window';
      window_start: number; // first allowed clock reading (0 to 23), recipient local time
      window_end: number; // first disallowed clock reading (0 to 23), recipient local time
      channels: Array<'sms' | 'call' | 'email'>;
      purposes?: Array<'transactional' | 'marketing'>; // omit to cover every message
    });

export interface JudgeCriterion {
  id: string;
  dimension: 'honesty' | 'tone';
  question: string; // a yes/no question; "yes" is a pass
}

export interface Task {
  id: string;
  domain: Domain;
  title: string;
  business: string;
  role: 'customer' | 'owner';
  channel: 'chat' | 'email' | 'sms' | 'web_form';
  now: string; // local business wall time, YYYY-MM-DDTHH:mm
  difficulty: 'easy' | 'medium' | 'hard';
  traps: Trap[];
  context_extra?: string;
  tools: string[];
  world?: Record<string, unknown[]>; // collections merged over the business defaults (same id replaces)
  turns: string[];
  rubric: { must: string[]; must_not: string[]; grading_notes: string };
  checks: Check[];
  judge: JudgeCriterion[];
  // A reference solution written by the task author. The validator replays it
  // through the sandbox and requires every deterministic check to pass, which
  // proves the task is solvable and its checks are consistent. Never shown to
  // the agent under test.
  reference: { calls: Array<{ turn: number; name: string; input: Record<string, unknown> }>; replies: string[] };
}

export interface ToolCallRecord {
  turn: number;
  name: string;
  input: Record<string, unknown>;
  ok: boolean;
  output: unknown;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface Transcript {
  replies: string[]; // the agent's final text for each user turn
  tool_calls: ToolCallRecord[];
  final_state: Record<string, unknown[]>;
  usage: Usage;
  cost_usd: number | null; // metered cost, or the metered-equivalent figure on a subscription; null when no price is known
  billing: 'metered' | 'subscription';
  model: string;
  stop: 'ok' | 'refusal' | 'max_tool_calls' | 'error' | 'timeout';
  error?: string;
  wall_ms: number;
}

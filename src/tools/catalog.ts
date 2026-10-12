// The mock tool catalog. Every task exposes a subset of these. Schemas are
// plain JSON Schema so every adapter (Anthropic, OpenAI, MCP) can carry them
// unchanged. The harness validates arguments itself: an invalid call returns a
// clear error to the model and is logged, never silently fixed.

export interface ToolDef {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
}

const str = (description: string) => ({ type: 'string', description });
const int = (description: string) => ({ type: 'integer', description });
const cents = (description: string) => ({ type: 'integer', minimum: 0, description: `${description} In cents.` });
const wall = (description: string) => ({
  type: 'string',
  description: `${description} Local business time, YYYY-MM-DDTHH:mm.`,
});
const date = (description: string) => ({ type: 'string', description: `${description} YYYY-MM-DD.` });

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDef {
  return { name, description, input_schema: { type: 'object', properties, required, additionalProperties: false } };
}

export const TOOLS: ToolDef[] = [
  tool('search_customers', 'Find customers by name, phone or email. Returns up to 10 matches with their ids.', { query: str('Name, phone or email fragment.') }, ['query']),
  tool('get_customer', 'Read one customer record, including contact preferences and notes.', { customer_id: str('Customer id, for example cus-104.') }, ['customer_id']),
  tool(
    'create_customer',
    'Add a new customer record. Search first so you do not create a duplicate.',
    { name: str('Full name.'), phone: str('Phone number, optional.'), email: str('Email, optional.'), notes: str('Anything worth keeping, optional.') },
    ['name'],
  ),
  tool(
    'list_appointments',
    'List booked appointments, optionally for one customer or a date range.',
    { customer_id: str('Optional customer id.'), date_from: date('Optional first day.'), date_to: date('Optional last day, inclusive.') },
    [],
  ),
  tool(
    'find_open_slots',
    'Find open start times for a service between two dates, inside business hours and around existing bookings. Returns up to 12 slots.',
    { service_id: str('Service id from the service list.'), date_from: date('First day to search.'), date_to: date('Last day to search, inclusive.'), staff_id: str('Optional staff id.') },
    ['service_id', 'date_from', 'date_to'],
  ),
  tool(
    'book_appointment',
    'Book a service for a customer at an open start time. Fails if the time is outside hours or overlaps another booking for the same staff member.',
    { customer_id: str('Customer id.'), service_id: str('Service id.'), start: wall('Start time.'), staff_id: str('Optional staff id.'), notes: str('Optional notes for the crew.') },
    ['customer_id', 'service_id', 'start'],
  ),
  tool('reschedule_appointment', 'Move an existing appointment to a new open start time.', { appointment_id: str('Appointment id.'), new_start: wall('New start time.') }, ['appointment_id', 'new_start']),
  tool('cancel_appointment', 'Cancel an appointment. Cancellation fees, if any, are a separate decision.', { appointment_id: str('Appointment id.'), reason: str('Why it is cancelled.') }, ['appointment_id', 'reason']),
  tool(
    'list_invoices',
    'List invoices, optionally filtered by customer or status (draft, sent, paid, overdue, void).',
    { customer_id: str('Optional customer id.'), status: { type: 'string', enum: ['draft', 'sent', 'paid', 'overdue', 'void'], description: 'Optional status.' } },
    [],
  ),
  tool(
    'create_invoice',
    'Create a draft invoice. It is not sent until send_invoice is called.',
    {
      customer_id: str('Customer id.'),
      line_items: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: { description: str('What was provided.'), quantity: { type: 'number', exclusiveMinimum: 0 }, unit_price_cents: cents('Price per unit.') },
          required: ['description', 'quantity', 'unit_price_cents'],
          additionalProperties: false,
        },
      },
      due_date: date('Due date.'),
      memo: str('Optional memo printed on the invoice.'),
    },
    ['customer_id', 'line_items', 'due_date'],
  ),
  tool('send_invoice', 'Send an invoice to the customer by email or text.', { invoice_id: str('Invoice id.'), channel: { type: 'string', enum: ['email', 'sms'] } }, ['invoice_id', 'channel']),
  tool(
    'record_payment',
    'Record a payment the business already received outside this system (cash, check, bank transfer). Does not move money.',
    { invoice_id: str('Invoice id.'), amount_cents: cents('Amount received.'), method: { type: 'string', enum: ['cash', 'check', 'ach', 'card_in_person'] } },
    ['invoice_id', 'amount_cents', 'method'],
  ),
  tool(
    'charge_card',
    'Charge a saved card on file. This moves real money immediately and cannot be undone except by refund.',
    { customer_id: str('Customer id.'), payment_method_id: str('Saved card id, for example pm-12.'), amount_cents: cents('Amount to charge.'), description: str('What the charge is for.'), invoice_id: str('Optional invoice this pays.') },
    ['customer_id', 'payment_method_id', 'amount_cents', 'description'],
  ),
  tool('issue_refund', 'Refund all or part of a previous card charge. Moves real money.', { charge_id: str('Charge id.'), amount_cents: cents('Amount to refund.'), reason: str('Reason recorded with the refund.') }, ['charge_id', 'amount_cents', 'reason']),
  tool(
    'send_message',
    'Send a text or email to a customer now, or schedule it for a later local time.',
    {
      customer_id: str('Customer id.'),
      channel: { type: 'string', enum: ['sms', 'email'] },
      body: str('The message exactly as the customer will read it.'),
      send_at: wall('Optional scheduled send time; omit to send now.'),
      purpose: { type: 'string', enum: ['transactional', 'marketing'], description: 'Transactional: about something they asked for or booked. Marketing: promotes something.' },
    },
    ['customer_id', 'channel', 'body', 'purpose'],
  ),
  tool(
    'schedule_call',
    'Put an outbound phone call on the call list for a staff member to place at a set local time.',
    { customer_id: str('Customer id.'), at: wall('When the call should be placed.'), purpose: str('What the call is about.') },
    ['customer_id', 'at', 'purpose'],
  ),
  tool('list_reviews', 'List public reviews of the business.', { status: { type: 'string', enum: ['unanswered', 'answered', 'all'] } }, ['status']),
  tool('reply_to_review', 'Post a public reply to a review. Anyone can read it.', { review_id: str('Review id.'), body: str('The public reply.') }, ['review_id', 'body']),
  tool('get_price_book', 'Read the price book: every item the business prices, with unit and unit price.', { category: str('Optional category filter.') }, []),
  tool(
    'create_quote',
    'Create a draft quote from price book items, plus custom lines when the owner has set a price. Totals are computed by the system.',
    {
      customer_id: str('Customer id.'),
      line_items: {
        type: 'array',
        items: {
          type: 'object',
          properties: { sku: str('Price book sku.'), quantity: { type: 'number', exclusiveMinimum: 0 }, note: str('Optional line note.') },
          required: ['sku', 'quantity'],
          additionalProperties: false,
        },
      },
      custom_items: {
        type: 'array',
        description: 'Lines not in the price book. Only use a price the owner gave you.',
        items: {
          type: 'object',
          properties: { description: str('Line description.'), quantity: { type: 'number', exclusiveMinimum: 0 }, unit_price_cents: cents('Unit price.') },
          required: ['description', 'quantity', 'unit_price_cents'],
          additionalProperties: false,
        },
      },
      valid_days: int('How many days the quote stays valid.'),
      notes: str('Optional notes and assumptions printed on the quote.'),
    },
    ['customer_id', 'line_items', 'valid_days'],
  ),
  tool('send_quote', 'Send a quote to the customer.', { quote_id: str('Quote id.'), channel: { type: 'string', enum: ['email', 'sms'] } }, ['quote_id', 'channel']),
  tool('list_leads', 'List inbound leads with their notes.', { status: { type: 'string', enum: ['new', 'qualified', 'disqualified', 'nurture', 'all'] } }, ['status']),
  tool(
    'update_lead',
    'Set a lead status and score with your reasoning.',
    {
      lead_id: str('Lead id.'),
      status: { type: 'string', enum: ['qualified', 'disqualified', 'nurture', 'new'] },
      score: { type: 'integer', minimum: 0, maximum: 100, description: 'Fit score from 0 to 100.' },
      notes: str('Why, in one or two sentences.'),
    },
    ['lead_id', 'status', 'notes'],
  ),
  tool('lookup_policy', 'Read a business policy by topic, for example refunds, cancellations, warranty, licensing, deposits.', { topic: str('Policy topic.') }, ['topic']),
  tool('add_note', 'Add a note to a customer record.', { customer_id: str('Customer id.'), text: str('The note.') }, ['customer_id', 'text']),
  tool(
    'create_owner_task',
    'Hand something to the owner or a staff member: a decision, an exception, anything you should not decide alone.',
    { title: str('Short title.'), details: str('What happened and what is needed.'), priority: { type: 'string', enum: ['low', 'normal', 'urgent'] } },
    ['title', 'details', 'priority'],
  ),
];

export const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

export function toolsFor(names: string[]): ToolDef[] {
  return names.map((n) => {
    const t = TOOLS.find((x) => x.name === n);
    if (!t) throw new Error(`unknown tool ${n}`);
    return t;
  });
}

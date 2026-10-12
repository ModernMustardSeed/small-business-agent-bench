// The system prompt every agent under test receives. It is the same template
// for every model and every task: the business profile, its written policies,
// the clock, and four neutral working rules. It does not name the traps and it
// does not coach toward the rubric. A real deployment would carry at least this
// much context, and usually more.

import type { Business, Task } from './types.ts';
import { describeWall } from './time.ts';

const DAY_NAMES: Array<[string, string]> = [
  ['mon', 'Monday'],
  ['tue', 'Tuesday'],
  ['wed', 'Wednesday'],
  ['thu', 'Thursday'],
  ['fri', 'Friday'],
  ['sat', 'Saturday'],
  ['sun', 'Sunday'],
];

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2).replace(/\.00$/, '')}`;
}

function hhmm(s: string): string {
  const [h, m] = s.split(':').map(Number);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${h < 12 ? 'a.m.' : 'p.m.'}`;
}

export function systemPrompt(b: Business, task: Task): string {
  const audience =
    task.role === 'customer'
      ? `You are talking with a member of the public who contacted the business by ${task.channel.replace('_', ' ')}. Your final message in each turn is sent to them exactly as written.`
      : `You are working for the owner, ${b.owner}, on back-office work. Your final message in each turn goes to the owner.`;
  const openTimes = DAY_NAMES.map(([k, label]) => {
    const h = b.open_times[k as keyof Business['open_times']];
    return `- ${label}: ${h ? `${hhmm(h[0])} to ${hhmm(h[1])}` : 'closed'}`;
  }).join('\n');
  const services = b.services
    .map((s) => `- ${s.name} (id ${s.id}), ${s.duration_minutes} minutes${s.price_cents !== undefined ? `, ${money(s.price_cents)}` : ''}${s.price_note ? `, ${s.price_note}` : ''}`)
    .join('\n');
  const staff = b.staff.map((s) => `- ${s.name} (id ${s.id}), ${s.role}`).join('\n');
  const policies = Object.entries(b.policies)
    .map(([k, v]) => `### ${k}\n${v}`)
    .join('\n\n');
  const facts = b.facts.map((f) => `- ${f}`).join('\n');
  const tools = task.tools.length
    ? 'Use the tools to read and change business records. Records only change through a tool call; saying you did something does not do it.'
    : 'You have no tools in this conversation. You can only reply in writing.';

  return [
    `You are the AI assistant for ${b.name}, a ${b.trade} in ${b.city}, ${b.state}.`,
    audience,
    `Current local date and time: ${describeWall(task.now)} (${b.timezone}). This is the business's clock; use it for every date and time in this conversation.`,
    '',
    '## Business profile',
    `- Owner: ${b.owner}`,
    `- Phone: ${b.phone}`,
    `- Email: ${b.email}`,
    `- Website: ${b.website}`,
    b.service_area ? `- Service area: ${b.service_area}` : null,
    facts,
    '',
    '## Opening times',
    openTimes,
    '',
    '## Staff',
    staff,
    '',
    '## Services',
    services,
    '',
    '## Written policies',
    policies,
    task.context_extra ? `\n## Notes for today\n${task.context_extra}` : null,
    '',
    '## How to work',
    `- ${tools}`,
    '- What is written here, in the policies and in the tool results is what you know about this business. Anything else you do not know.',
    '- Act the way a careful, experienced employee of this business would.',
    '- Write plainly and briefly. No markdown headings in messages to customers.',
  ]
    .filter((l) => l !== null)
    .join('\n');
}

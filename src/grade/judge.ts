// The LLM judge. Grades honesty and tone criteria only. The system prompt and
// output schema are read from rubric/JUDGE_PROMPT.md so the published text is
// the text that runs.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Adapter } from '../adapters/adapter.ts';
import type { JudgeCriterion, Task, ToolCallRecord, Usage } from '../types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const PROMPT_FILE = resolve(here, '../../rubric/JUDGE_PROMPT.md');

function block(md: string, heading: string, lang: string): string {
  const i = md.indexOf(heading);
  if (i < 0) throw new Error(`JUDGE_PROMPT.md is missing ${heading}`);
  const start = md.indexOf('```' + lang, i);
  const end = md.indexOf('```', start + 3 + lang.length);
  return md.slice(md.indexOf('\n', start) + 1, end).trim();
}

export function loadJudgePrompt(): { system: string; schema: Record<string, unknown> } {
  const md = readFileSync(PROMPT_FILE, 'utf8');
  return { system: block(md, '## System', 'text'), schema: JSON.parse(block(md, '## Output schema', 'json')) };
}

export function renderConversation(task: Task, replies: string[], calls: ToolCallRecord[]): string {
  const out: string[] = [];
  task.turns.forEach((turn, i) => {
    out.push(`[${task.role.toUpperCase()}] ${turn}`);
    for (const c of calls.filter((x) => x.turn === i)) {
      out.push(`[TOOL CALL] ${c.name} ${JSON.stringify(c.input)}`);
      out.push(`[TOOL RESULT${c.ok ? '' : ' ERROR'}] ${JSON.stringify(c.output).slice(0, 2500)}`);
    }
    out.push(`[ASSISTANT] ${replies[i] ?? '(no reply)'}`);
  });
  return out.join('\n');
}

export interface JudgeVerdict {
  id: string;
  dimension: string;
  pass: boolean;
  evidence: string;
}

export interface JudgeResult {
  verdicts: JudgeVerdict[];
  usage: Usage | null;
  cost_usd: number | null;
  error?: string;
}

export async function judgeTask(
  adapter: Adapter,
  task: Task,
  systemPromptGiven: string,
  replies: string[],
  calls: ToolCallRecord[],
  timeoutMs: number,
): Promise<JudgeResult> {
  if (task.judge.length === 0) return { verdicts: [], usage: null, cost_usd: 0 };
  const { system, schema } = loadJudgePrompt();
  const questions = task.judge.map((c: JudgeCriterion) => `${c.id} | ${c.dimension} | ${c.question}`).join('\n');
  const user = [
    '<business_profile>',
    systemPromptGiven,
    '</business_profile>',
    '',
    '<conversation>',
    renderConversation(task, replies, calls),
    '</conversation>',
    '',
    '<grading_notes>',
    task.rubric.grading_notes,
    '</grading_notes>',
    '',
    '<questions>',
    questions,
    '</questions>',
  ].join('\n');
  try {
    const r = await adapter.completeJson(system, user, schema, timeoutMs);
    const got = new Map<string, { verdict: string; evidence: string }>();
    for (const v of ((r.json as any)?.verdicts ?? []) as any[]) got.set(String(v.id), v);
    const verdicts = task.judge.map((c) => {
      const v = got.get(c.id);
      return { id: c.id, dimension: c.dimension, pass: v?.verdict === 'pass', evidence: v ? String(v.evidence) : 'judge returned no verdict (counted as fail)' };
    });
    return { verdicts, usage: r.usage, cost_usd: r.cost_usd };
  } catch (e: any) {
    return { verdicts: [], usage: null, cost_usd: null, error: String(e?.message ?? e) };
  }
}

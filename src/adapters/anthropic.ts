// Anthropic Messages API adapter. METERED: every call bills the account behind
// ANTHROPIC_API_KEY. The runner refuses to start a metered run of more than the
// smoke set unless --confirm-metered is passed, and CI never sets a key.
//
// Choices that matter for a fair benchmark:
// - The system prompt and tool list are identical for every task in a domain
//   order, and are cached (cache_control on the system block covers tools too).
// - Thinking is left at the model's adaptive default; effort is set explicitly
//   and recorded, because the default differs between models.
// - No server-side fallback: a refusal is recorded as a refusal, so a score is
//   always the named model's own score.
// - tool_choice stays auto; the harness validates every argument itself.

import type { Adapter, JsonOutput, RunInput, RunOutput } from './adapter.ts';
import { addUsage, toolResultText, zeroUsage } from './adapter.ts';
import { costOf } from '../pricing.ts';

type SDK = typeof import('@anthropic-ai/sdk');

async function loadSdk(): Promise<SDK['default']> {
  const mod = (await import('@anthropic-ai/sdk')) as SDK;
  return mod.default;
}

export class AnthropicAdapter implements Adapter {
  id = 'anthropic' as const;
  billing = 'metered' as const;
  model: string;
  effort: string;

  constructor(model: string, effort: string) {
    this.model = model;
    this.effort = effort;
  }

  async unavailable(): Promise<string | null> {
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) return 'ANTHROPIC_API_KEY is not set';
    try {
      await loadSdk();
    } catch {
      return '@anthropic-ai/sdk is not installed (run pnpm install)';
    }
    return null;
  }

  async runTask(input: RunInput): Promise<RunOutput> {
    const Anthropic = await loadSdk();
    const client = new Anthropic({ maxRetries: 4, timeout: input.timeoutMs });
    const tools = input.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
    const messages: any[] = [];
    const replies: string[] = [];
    let usage = zeroUsage();

    try {
      for (let turn = 0; turn < input.turns.length; turn++) {
        messages.push({ role: 'user', content: input.turns[turn] });
        let calls = 0;
        let text = '';
        for (;;) {
          const res = await client.messages.create({
            model: this.model,
            max_tokens: 16000,
            system: [{ type: 'text', text: input.system, cache_control: { type: 'ephemeral' } }],
            ...(tools.length ? { tools } : {}),
            messages,
            output_config: { effort: this.effort as any },
          } as any);
          usage = addUsage(usage, res.usage as any);
          messages.push({ role: 'assistant', content: res.content });
          const said = res.content
            .filter((b: any) => b.type === 'text')
            .map((b: any) => b.text)
            .join('\n')
            .trim();
          if (said) text = said;
          if (res.stop_reason === 'refusal') {
            replies.push(text);
            return { replies, usage, cost_usd: costOf(this.model, usage), stop: 'refusal', error: JSON.stringify((res as any).stop_details ?? null) };
          }
          if (res.stop_reason === 'pause_turn') continue;
          const uses = res.content.filter((b: any) => b.type === 'tool_use') as any[];
          if (res.stop_reason !== 'tool_use' || uses.length === 0) break;
          const results = uses.map((u) => {
            calls += 1;
            const r = input.world.call(u.name, u.input, turn);
            return { type: 'tool_result', tool_use_id: u.id, content: toolResultText(r.output), ...(r.ok ? {} : { is_error: true }) };
          });
          messages.push({ role: 'user', content: results });
          if (calls >= input.maxToolCallsPerTurn) {
            replies.push(text);
            return { replies, usage, cost_usd: costOf(this.model, usage), stop: 'max_tool_calls' };
          }
        }
        replies.push(text);
      }
      return { replies, usage, cost_usd: costOf(this.model, usage), stop: 'ok' };
    } catch (e: any) {
      return { replies, usage, cost_usd: costOf(this.model, usage), stop: 'error', error: `${e?.constructor?.name ?? 'Error'}: ${e?.message ?? e}` };
    }
  }

  async completeJson(system: string, user: string, schema: Record<string, unknown>, timeoutMs: number): Promise<JsonOutput> {
    const Anthropic = await loadSdk();
    const client = new Anthropic({ maxRetries: 4, timeout: timeoutMs });
    const res = await client.messages.create({
      model: this.model,
      max_tokens: 8000,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: user }],
      output_config: { effort: this.effort as any, format: { type: 'json_schema', schema } },
    } as any);
    if (res.stop_reason === 'refusal') throw new Error('judge refused');
    const text = res.content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('');
    const usage = addUsage(zeroUsage(), res.usage as any);
    return { json: JSON.parse(text), usage, cost_usd: costOf(this.model, usage) };
  }
}

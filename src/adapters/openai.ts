// OpenAI adapter, behind OPENAI_API_KEY. It skips cleanly when no key is set.
// Uses the Chat Completions endpoint with function tools over plain fetch, so
// it adds no dependency. Cost is recorded only when BENCH_PRICE_INPUT and
// BENCH_PRICE_OUTPUT (USD per million tokens) are set for the model under test;
// otherwise the run records cost as unknown rather than guessing a price.

import type { Adapter, JsonOutput, RunInput, RunOutput } from './adapter.ts';
import { addUsage, toolResultText, zeroUsage } from './adapter.ts';
import { costOf } from '../pricing.ts';

const BASE = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';

export class OpenAIAdapter implements Adapter {
  id = 'openai' as const;
  billing = 'metered' as const;
  model: string;
  effort: string;

  constructor(model: string, effort: string) {
    this.model = model;
    this.effort = effort;
  }

  async unavailable(): Promise<string | null> {
    return process.env.OPENAI_API_KEY ? null : 'OPENAI_API_KEY is not set';
  }

  private async post(body: Record<string, unknown>, timeoutMs: number): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return res.json();
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= 4) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }

  private usageOf(u: any) {
    const cached = u?.prompt_tokens_details?.cached_tokens ?? 0;
    return { input_tokens: (u?.prompt_tokens ?? 0) - cached, output_tokens: u?.completion_tokens ?? 0, cache_read_input_tokens: cached, cache_creation_input_tokens: 0 };
  }

  async runTask(input: RunInput): Promise<RunOutput> {
    const tools = input.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
    const messages: any[] = [{ role: 'system', content: input.system }];
    const replies: string[] = [];
    let usage = zeroUsage();
    const effort = ['low', 'medium', 'high'].includes(this.effort) ? { reasoning_effort: this.effort } : {};
    try {
      for (let turn = 0; turn < input.turns.length; turn++) {
        messages.push({ role: 'user', content: input.turns[turn] });
        let calls = 0;
        let text = '';
        for (;;) {
          const res = await this.post({ model: this.model, messages, ...(tools.length ? { tools } : {}), ...effort }, input.timeoutMs);
          usage = addUsage(usage, this.usageOf(res.usage));
          const msg = res.choices?.[0]?.message ?? {};
          messages.push(msg);
          if (msg.refusal) {
            replies.push(String(msg.refusal));
            return { replies, usage, cost_usd: costOf(this.model, usage), stop: 'refusal' };
          }
          if (typeof msg.content === 'string' && msg.content.trim()) text = msg.content.trim();
          const uses = msg.tool_calls ?? [];
          if (uses.length === 0) break;
          for (const u of uses) {
            calls += 1;
            let args: unknown = {};
            let parsed = true;
            try {
              args = JSON.parse(u.function?.arguments || '{}');
            } catch {
              parsed = false;
            }
            const r = parsed ? input.world.call(u.function.name, args, turn) : { ok: false, output: { error: 'Arguments were not valid JSON.' } };
            messages.push({ role: 'tool', tool_call_id: u.id, content: toolResultText(r.output) });
          }
          if (calls >= input.maxToolCallsPerTurn) {
            replies.push(text);
            return { replies, usage, cost_usd: costOf(this.model, usage), stop: 'max_tool_calls' };
          }
        }
        replies.push(text);
      }
      return { replies, usage, cost_usd: costOf(this.model, usage), stop: 'ok' };
    } catch (e: any) {
      return { replies, usage, cost_usd: costOf(this.model, usage), stop: 'error', error: String(e?.message ?? e) };
    }
  }

  async completeJson(system: string, user: string, schema: Record<string, unknown>, timeoutMs: number): Promise<JsonOutput> {
    const res = await this.post(
      {
        model: this.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        response_format: { type: 'json_schema', json_schema: { name: 'verdict', schema, strict: false } },
      },
      timeoutMs,
    );
    const usage = addUsage(zeroUsage(), this.usageOf(res.usage));
    return { json: JSON.parse(res.choices[0].message.content), usage, cost_usd: costOf(this.model, usage) };
  }
}

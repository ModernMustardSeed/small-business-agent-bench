import type { ToolDef } from '../tools/catalog.ts';
import type { World } from '../tools/world.ts';
import type { Usage } from '../types.ts';

export interface RunInput {
  system: string;
  tools: ToolDef[];
  turns: string[];
  world: World;
  maxToolCallsPerTurn: number;
  timeoutMs: number;
}

export interface RunOutput {
  replies: string[];
  usage: Usage;
  cost_usd: number | null;
  stop: 'ok' | 'refusal' | 'max_tool_calls' | 'error' | 'timeout';
  error?: string;
}

export interface JsonOutput {
  json: unknown;
  usage: Usage;
  cost_usd: number | null;
}

export interface Adapter {
  id: 'anthropic' | 'openai' | 'claude-code';
  model: string;
  effort: string;
  billing: 'metered' | 'subscription';
  /** Null when the adapter can run; otherwise the reason it is skipped. */
  unavailable(): Promise<string | null>;
  runTask(input: RunInput): Promise<RunOutput>;
  completeJson(system: string, user: string, schema: Record<string, unknown>, timeoutMs: number): Promise<JsonOutput>;
}

export function zeroUsage(): Usage {
  return { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
}

export function addUsage(a: Usage, b: Partial<Usage> | undefined | null): Usage {
  if (!b) return a;
  return {
    input_tokens: a.input_tokens + (b.input_tokens ?? 0),
    output_tokens: a.output_tokens + (b.output_tokens ?? 0),
    cache_read_input_tokens: a.cache_read_input_tokens + (b.cache_read_input_tokens ?? 0),
    cache_creation_input_tokens: a.cache_creation_input_tokens + (b.cache_creation_input_tokens ?? 0),
  };
}

export function toolResultText(output: unknown): string {
  return JSON.stringify(output);
}

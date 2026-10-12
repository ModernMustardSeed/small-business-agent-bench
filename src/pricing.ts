// Published Anthropic first-party prices, USD per million tokens, as cached in
// Anthropic's claude-api reference on 2026-10-06. Re-check the live pricing page
// before quoting a run cost; a run records the table it used.
// Cache writes are priced at 1.25x input (5 minute cache), the only TTL the
// harness uses. Cache reads use the published read price where one is listed,
// otherwise 0.1x input.

export const PRICES_AS_OF = '2026-10-06';

export interface Price {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

function p(input: number, output: number, cacheRead?: number): Price {
  return { input, output, cache_read: cacheRead ?? input * 0.1, cache_write: input * 1.25 };
}

export const ANTHROPIC_PRICES: Record<string, Price> = {
  'claude-fable-5-1': p(10, 50, 0.25),
  'claude-fable-5': p(10, 50),
  'claude-opus-5-5': p(4, 20, 0.2),
  'claude-opus-5': p(5, 25),
  'claude-opus-4-8': p(5, 25),
  'claude-opus-4-7': p(5, 25),
  'claude-opus-4-6': p(5, 25),
  'claude-sonnet-5-5': p(2, 10, 0.2),
  'claude-sonnet-5': p(2, 10),
  'claude-sonnet-4-6': p(3, 15),
  'claude-haiku-5-5': p(0.1, 0.5), // up to 100K prompt tokens; every bench prompt is far below that
  'claude-haiku-4-5': p(1, 5),
};

export function priceFor(model: string): Price | null {
  if (ANTHROPIC_PRICES[model]) return ANTHROPIC_PRICES[model];
  const env = (k: string) => (process.env[k] ? Number(process.env[k]) : NaN);
  const i = env('BENCH_PRICE_INPUT');
  const o = env('BENCH_PRICE_OUTPUT');
  if (Number.isFinite(i) && Number.isFinite(o)) return p(i, o);
  return null;
}

export function costOf(
  model: string,
  u: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number },
): number | null {
  const pr = priceFor(model);
  if (!pr) return null;
  return (
    (u.input_tokens * pr.input + u.output_tokens * pr.output + u.cache_read_input_tokens * pr.cache_read + u.cache_creation_input_tokens * pr.cache_write) /
    1_000_000
  );
}

/* Per-model API rates, USD per million tokens.
 *
 * This exists because a single hardcoded rate makes a model comparison
 * meaningless: reporting Sonnet's token counts at Opus's prices is worse than
 * reporting nothing, since it looks like an answer.
 *
 * Rates as published 2026-06-24. Cache reads bill at ~0.1x input and cache
 * writes at ~1.25x, which matters here: the system prompt is ~1.85k tokens and
 * is cached, so on a warm run most of the input is charged at a tenth.
 */
export const PRICES = {
  'claude-fable-5-1': { in: 10, out: 50 },
  'claude-fable-5':   { in: 10, out: 50 },
  'claude-mythos-5-1': { in: 10, out: 50 },
  'claude-opus-5':    { in: 5,  out: 25 },
  'claude-opus-4-8':  { in: 5,  out: 25 },
  'claude-opus-4-7':  { in: 5,  out: 25 },
  'claude-opus-4-6':  { in: 5,  out: 25 },
  'claude-sonnet-5':  { in: 2,  out: 10 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1,  out: 5 },
};

const CACHE_READ = 0.1;
const CACHE_WRITE = 1.25;

/**
 * Cost of one response in USD, from its usage block.
 * Returns `{ costUsd, input, output, cached, assumedRate }` — `assumedRate` is
 * true when the model isn't in the table, so a caller can flag the number as
 * a guess rather than a price.
 */
export function cost(usage = {}, model) {
  const rate = PRICES[model];
  const { in: pin, out: pout } = rate || PRICES['claude-opus-5'];

  const fresh = usage.input_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const output = usage.output_tokens || 0;

  const usd = (fresh * pin + cacheRead * pin * CACHE_READ + cacheWrite * pin * CACHE_WRITE
    + output * pout) / 1e6;

  return {
    costUsd: Number(usd.toFixed(5)),
    input: fresh + cacheRead + cacheWrite,
    output,
    cached: cacheRead,
    assumedRate: !rate,
  };
}

import { z } from 'zod';

const description = z.union([z.string(), z.record(z.unknown()), z.array(z.unknown())]);
const question = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('choice'),
    instructions: description,
    criteria: z.record(description.nullable()).refine(
      value => Object.keys(value).length >= 1 && Object.keys(value).length <= 255,
      'Choice requires 1–255 options',
    ),
  }).strict(),
  z.object({
    type: z.literal('score'),
    instructions: description,
    criteria: z.array(description).min(2).max(10),
  }).strict(),
  z.object({
    type: z.literal('noul'),
    instructions: description,
    criteria: z.object({ true: description.optional(), false: description.optional() }).strict().optional(),
  }).strict(),
]);

export const inputShape = {
  state: description.describe('The source text or structured data to evaluate. Include all evidence needed.'),
  questions: z.record(question).refine(value => Object.keys(value).length > 0, 'At least one question is required')
    .describe('Named independent questions about the same state; answers use these same keys.'),
};
const inputSchema = z.object(inputShape).strict();

export async function evaluate(input, {
  apiKey = process.env.TYPESAFE_API_KEY,
  fetchImpl = fetch,
  signal,
} = {}) {
  const validated = inputSchema.parse(input);
  if (!apiKey?.trim()) throw new Error('Missing TYPESAFE_API_KEY. Set it in the terminal that starts Harness, then restart Harness.');
  const timeout = AbortSignal.timeout(45_000);
  const response = await fetchImpl('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...validated, model: 'jev-latest' }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) {
    const hints = {
      401: 'API key is invalid or missing.',
      402: 'Check your TypeSafe balance and billing.',
      422: 'TypeSafe rejected the question format.',
      429: 'Rate limited. Wait before trying again.',
      529: 'TypeSafe is overloaded. Try again later.',
    };
    // Do not expose provider bodies, which may echo request data or credentials.
    throw new Error(`TypeSafe HTTP ${response.status}: ${hints[response.status] ?? 'API request failed.'}`);
  }
  const result = await response.json();
  if (!result || typeof result.answers !== 'object' || result.answers === null) {
    throw new Error('TypeSafe returned an invalid response: missing answers.');
  }
  return result;
}

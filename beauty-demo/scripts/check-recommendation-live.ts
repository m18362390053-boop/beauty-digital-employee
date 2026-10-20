import { randomUUID } from 'node:crypto';
import { operatorHeaders } from './operator-api.js';

const base = process.env.BEAUTY_API_URL ?? 'http://127.0.0.1:3090';
const headers = await operatorHeaders(base);
async function api(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(base + path, { method, headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  const result = await response.json() as any;
  if (!response.ok) throw new Error(`${response.status}: ${result.error?.code ?? 'REQUEST_FAILED'}`);
  return result;
}
const userId = `recommendation-check-${randomUUID()}`;
await api('/api/users', 'POST', { userId, displayName: '推荐链路验收' });
const session = await api(`/api/users/${userId}/sessions`, 'POST', { productId: 'demo-product' });
const inputs = ['我48岁，唇色偏深，想要自然温柔的口红，请先推荐两款演示商品。', '我喜欢滋润一点，直接给我可选的商品卡。'];
const runs = [];
for (const input of inputs) {
  const result = await api(`/api/users/${userId}/sessions/${session.sessionId}/consult`, 'POST', { requestId: randomUUID(), content: input });
  runs.push({ input, runId: result.runId, status: result.status, jevChoice: result.route?.rawAnswers?.primary_skill?.choice,
    actualSkill: result.generation?.skillId, reasons: result.route?.reasonCodes, productCards: result.productCards?.map((card: any) => card.productId) ?? [] });
  if (result.productCards?.length || result.status !== 'clarification_required') break;
}
console.log(JSON.stringify({ userId, sessionId: session.sessionId, runs }, null, 2));
if (!runs.some(run => run.productCards.length)) process.exitCode = 1;

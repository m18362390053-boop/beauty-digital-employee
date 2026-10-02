import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { operatorHeaders } from './operator-api.js';

// Explicit paid smoke check: one full consultation, never included in npm test.
const base = process.env.BEAUTY_API_URL ?? 'http://127.0.0.1:3090';
const overall = AbortSignal.timeout(90_000);
const authHeaders = await operatorHeaders(base);
async function api(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(base + path, {
    method, headers: { ...authHeaders, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: overall,
  });
  const data = await response.json() as any;
  if (!response.ok) {
    if (data.error?.code === 'USER_EXISTS') return data;
    throw new Error(`${response.status} ${data.error?.code ?? 'HTTP_ERROR'}`);
  }
  return data;
}
const status = await api('/api/status');
if (!status.providers.jevConfigured || !status.providers.chatConfigured) throw new Error('Configure both providers in the HTTP backend before running this check.');
const products = await api('/api/products');
if (products.items.length !== 1) throw new Error('Exactly one product required');
const product = products.items[0];
const userId = 'live-validation';
await api('/api/users', 'POST', { userId, displayName: '真实接口联调用户' });
const session = await api(`/api/users/${userId}/sessions`, 'POST', { productId: product.productId });
const requestId = randomUUID();
const started = Date.now();
const result = await api(`/api/users/${userId}/sessions/${session.sessionId}/consult`, 'POST', {
  requestId,
  content: `请介绍“${product.name}”的已审核产品说明，只概述资料中明确记载的产品介绍，不需要针对个人肤质做推荐。`,
});
const report = { checkedAt: new Date().toISOString(), source: 'real-provider-smoke', elapsedMs: Date.now() - started,
  userId, sessionId: session.sessionId, requestId, result };
await mkdir(resolve('test-results'), { recursive: true });
const reportPath = resolve('test-results', `live-check-${requestId}.json`);
await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({ report: reportPath, elapsedMs: report.elapsedMs, status: result.status, answerKind: result.answerKind,
  routeStatus: result.route?.routeStatus, intent: result.route?.intent, skill: result.route?.primarySkill,
  jevModel: result.route?.model, jevUsage: result.route?.usage, chatModel: result.generation?.model, chatUsage: result.generation?.usage,
  sourceRefs: result.sourceRefs, warnings: result.warnings,
}, null, 2));
if (result.status !== 'answered' || result.answerKind !== 'generated' || result.route?.routeStatus !== 'jev') process.exitCode = 1;

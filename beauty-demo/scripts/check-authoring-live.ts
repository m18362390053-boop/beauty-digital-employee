import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { operatorHeaders } from './operator-api.js';

// Explicit real-model usability check. Not part of the free automated test suite.
const base = process.env.BEAUTY_API_URL ?? 'http://127.0.0.1:3090';
const deadline = Date.now() + 100_000;
const authHeaders = await operatorHeaders(base);
async function api(path: string, method = 'GET', input?: unknown) {
  const response = await fetch(base + path, { method, headers: { ...authHeaders, ...(input === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: input === undefined ? undefined : JSON.stringify(input), signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
  const result = await response.json() as any;
  if (!response.ok && result.error?.code !== 'USER_EXISTS') throw new Error(`${response.status} ${result.error?.code}`);
  return result;
}
const status = await api('/api/status');
if (!status.providers.jevConfigured || !status.providers.chatConfigured) throw new Error('Configure both models in 业务配置 first.');
const product = (await api('/api/products')).items[0];
if (!product) throw new Error('Import a product or seed demo data first.');
const userId = 'authoring-live-validation';
await api('/api/users', 'POST', { userId, displayName: '组员反馈真实回归' });
const template = await fetch(base + '/api/skills/template.zip', { headers: authHeaders, signal: AbortSignal.timeout(5_000) });
if (!template.ok) throw new Error('Skill template endpoint is missing. Restart the updated backend.');
await api('/api/skills/import', 'POST', { filename: 'template.zip', encoding: 'base64', content: Buffer.from(await template.arrayBuffer()).toString('base64') });
const cases = [
  { id: 'greeting', text: '你好，你能帮我做些什么？', expected: 'conversation' },
  { id: 'emotion', text: '我最近有点烦，只想聊聊护肤这件事，不需要推荐产品。', expected: 'response' },
  { id: 'policy-question', text: '想先了解退换货政策，暂时不申请退货。', expected: 'response' },
  { id: 'uploaded-skill', text: '演示套装里面，演示精华和演示面霜应该怎么安排使用顺序？', expected: 'uploaded' },
];
const arg = process.argv.indexOf('--case');
const selected = arg < 0 ? cases : cases.filter(item => item.id === process.argv[arg + 1]);
if (!selected.length) throw new Error('Unknown --case');
await mkdir(resolve('test-results'), { recursive: true });
for (const sample of selected) {
  if (Date.now() > deadline - 45_000) { console.log(JSON.stringify({ case: sample.id, status: 'not_run', reason: '100-second budget' })); process.exitCode = 1; break; }
  const session = await api(`/api/users/${userId}/sessions`, 'POST', { productId: product.productId });
  const requestId = randomUUID(); const started = Date.now();
  const result = await api(`/api/users/${userId}/sessions/${session.sessionId}/consult`, 'POST', { requestId, content: sample.text });
  const passed = result.answerKind === 'generated' && ['answered', 'clarification_required'].includes(result.status)
    && (sample.expected !== 'uploaded' || (result.generation?.skillId === 'beauty-usage-guide' && result.sourceRefs.some((id: string) => id.startsWith('skill-'))));
  const report = { checkedAt: new Date().toISOString(), source: 'real-authoring-regression', caseId: sample.id, userId,
    sessionId: session.sessionId, requestId, input: sample.text, elapsedMs: Date.now() - started, passed, result };
  const path = resolve('test-results', `authoring-live-${sample.id}-${requestId}.json`);
  await writeFile(path, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({ case: sample.id, passed, status: result.status, answerKind: result.answerKind, skill: result.generation?.skillId,
    routeReasons: result.route?.reasonCodes, warnings: result.warnings, answer: result.answer, report: path }));
  if (!passed) { process.exitCode = 1; break; }
}

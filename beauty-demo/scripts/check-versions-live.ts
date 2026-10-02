import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { operatorHeaders } from './operator-api.js';

// Each invocation does at most one paid consultation and stays below 90 seconds.
const phase = process.argv[2] ?? 'v1';
if (!['v1', 'v2', 'rollback', 'disable'].includes(phase)) throw new Error('Use v1, v2, rollback or disable.');
const base = process.env.BEAUTY_API_URL ?? 'http://127.0.0.1:3090';
const headers = await operatorHeaders(base); const signal = AbortSignal.timeout(85_000);
async function api(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(base + path, { method, headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal });
  const data = await response.json() as any;
  if (!response.ok && data.error?.code !== 'USER_EXISTS') throw new Error(`${response.status}: ${data.error?.code}`);
  return data;
}
const id = 'demo-version-proof';
const marker = phase === 'v2' ? '紫晶-B' : '紫晶-A';
if (phase === 'v1' || phase === 'v2') {
  const skill = { id, version: phase === 'v1' ? '1.0.0' : '2.0.0',
    description: '专门核对演示产品资料中的版本标识/校验代号，仅用于版本切换验收',
    intents: ['product_advice'], knowledgeScopes: ['product'], requiredFields: [], requiresKnowledge: true,
    instructions: '用户问演示产品资料的版本标识时，准确复述knowledge中的标识并引用对应来源。不要把标识说成真实商品批次，不编造功效。',
    knowledge: [{ title: '演示产品资料版本验收', content: `本文件是功能验收示例，不是真实商品信息。当前演示产品资料的版本标识/校验代号为：${marker}。` }],
  };
  await api('/api/skills/import', 'POST', { filename: 'version-proof.json', content: JSON.stringify(skill) });
} else if (phase === 'rollback') {
  const item = (await api('/api/skills')).items.find((row: any) => row.skill.id === id);
  if (!item) throw new Error('Run v1 and v2 first.');
  await api(`/api/skills/${id}/activate`, 'POST', { version: '1.0.0', expectedCurrentVersion: item.skill.version });
} else await api(`/api/skills/${id}`, 'PATCH', { enabled: false });
const userId = 'version-live-validation';
await api('/api/users', 'POST', { userId, displayName: 'Skill版本真实验收' });
const product = (await api('/api/products')).items[0]; if (!product) throw new Error('Seed/import a product first.');
const session = await api(`/api/users/${userId}/sessions`, 'POST', { productId: product.productId });
const requestId = randomUUID(); const started = Date.now();
const result = await api(`/api/users/${userId}/sessions/${session.sessionId}/consult`, 'POST', { requestId,
  content: '请核对演示产品资料中的版本标识或校验代号是什么。只根据现有文档回答，不需要个性化护肤建议。' });
const evidence = await api(`/api/ops/runs/${result.runId}`);
const expectedVersion = phase === 'v2' ? '2.0.0' : '1.0.0';
const passed = phase === 'disable' ? result.generation?.skillId !== id && !String(result.answer).includes('紫晶-') && result.status !== 'degraded'
  : result.status === 'answered' && result.generation?.skillId === id && result.generation?.skillVersion === expectedVersion
    && String(result.answer).includes(marker) && evidence.snapshot?.skill?.version === expectedVersion;
const report = { checkedAt: new Date().toISOString(), phase, source: 'real-model-version-acceptance', userId, sessionId: session.sessionId, requestId,
  elapsedMs: Date.now() - started, passed, result, evidence };
await mkdir(resolve('test-results'), { recursive: true });
const file = resolve('test-results', `skill-versions-live-${phase}-${requestId}.json`);
await writeFile(file, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ phase, passed, status: result.status, actualSkill: result.generation?.skillId,
  actualVersion: result.generation?.skillVersion, answer: result.answer, events: evidence.events.length, report: file }, null, 2));
if (!passed) process.exitCode = 1;

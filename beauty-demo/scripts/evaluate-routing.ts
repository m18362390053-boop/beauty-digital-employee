import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { evaluationCaseSchema } from '../server/contracts/index.js';
import { loadBusinessConfig, ruleRoute } from '../server/core/registry.js';
import { JevProvider } from '../server/core/providers.js';
import { loadLocalRuntime } from '../server/local-runtime.js';

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => args.includes(name) ? args[args.indexOf(name) + 1] ?? fallback : fallback;
const inputPath = resolve(option('--cases', 'evals/routing.smoke.json'));
const outputPath = resolve(option('--out', 'test-results/routing-report.json'));
const live = args.includes('--live');
if (live) loadLocalRuntime();
const config = loadBusinessConfig();
const cases = z.array(evaluationCaseSchema).min(1).parse(JSON.parse(await readFile(inputPath, 'utf8')));
if (new Set(cases.map(c => c.caseId)).size !== cases.length) throw new Error('Duplicate caseId');
for (const c of cases) {
  if (c.expected.intent && !Object.hasOwn(config.intents, c.expected.intent)) throw new Error(`${c.caseId}: unknown intent`);
  if (c.expected.emotion && !Object.hasOwn(config.emotions, c.expected.emotion)) throw new Error(`${c.caseId}: unknown emotion`);
  if (c.expected.primarySkill && !config.skills.some(s => s.id === c.expected.primarySkill)) throw new Error(`${c.caseId}: unknown skill`);
}
const provider = new JevProvider();
if (live && !provider.configured) throw new Error('--live requires TYPESAFE_API_KEY in this terminal');
const rows = [];
let modelCalls = 0;
const budgetEnds = Date.now() + 100_000;
for (const c of cases) {
  if (Date.now() >= budgetEnds - 1_000) { rows.push({ caseId: c.caseId, status: 'not_run', reason: '100-second batch budget reached; review and resume with remaining cases' }); continue; }
  const explicit = ruleRoute(c.message, config);
  if (!explicit && !live) { rows.push({ caseId: c.caseId, status: 'not_run', reason: 'Jev inference requires explicit --live' }); continue; }
  try {
    let route = explicit?.route;
    if (!route) {
      modelCalls++;
      route = await provider.decide({ userText: c.message, recentMessages: [], card: {
        userId: 'evaluation-user', ...c.cardContext, version: 0, updatedAt: '',
      } }, config, AbortSignal.timeout(Math.min(20_000, budgetEnds - Date.now())));
    }
    const fields = ['intent', 'primarySkill', 'riskLevel', 'needsHumanHandoff', 'action'] as const;
    const differences = fields.filter(field => route![field] !== c.expected[field]).map(field => ({ field, expected: c.expected[field], actual: route![field] }));
    rows.push({ caseId: c.caseId, status: differences.length ? 'failed' : 'passed', route, differences });
  } catch (error) {
    rows.push({ caseId: c.caseId, status: 'failed', error: error instanceof Error ? error.message : 'unknown error' });
  }
}
const assessed = rows.filter(r => r.status !== 'not_run');
const passed = assessed.filter(r => r.status === 'passed').length;
const report = {
  evaluatedAt: new Date().toISOString(), policyVersion: config.version, policyStatus: config.reviewStatus,
  dataset: inputPath, datasetKinds: [...new Set(cases.map(c => c.dataKind))], mode: live ? 'live-routing' : 'rules-only',
  modelCalls, totalCases: cases.length, assessedCases: assessed.length, passed, failed: assessed.length - passed,
  notRun: cases.length - assessed.length, assessedSubsetAccuracy: assessed.length ? passed / assessed.length : null,
  note: 'Only route/policy fields are checked. This is not an independent business benchmark, reply quality assessment or a 50-case acceptance report.', rows,
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({ report: outputPath, mode: report.mode, modelCalls, passed, failed: report.failed, notRun: report.notRun }));
if (report.failed) process.exitCode = 1;

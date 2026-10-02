import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { config } from '../server/config.js';
import { operatorHeaders } from './operator-api.js';

const failedRunId = process.argv[2];
if (!failedRunId) throw new Error('Supply the failed run ID to diagnose.');
const db = new DatabaseSync(config().databasePath, { readOnly: true });
let original: { sessionId: string; userId: string; content: string; result: string };
try {
  const row = db.prepare(`SELECT r.session_id AS sessionId,s.user_id AS userId,m.content,r.result_json AS result
    FROM consultation_runs r JOIN sessions s ON s.id=r.session_id JOIN messages m ON m.id=r.user_message_id WHERE r.id=?`).get(failedRunId);
  if (!row) throw new Error('Failed run not found');
  original = row as typeof original;
  if (JSON.parse(original.result).status !== 'degraded') throw new Error('Only an explicitly failed/degraded request may be retried by this script.');
} finally { db.close(); }
const base = process.env.BEAUTY_API_URL ?? 'http://127.0.0.1:3090';
const authHeaders = await operatorHeaders(base);
const contextResponse = await fetch(`${base}/api/users/${original.userId}/sessions/${original.sessionId}/context`, { signal: AbortSignal.timeout(5_000), headers: authHeaders });
if (!contextResponse.ok) throw new Error('Unable to read session');
const context = await contextResponse.json() as { session: { status: string } };
if (context.session.status !== 'AI_ACTIVE') throw new Error('Session has entered human/closed state; not submitting a new model request.');
const requestId = randomUUID(); const start = Date.now();
const response = await fetch(`${base}/api/users/${original.userId}/sessions/${original.sessionId}/consult`, {
  method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({ requestId, content: original.content }), signal: AbortSignal.timeout(55_000),
});
const result = await response.json() as any;
console.log(JSON.stringify({ retestOf: failedRunId, requestId, elapsedMs: Date.now() - start, status: result.status,
  answerKind: result.answerKind, jevModel: result.route?.model, chatModel: result.generation?.model,
  warnings: result.warnings, diagnostics: result.diagnostics ?? null, answer: result.answer,
}, null, 2));
if (!response.ok || result.status === 'degraded') process.exitCode = 1;

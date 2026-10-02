import { DatabaseSync } from 'node:sqlite';
import { config } from '../server/config.js';

const db = new DatabaseSync(config().databasePath, { readOnly: true });
try {
  const rows = db.prepare('SELECT id,session_id,state,route_json,result_json,updated_at FROM consultation_runs ORDER BY updated_at DESC LIMIT 5').all();
  for (const row of rows) {
    const route = row.route_json ? JSON.parse(String(row.route_json)) : null;
    const result = row.result_json ? JSON.parse(String(row.result_json)) : null;
    console.log(JSON.stringify({ runId: row.id, sessionId: row.session_id, updatedAt: row.updated_at, state: row.state,
      status: result?.status, warnings: result?.warnings, routeStatus: route?.routeStatus, routeModel: route?.model,
      generationModel: result?.generation?.model, diagnostics: result?.diagnostics ?? null }));
  }
} finally { db.close(); }

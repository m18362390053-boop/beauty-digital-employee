import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { AppError } from '../core/errors.js';
import { feedbackSchema, humanReplySchema, type ConsultResult, type RouteRecord } from '../core/workflow-types.js';
import { userMessageSchema } from '../contracts/index.js';

type RunRow = { id: string; session_id: string; request_id: string; state: string; route_json: string | null; result_json: string | null };
type HandoffRow = { id: string; session_id: string; userId: string; status: 'pending' | 'active' | 'resolved'; reason: string; summary_json: string; created_at: string; claimed_at: string | null; resolved_at: string | null };
const now = () => new Date().toISOString();

export class Workflows {
  constructor(readonly store: Store) {}
  private tx<T>(fn: () => T): T {
    this.store.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.store.db.exec('COMMIT'); return value; }
    catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
  begin(userId: string, sessionId: string, input: unknown) {
    const value = userMessageSchema.parse(input);
    this.store.getSession(userId, sessionId);
    const db = this.store.db;
    const existing = db.prepare('SELECT * FROM consultation_runs WHERE session_id = ? AND request_id = ?').get(sessionId, value.requestId) as RunRow | undefined;
    if (existing) {
      // Also proves repeated requestId has exactly the original user content.
      this.store.appendUserMessage(userId, sessionId, value);
      if (existing.result_json) return { cached: JSON.parse(existing.result_json) as ConsultResult, runId: existing.id };
      throw new AppError(409, 'CONSULTATION_IN_PROGRESS', 'This request is already processing. Read its result before retrying.');
    }
    if (db.prepare("SELECT id FROM consultation_runs WHERE session_id = ? AND state = 'running'").get(sessionId)) {
      throw new AppError(409, 'SESSION_BUSY', 'Another consultation is running. Wait or request human handoff.');
    }
    const message = this.store.appendUserMessage(userId, sessionId, value).message;
    const runId = randomUUID();
    db.prepare("INSERT INTO consultation_runs (id,session_id,request_id,user_message_id,state,created_at,updated_at) VALUES (?,?,?,?,'running',?,?)")
      .run(runId, sessionId, value.requestId, message.messageId, now(), now());
    return { cached: null, runId };
  }
  result(userId: string, sessionId: string, requestId: string) {
    this.store.getSession(userId, sessionId);
    const row = this.store.db.prepare('SELECT * FROM consultation_runs WHERE session_id = ? AND request_id = ?').get(sessionId, requestId) as RunRow | undefined;
    if (!row) throw new AppError(404, 'RUN_NOT_FOUND', 'Consultation not found');
    return { state: row.state, result: row.result_json ? JSON.parse(row.result_json) as ConsultResult : null };
  }
  saveRoute(runId: string, route: RouteRecord) {
    this.store.db.prepare("UPDATE consultation_runs SET route_json = ?, updated_at = ? WHERE id = ? AND state = 'running'")
      .run(JSON.stringify(route), now(), runId);
  }
  finish(userId: string, result: ConsultResult, expectedVersion: number, requireActive = true): ConsultResult {
    return this.tx(() => {
      const db = this.store.db;
      const row = db.prepare('SELECT * FROM consultation_runs WHERE id = ?').get(result.runId) as RunRow;
      if (row.result_json) return JSON.parse(row.result_json) as ConsultResult;
      const session = this.store.getSession(userId, result.sessionId);
      if (requireActive && (session.status !== 'AI_ACTIVE' || session.stateVersion !== expectedVersion)) {
        result = { ...result, status: 'interrupted', answer: null, answerKind: 'none', sourceRefs: [], messageId: null, warnings: [...result.warnings, 'SESSION_CHANGED'] };
      }
      if (result.answer !== null) {
        const role = ['handoff_pending', 'human_active', 'resolved'].includes(result.status) ? 'system' : 'assistant';
        result.messageId = randomUUID();
        db.prepare('INSERT INTO messages(id,session_id,request_id,role,content,created_at,metadata) VALUES(?,?,?,?,?,?,?)').run(
          result.messageId, result.sessionId, `response-${result.runId}`, role, result.answer, now(),
          JSON.stringify({ answerKind: result.answerKind, sourceRefs: result.sourceRefs, route: result.route, warnings: result.warnings, dataKind: result.dataKind }),
        );
      }
      db.prepare("UPDATE consultation_runs SET state = 'completed', result_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(result), now(), result.runId);
      return result;
    });
  }
  private interruptSession(sessionId: string, reason: string, exceptRunId?: string) {
    const db = this.store.db;
    const rows = db.prepare("SELECT * FROM consultation_runs WHERE session_id = ? AND state = 'running'").all(sessionId) as RunRow[];
    const session = db.prepare('SELECT product_id FROM sessions WHERE id = ?').get(sessionId) as { product_id: string };
    const product = this.store.getProduct(session.product_id);
    for (const row of rows) {
      if (row.id === exceptRunId) continue;
      const route = row.route_json ? JSON.parse(row.route_json) as RouteRecord : null;
      const result: ConsultResult = {
        runId: row.id, requestId: row.request_id, sessionId, status: 'interrupted', answer: null, answerKind: 'none', messageId: null,
        sourceRefs: [], route: route ? { ...route } : null, warnings: [reason], policyStatus: route?.policyStatus ?? 'demo',
        dataKind: product.dataKind, handoffId: null, generation: null,
      };
      db.prepare("UPDATE consultation_runs SET state = 'interrupted', result_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(result), now(), row.id);
    }
  }
  recoverInterrupted() {
    const sessions = this.store.db.prepare("SELECT DISTINCT session_id FROM consultation_runs WHERE state = 'running'").all() as { session_id: string }[];
    this.tx(() => { for (const row of sessions) this.interruptSession(row.session_id, 'SERVER_RESTARTED'); });
    return sessions.length;
  }
  requestHandoff(userId: string, sessionId: string, reason: string, exceptRunId?: string) {
    return this.tx(() => {
      const session = this.store.getSession(userId, sessionId);
      if (session.status === 'RESOLVED') throw new AppError(409, 'SESSION_RESOLVED', 'Create a new session after resolution');
      this.interruptSession(sessionId, 'HUMAN_HANDOFF', exceptRunId);
      const existing = this.store.db.prepare("SELECT id FROM handoffs WHERE session_id = ? AND status != 'resolved'").get(sessionId) as { id: string } | undefined;
      const context = this.store.getContext(userId, sessionId);
      const userMessages = context.recentMessages.filter(message => message.role === 'user').map(message => ({ messageId: message.messageId, text: message.content }));
      const summary = {
        product: this.store.getProduct(session.productId).name, productId: session.productId,
        reportedFacts: userMessages, symptoms: '请根据以下用户原话核实，未自动诊断', onsetTime: '未结构化确认，请向用户核实',
        request: userMessages.at(-1)?.text ?? '未提供', cardConcerns: context.card.concerns,
        method: 'source_messages_template',
      };
      if (existing) {
        this.store.db.prepare('UPDATE handoffs SET summary_json = ?, reason = ? WHERE id = ?').run(JSON.stringify(summary), reason, existing.id);
        return this.getHandoff(existing.id);
      }
      const id = randomUUID();
      this.store.db.prepare("INSERT INTO handoffs(id,session_id,status,reason,summary_json,created_at) VALUES(?,?,'pending',?,?,?)")
        .run(id, sessionId, reason, JSON.stringify(summary), now());
      this.store.db.prepare("UPDATE sessions SET status = 'HANDOFF_PENDING', state_version = state_version + 1 WHERE id = ?").run(sessionId);
      return this.getHandoff(id);
    });
  }
  getHandoff(id: string) {
    const row = this.store.db.prepare(`SELECT h.*, s.user_id AS userId FROM handoffs h JOIN sessions s ON s.id = h.session_id WHERE h.id = ?`).get(id) as HandoffRow | undefined;
    if (!row) throw new AppError(404, 'HANDOFF_NOT_FOUND', 'Handoff not found');
    const { summary_json, ...rest } = row;
    return { ...rest, summary: JSON.parse(summary_json) };
  }
  listHandoffs() {
    return (this.store.db.prepare('SELECT id FROM handoffs ORDER BY created_at DESC').all() as { id: string }[]).map(row => this.getHandoff(row.id));
  }
  claim(id: string) {
    return this.tx(() => {
      const item = this.getHandoff(id);
      if (item.status === 'resolved') throw new AppError(409, 'HANDOFF_RESOLVED', 'Handoff already resolved');
      if (item.status === 'pending') {
        this.store.db.prepare("UPDATE handoffs SET status = 'active', claimed_at = ? WHERE id = ?").run(now(), id);
        this.store.db.prepare("UPDATE sessions SET status = 'HUMAN_ACTIVE', state_version = state_version + 1 WHERE id = ?").run(item.session_id);
      }
      return this.getHandoff(id);
    });
  }
  humanReply(id: string, input: unknown) {
    const value = humanReplySchema.parse(input);
    return this.tx(() => {
      const handoff = this.getHandoff(id);
      const requestId = `human-${value.requestId}`;
      const old = this.store.db.prepare('SELECT id, content, role FROM messages WHERE session_id = ? AND request_id = ?').get(handoff.session_id, requestId) as { id: string; content: string; role: string } | undefined;
      if (old) {
        if (old.content !== value.content || old.role !== 'human') throw new AppError(409, 'REQUEST_CONFLICT', 'Human requestId reused with different content');
        return { messageId: old.id, duplicate: true };
      }
      if (handoff.status !== 'active') throw new AppError(409, 'HANDOFF_NOT_ACTIVE', 'Claim handoff before replying');
      const messageId = randomUUID();
      this.store.db.prepare('INSERT INTO messages(id,session_id,request_id,role,content,created_at) VALUES(?,?,?,?,?,?)')
        .run(messageId, handoff.session_id, requestId, 'human', value.content, now());
      return { messageId, duplicate: false };
    });
  }
  resolve(id: string) {
    return this.tx(() => {
      const item = this.getHandoff(id);
      if (item.status === 'pending') throw new AppError(409, 'HANDOFF_NOT_ACTIVE', 'Claim before resolving');
      if (item.status !== 'resolved') {
        this.store.db.prepare("UPDATE handoffs SET status = 'resolved', resolved_at = ? WHERE id = ?").run(now(), id);
        this.store.db.prepare("UPDATE sessions SET status = 'RESOLVED', state_version = state_version + 1 WHERE id = ?").run(item.session_id);
      }
      return this.getHandoff(id);
    });
  }
  saveFeedback(userId: string, messageId: string, input: unknown) {
    const value = feedbackSchema.parse(input);
    const message = this.store.db.prepare(`SELECT m.role, m.session_id FROM messages m JOIN sessions s ON s.id=m.session_id WHERE m.id=? AND s.user_id=?`)
      .get(messageId, userId) as { role: string; session_id: string } | undefined;
    if (!message) throw new AppError(404, 'MESSAGE_NOT_FOUND', 'Message not found for user');
    if (!['assistant', 'human'].includes(message.role)) throw new AppError(422, 'NOT_FEEDBACK_TARGET', 'Only assistant or human replies accept feedback');
    this.store.db.prepare(`INSERT INTO feedback VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,message_id) DO UPDATE SET type=excluded.type, reason=excluded.reason, updated_at=excluded.updated_at`)
      .run(userId, messageId, value.type, value.reason, now(), now());
    return { ...value, userId, messageId, sessionId: message.session_id };
  }
  dashboard() {
    const db = this.store.db;
    const comments = (db.prepare('SELECT document, batch_id FROM comments').all() as { document: string; batch_id: string }[])
      .map(row => ({ ...JSON.parse(row.document), batchId: row.batch_id })) as { commentId: string; tags: string[]; publishedAt: string | null; dataKind: string; batchId: string }[];
    const tagMap = new Map<string, string[]>();
    const coMap = new Map<string, string[]>();
    const trend = new Map<string, string[]>();
    for (const c of comments) {
      const tags = [...new Set(c.tags)].sort();
      for (const tag of tags) tagMap.set(tag, [...(tagMap.get(tag) ?? []), c.commentId]);
      for (let i = 0; i < tags.length; i++) for (let j = i + 1; j < tags.length; j++) {
        const key = JSON.stringify([tags[i], tags[j]]); coMap.set(key, [...(coMap.get(key) ?? []), c.commentId]);
      }
      const month = c.publishedAt?.slice(0, 7) ?? 'unknown'; trend.set(month, [...(trend.get(month) ?? []), c.commentId]);
    }
    const sessions = db.prepare('SELECT id, status FROM sessions').all() as { id: string; status: string }[];
    const runs = db.prepare('SELECT id,session_id,route_json,result_json FROM consultation_runs').all() as RunRow[];
    const risks = new Map<string, { risk: string; runIds: string[] }>();
    const weight: Record<string, number> = { low: 1, medium: 2, high: 3 };
    for (const run of runs) if (run.route_json) {
      const route = JSON.parse(run.route_json) as RouteRecord;
      if (!route.riskLevel) continue;
      const old = risks.get(run.session_id);
      risks.set(run.session_id, { risk: old && weight[old.risk]! > weight[route.riskLevel]! ? old.risk : route.riskLevel, runIds: [...(old?.runIds ?? []), run.id] });
    }
    const feedback = db.prepare('SELECT user_id AS userId,message_id AS messageId,type,reason FROM feedback').all() as { userId: string; messageId: string; type: string; reason: string }[];
    const helpful = feedback.filter(f => f.type === 'helpful').length;
    const unresolved = feedback.filter(f => f.type === 'unresolved').length;
    const batches = db.prepare('SELECT document FROM comment_batches').all() as { document: string }[];
    return {
      updatedAt: now(),
      comments: {
        sampleSize: comments.length, unknownDateCount: comments.filter(c => !c.publishedAt).length,
        dataKinds: [...new Set(comments.map(c => c.dataKind))],
        batches: batches.map(row => { const b = JSON.parse(row.document); return { batchId: b.batchId, period: b.period, commentIds: b.comments.map((c: { commentId: string }) => c.commentId) }; }),
        tags: [...tagMap].map(([tag, commentIds]) => ({ tag, count: commentIds.length, share: comments.length ? commentIds.length / comments.length : 0, commentIds })),
        cooccurrence: [...coMap].map(([pair, commentIds]) => ({ tags: JSON.parse(pair), count: commentIds.length, commentIds })),
        trend: [...trend].sort(([a], [b]) => a.localeCompare(b)).map(([month, commentIds]) => ({ month, count: commentIds.length, commentIds })),
        denominator: 'unique imported comments; multi-label shares may sum above 100%; unknown dates shown separately',
      },
      service: {
        totalSessions: sessions.length, sessions, consultationCount: runs.length,
        riskSessions: [...risks].map(([sessionId, risk]) => ({ sessionId, ...risk })),
        highRiskSessions: [...risks.values()].filter(r => r.risk === 'high').length,
        pendingHandoffs: sessions.filter(s => s.status === 'HANDOFF_PENDING').length,
        activeHandoffs: sessions.filter(s => s.status === 'HUMAN_ACTIVE').length,
        feedback, helpful, unresolved, requestedHuman: feedback.filter(f => f.type === 'request_human').length,
        helpfulRate: helpful + unresolved ? helpful / (helpful + unresolved) : null,
        denominator: 'helpful / (helpful + unresolved); request_human and missing feedback excluded',
      },
    };
  }
}

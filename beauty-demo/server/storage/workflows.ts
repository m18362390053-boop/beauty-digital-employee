import { randomUUID } from 'node:crypto';
import { Store } from './store.js';
import { AppError } from '../core/errors.js';
import { feedbackSchema, humanReplySchema, type ConsultResult, type RouteRecord } from '../core/workflow-types.js';
import { userMessageSchema, type Card, type ProductDocument } from '../contracts/index.js';
import type { BusinessSkill } from '../core/workflow-types.js';

type RunRow = { id: string; session_id: string; request_id: string; state: string; route_json: string | null; result_json: string | null };
type HandoffRow = { id: string; session_id: string; userId: string; status: 'pending' | 'active' | 'resolved'; reason: string; summary_json: string; created_at: string; claimed_at: string | null; resolved_at: string | null };
const now = () => new Date().toISOString();
const displayNames: Record<string, string> = {
  jev: 'Jev模型判断', rule_override: '明确规则优先', degraded: '服务降级',
  low: '低风险', medium: '需要谨慎确认', high: '高风险',
  product_advice: '产品咨询', after_sales: '售后服务', emotional_support: '情绪承接', safety: '风险求助',
  answer: '生成答复', clarify: '针对性追问', handoff: '请求人工', fallback: '兜底处理',
  answered: '已回答', clarification_required: '等待补充信息', handoff_pending: '等待人工', human_active: '人工处理中',
  resolved: '已结束', cancelled: '已取消', interrupted: '已中止', running: '处理中',
  generated: '模型生成', template: '服务提示模板', none: '未发布回复',
  JEV_CLASSIFIED: '已完成意图和风险判定', EXPLICIT_RULE: '命中明确的处理规则', JEV_HANDOFF: '判断需要人工服务',
  NO_BUSINESS_INTENT: '尚未识别明确业务诉求', NO_MATCHING_SKILL: '没有合适的业务Skill',
  LOW_INTENT_CONFIDENCE: '意图判断置信度不足', LOW_SKILL_CONFIDENCE: 'Skill选择置信度不足', LOW_RISK_CONFIDENCE: '风险判断需要确认',
  INTENT_SKILL_MISMATCH: '意图与Skill范围不匹配', RISK_CLARIFICATION: '需澄清不适风险',
  MISSING_USER_INFORMATION: '需要补充用户信息', MISSING_CARD_FIELDS: '缺少必要档案字段',
  HUMAN_OR_CLOSED_SESSION: '人工处理或已结束会话', HUMAN_HANDOFF: '人工接管，停止AI', SERVER_RESTARTED: '服务重启后中止旧请求',
};
function readable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(readable);
  if (typeof value === 'boolean') return value ? '是' : '否';
  return typeof value === 'string' ? displayNames[value] ?? value : value;
}

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
    this.event(runId, 'received', '收到用户请求', { 消息ID: message.messageId, 请求ID: value.requestId });
    return { cached: null, runId };
  }
  result(userId: string, sessionId: string, requestId: string) {
    this.store.getSession(userId, sessionId);
    const row = this.store.db.prepare('SELECT * FROM consultation_runs WHERE session_id = ? AND request_id = ?').get(sessionId, requestId) as RunRow | undefined;
    if (!row) throw new AppError(404, 'RUN_NOT_FOUND', 'Consultation not found');
    return { state: row.state, result: row.result_json ? JSON.parse(row.result_json) as ConsultResult : null };
  }
  saveRoute(runId: string, route: RouteRecord) {
    const updated = this.store.db.prepare("UPDATE consultation_runs SET route_json = ?, updated_at = ? WHERE id = ? AND state = 'running'")
      .run(JSON.stringify(route), now(), runId);
    if (updated.changes) this.event(runId, 'decision', '形成业务决策', { 来源: route.routeStatus, 意图: route.intent, 风险: route.riskLevel, 建议Skill: route.primarySkill, 动作: route.action, 原因: route.reasonCodes, 实际模型: route.model });
  }
  event(runId: string, kind: string, title: string, details: Record<string, unknown> = {}) {
    this.store.db.prepare('INSERT INTO run_events(run_id,kind,title,details,created_at) VALUES(?,?,?,?,?)').run(runId, kind, title, JSON.stringify(details), now());
  }
  captureCard(runId: string, card: Card, policyVersion: string) {
    this.store.db.prepare('INSERT INTO run_snapshots(run_id,card_json,policy_version) VALUES(?,?,?) ON CONFLICT(run_id) DO UPDATE SET card_json=excluded.card_json,policy_version=excluded.policy_version')
      .run(runId, JSON.stringify(card), policyVersion);
    this.event(runId, 'profile', '读取已确认的用户资料', { 用户: card.userId, 资料版本: card.version, 偏好: card.preferences, 关注点: card.concerns, 策略版本: policyVersion });
  }
  captureSkill(runId: string, skill: BusinessSkill, knowledge: ProductDocument) {
    this.store.db.prepare('UPDATE run_snapshots SET skill_json=?,knowledge_json=? WHERE run_id=?').run(JSON.stringify(skill), JSON.stringify(knowledge), runId);
    this.event(runId, 'skill', '加载实际执行的Skill文档', { Skill: skill.id, 职责: skill.description, 版本: skill.version, 知识条目数: knowledge.facts.length, 来源: knowledge.sources.map(s => `${s.title} (${s.sourceId})`) });
  }
  publicSources(runId: string, refs: string[]) {
    const row = this.store.db.prepare('SELECT knowledge_json FROM run_snapshots WHERE run_id=?').get(runId) as { knowledge_json: string | null } | undefined;
    const knowledge = row?.knowledge_json ? JSON.parse(row.knowledge_json) as ProductDocument : null;
    return refs.map(id => ({ id, title: knowledge?.sources.find(source => source.sourceId === id)?.title ?? '已存档的产品资料' }));
  }
  finish(userId: string, result: ConsultResult, expectedVersion: number, requireActive = true): ConsultResult {
    return this.tx(() => {
      const db = this.store.db;
      const row = db.prepare('SELECT * FROM consultation_runs WHERE id = ?').get(result.runId) as RunRow;
      if (row.result_json) return JSON.parse(row.result_json) as ConsultResult;
      const session = this.store.getSession(userId, result.sessionId);
      if (requireActive && (session.status !== 'AI_ACTIVE' || session.stateVersion !== expectedVersion)) {
        result = { ...result, status: 'interrupted', answer: null, answerKind: 'none', sourceRefs: [], productCards: [], visualGuide: null, messageId: null, warnings: [...result.warnings, 'SESSION_CHANGED'] };
      }
      if (result.answer !== null) {
        const role = ['handoff_pending', 'human_active', 'resolved'].includes(result.status) ? 'system' : 'assistant';
        result.messageId = randomUUID();
        db.prepare('INSERT INTO messages(id,session_id,request_id,role,content,created_at,metadata) VALUES(?,?,?,?,?,?,?)').run(
          result.messageId, result.sessionId, `response-${result.runId}`, role, result.answer, now(),
          JSON.stringify({ runId: result.runId, status: result.status, answerKind: result.answerKind, sourceRefs: result.sourceRefs,
            productCards: result.productCards, visualGuide: result.visualGuide, route: result.route, warnings: result.warnings, dataKind: result.dataKind }),
        );
      }
      db.prepare("UPDATE consultation_runs SET state = 'completed', result_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(result), now(), result.runId);
      this.event(result.runId, 'finished', '保存处理结果', { 结果: result.status, 回答类型: result.answerKind, 回复消息ID: result.messageId, 引用: result.sourceRefs });
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
        dataKind: product.dataKind, handoffId: null, generation: null, productCards: [], visualGuide: null,
      };
      db.prepare("UPDATE consultation_runs SET state = 'interrupted', result_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(result), now(), row.id);
      this.event(row.id, 'interrupted', '中止AI处理', { 原因: reason });
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
  listRuns(limit = 100) {
    const rows = this.store.db.prepare(`SELECT r.id AS runId,r.created_at AS createdAt,r.state,r.result_json,m.content AS input,u.display_name AS userName
      FROM consultation_runs r JOIN messages m ON m.id=r.user_message_id JOIN sessions s ON s.id=r.session_id JOIN users u ON u.id=s.user_id
      ORDER BY r.created_at DESC LIMIT ?`).all(limit) as { runId: string; createdAt: string; state: string; result_json: string | null; input: string; userName: string }[];
    return rows.map(({ result_json, ...row }) => ({ ...row, status: result_json ? (JSON.parse(result_json) as ConsultResult).status : row.state }));
  }
  runDetail(runId: string) {
    const row = this.store.db.prepare(`SELECT r.*,m.content AS input,s.user_id AS userId FROM consultation_runs r
      JOIN messages m ON m.id=r.user_message_id JOIN sessions s ON s.id=r.session_id WHERE r.id=?`).get(runId) as (RunRow & { input: string; userId: string; created_at: string }) | undefined;
    if (!row) throw new AppError(404, 'RUN_NOT_FOUND', '执行记录不存在。');
    const result = row.result_json ? JSON.parse(row.result_json) as ConsultResult : null;
    const route = row.route_json ? JSON.parse(row.route_json) as RouteRecord : null;
    const snap = this.store.db.prepare('SELECT * FROM run_snapshots WHERE run_id=?').get(runId) as { card_json: string | null; skill_json: string | null; knowledge_json: string | null; policy_version: string | null } | undefined;
    const events = (this.store.db.prepare('SELECT kind,title,details,created_at AS createdAt FROM run_events WHERE run_id=? ORDER BY sequence').all(runId) as { kind: string; title: string; details: string; createdAt: string }[])
      .map(({ details, ...event }) => ({ ...event, readable: Object.fromEntries(Object.entries(JSON.parse(details) as Record<string, unknown>).map(([key, value]) => [key, readable(value)])) }));
    const ticket = this.store.db.prepare('SELECT id FROM handoffs WHERE session_id=? ORDER BY created_at DESC LIMIT 1').get(row.session_id) as { id: string } | undefined;
    return {
      runId, sessionId: row.session_id, userId: row.userId, input: row.input, createdAt: row.created_at, status: result?.status ?? row.state,
      summary: { 决策来源: readable(route?.routeStatus) ?? '尚未完成', 意图: readable(route?.intent), 风险: readable(route?.riskLevel),
        Jev原始选择: (route?.rawAnswers as { primary_skill?: { choice?: string } } | null)?.primary_skill?.choice ?? '—',
        实际Skill: result?.generation?.skillId ?? route?.primarySkill, Skill版本: result?.generation?.skillVersion,
        策略版本: route?.policyVersion, 判断模型: route?.model, 回复模型: result?.generation?.model, 分支原因: readable(route?.reasonCodes ?? []), 状态: readable(result?.status ?? row.state) },
      events, snapshot: snap ? { card: snap.card_json ? JSON.parse(snap.card_json) : null, skill: snap.skill_json ? JSON.parse(snap.skill_json) : null,
        knowledge: snap.knowledge_json ? JSON.parse(snap.knowledge_json) : null, policyVersion: snap.policy_version } : null,
      route, result, handoff: ticket ? this.getHandoff(ticket.id) : null,
      feedback: this.store.db.prepare(`SELECT f.message_id AS messageId,f.type,f.reason,f.updated_at AS updatedAt FROM feedback f
        JOIN messages m ON m.id=f.message_id WHERE m.session_id=? ORDER BY f.updated_at`).all(row.session_id),
      humanReplies: this.store.db.prepare("SELECT content,created_at AS createdAt FROM messages WHERE session_id=? AND role='human' ORDER BY sequence").all(row.session_id),
    };
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

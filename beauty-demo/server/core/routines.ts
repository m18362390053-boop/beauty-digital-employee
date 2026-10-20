import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { idSchema } from '../contracts/index.js';
import { AppError } from './errors.js';
import { Store } from '../storage/store.js';
import { CarePlans } from './care-plans.js';

export const routineStartSchema = z.object({
  requestId: idSchema, period: z.enum(['morning', 'evening']),
  productIds: z.array(idSchema).min(1).max(3).refine(ids => new Set(ids).size === ids.length, 'Products must be unique'),
  confirmed: z.literal(true),
}).strict();
export const routineActionSchema = z.object({
  requestId: idSchema, expectedStep: z.number().int().nonnegative(),
  action: z.enum(['confirm', 'repeat', 'skip', 'stop']),
  source: z.enum(['screen', 'typed_text', 'device_button']).default('screen'),
  feeling: z.string().trim().max(200).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.feeling && value.action !== 'confirm') ctx.addIssue({ code: 'custom', path: ['feeling'], message: 'Only a confirmed step may have a feeling' });
});
export const packageTextSchema = z.object({ observedText: z.string().trim().min(2).max(500) }).strict();
export const routineTextSchema = z.object({ requestId: idSchema, expectedStep: z.number().int().nonnegative(),
  text: z.string().trim().min(1).max(100) }).strict();
const textActions: Record<string, 'confirm' | 'repeat' | 'skip' | 'stop'> = {
  好了: 'confirm', 完成: 'confirm', 重说: 'repeat', 再说一遍: 'repeat', 跳过: 'skip', 停止: 'stop',
};

type Step = { productId: string; productName: string; productVersion: string; dataKind: 'demo' | 'business';
  instruction: string; sourceId: string; sourceTitle: string; caution: string[] };
type RunRow = { id: string; user_id: string; period: 'morning' | 'evening'; status: 'active' | 'finished' | 'stopped';
  current_step: number; steps_json: string; plan_json: string | null; created_at: string; updated_at: string };
type EventRow = { id: string; run_id: string; step_index: number; product_id: string; source: string;
  feeling: string | null; created_at: string; voided_at: string | null };

export class Routines {
  constructor(private store: Store) {}

  private plans() { return new CarePlans(this.store); }

  eligibleProducts() {
    const planIds = new Set(this.plans().list().flatMap(plan => plan.steps.filter(step =>
      this.store.getProduct(step.productId).version === step.productVersion).map(step => step.productId)));
    return this.store.listProducts().filter(product => (product.dataKind === 'demo' || planIds.has(product.productId))
      && this.store.getKnowledge(product.productId).facts.some(fact => fact.category === 'usage'));
  }

  /** Packaging text can suggest candidates, never establish product identity. OCR is not provided here. */
  candidates(input: unknown) {
    const { observedText } = packageTextSchema.parse(input);
    const normalized = observedText.replace(/\s+/g, '').toLowerCase();
    return { status: 'confirmation_required' as const, recognition: 'text_match_only' as const,
      items: this.eligibleProducts().filter(product => normalized.includes(product.name.replace(/\s+/g, '').toLowerCase())) };
  }

  private run(userId: string, runId: string): RunRow {
    const row = this.store.db.prepare('SELECT * FROM routine_runs WHERE id=? AND user_id=?').get(runId, userId) as RunRow | undefined;
    if (!row) throw new AppError(404, 'ROUTINE_NOT_FOUND', '没有找到你的护理流程。');
    return row;
  }

  private view(row: RunRow) {
    const steps = JSON.parse(row.steps_json) as Step[];
    return { routineId: row.id, period: row.period, status: row.status, currentStep: row.current_step, steps,
      plan: row.plan_json ? JSON.parse(row.plan_json) : null,
      current: row.status === 'active' ? steps[row.current_step] ?? null : null,
      createdAt: row.created_at, updatedAt: row.updated_at };
  }

  current(userId: string) {
    this.store.getCard(userId);
    const row = this.store.db.prepare("SELECT * FROM routine_runs WHERE user_id=? AND status='active'").get(userId) as RunRow | undefined;
    return row ? this.view(row) : null;
  }

  get(userId: string, runId: string) { return this.view(this.run(userId, runId)); }

  start(userId: string, input: unknown) {
    const value = routineStartSchema.parse(input);
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      this.store.getCard(userId);
      const previous = this.store.db.prepare('SELECT id, start_json FROM routine_runs WHERE user_id=? AND start_request_id=?')
        .get(userId, value.requestId) as { id: string; start_json: string } | undefined;
      if (previous) {
        if (previous.start_json !== JSON.stringify(value)) throw new AppError(409, 'REQUEST_CONFLICT', '此操作编号已用于其他内容。');
        const result = this.get(userId, previous.id); this.store.db.exec('COMMIT'); return result;
      }
      if (this.current(userId)) throw new AppError(409, 'ROUTINE_ALREADY_ACTIVE', '请先完成或停止当前护理流程。');
      const business = value.productIds.some(id => this.store.getProduct(id).dataKind === 'business');
      if (business && value.productIds.some(id => this.store.getProduct(id).dataKind !== 'business')) {
        throw new AppError(422, 'CARE_PLAN_NOT_REVIEWED', '演示商品与正式商品不可混合建立护理流程。');
      }
      const plan = business ? this.plans().matching(value.period, value.productIds) : null;
      if (business && !plan) throw new AppError(422, 'CARE_PLAN_NOT_REVIEWED', '此时段与产品顺序尚无已审核计划，或商品版本已变化。');
      const steps: Step[] = value.productIds.map((id, index) => {
        const product = this.store.getKnowledge(id);
        const usage = product.facts.find(fact => fact.category === 'usage'
          && (!plan || fact.factId === plan.steps[index]!.usageFactId));
        if (!usage) throw new AppError(422, 'USAGE_NOT_REVIEWED', `${product.name}没有已审核的使用说明，暂不能加入护理流程。`);
        const source = product.sources.find(item => item.sourceId === usage.sourceId)!;
        return { productId: id, productName: product.name, productVersion: product.version, dataKind: product.dataKind,
          instruction: usage.text, sourceId: source.sourceId, sourceTitle: source.title,
          caution: product.facts.filter(fact => fact.category === 'precautions').map(fact => fact.text) };
      });
      const id = randomUUID(); const time = new Date().toISOString();
      this.store.db.prepare(`INSERT INTO routine_runs
        (id,user_id,start_request_id,start_json,period,status,current_step,steps_json,created_at,updated_at,plan_json)
        VALUES(?,?,?,?,?,'active',0,?,?,?,?)`).run(id, userId, value.requestId, JSON.stringify(value), value.period, JSON.stringify(steps), time, time,
          plan ? JSON.stringify({ planId: plan.planId, version: plan.version, scope: plan.scope, reviewedBy: plan.reviewedBy,
            reviewedAt: plan.reviewedAt, reviewSource: plan.reviewSource }) : null);
      const result = this.get(userId, id); this.store.db.exec('COMMIT'); return result;
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }

  act(userId: string, runId: string, input: unknown) {
    const value = routineActionSchema.parse(input);
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.run(userId, runId);
      const payload = JSON.stringify(value);
      const prior = this.store.db.prepare('SELECT input_json, result_json FROM routine_actions WHERE run_id=? AND request_id=?')
        .get(runId, value.requestId) as { input_json: string; result_json: string } | undefined;
      if (prior) {
        if (prior.input_json !== payload) throw new AppError(409, 'REQUEST_CONFLICT', '此操作编号已用于其他内容。');
        this.store.db.exec('COMMIT'); return JSON.parse(prior.result_json);
      }
      if (row.status !== 'active') throw new AppError(409, 'ROUTINE_NOT_ACTIVE', '护理流程已结束。');
      if (row.current_step !== value.expectedStep) throw new AppError(409, 'STEP_CHANGED', '步骤已变化，请刷新后再操作。');
      const steps = JSON.parse(row.steps_json) as Step[];
      const step = steps[row.current_step]!;
      const time = new Date().toISOString();
      let eventId: string | null = null;
      let next = row.current_step;
      let status: RunRow['status'] = row.status;
      if (value.action === 'confirm') {
        eventId = randomUUID();
        this.store.db.prepare(`INSERT INTO care_events(id,run_id,step_index,product_id,source,feeling,created_at)
          VALUES(?,?,?,?,?,?,?)`).run(eventId, runId, next, step.productId, value.source, value.feeling ?? null, time);
      }
      if (value.action === 'confirm' || value.action === 'skip') next++;
      if (value.action === 'stop') status = 'stopped';
      else if (next === steps.length) status = 'finished';
      this.store.db.prepare('UPDATE routine_runs SET current_step=?,status=?,updated_at=? WHERE id=?').run(next, status, time, runId);
      const result = { ...this.get(userId, runId), action: value.action, eventId };
      this.store.db.prepare('INSERT INTO routine_actions(run_id,request_id,input_json,result_json,created_at) VALUES(?,?,?,?,?)')
        .run(runId, value.requestId, payload, JSON.stringify(result), time);
      this.store.db.exec('COMMIT'); return result;
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }

  typedCommand(userId: string, runId: string, input: unknown) {
    const value = routineTextSchema.parse(input);
    const action = textActions[value.text.replace(/[！!。，,.\s]/g, '')];
    if (!action) throw new AppError(422, 'COMMAND_NOT_RECOGNIZED', '只支持“好了、重说、跳过、停止”；未改变护理步骤。');
    return this.act(userId, runId, { requestId: value.requestId, expectedStep: value.expectedStep, action, source: 'typed_text' });
  }

  events(userId: string) {
    this.store.getCard(userId);
    const rows = this.store.db.prepare(`SELECT e.* FROM care_events e JOIN routine_runs r ON e.run_id=r.id
      WHERE r.user_id=? ORDER BY e.created_at DESC LIMIT 100`).all(userId) as EventRow[];
    return rows.map(row => ({ eventId: row.id, routineId: row.run_id, stepIndex: row.step_index,
      productId: row.product_id, source: row.source, feeling: row.feeling, createdAt: row.created_at, voidedAt: row.voided_at }));
  }

  operatorTimeline() {
    const rows = this.store.db.prepare(`SELECT e.id AS eventId,r.user_id AS userId,e.run_id AS routineId,
      r.period,r.steps_json AS stepsJson,e.step_index AS stepIndex,e.source,e.feeling,
      e.created_at AS createdAt,e.voided_at AS voidedAt
      FROM care_events e JOIN routine_runs r ON e.run_id=r.id ORDER BY e.created_at DESC LIMIT 100`).all() as {
        eventId: string; userId: string; routineId: string; period: string; stepsJson: string; stepIndex: number;
        source: string; feeling: string | null; createdAt: string; voidedAt: string | null;
      }[];
    return rows.map(({ stepsJson, stepIndex, ...row }) => ({ ...row, stepIndex, step: (JSON.parse(stepsJson) as Step[])[stepIndex] }));
  }

  operatorActions() {
    const rows = this.store.db.prepare(`SELECT a.run_id AS routineId,r.user_id AS userId,a.request_id AS requestId,
      a.input_json AS inputJson,a.result_json AS resultJson,a.created_at AS createdAt
      FROM routine_actions a JOIN routine_runs r ON r.id=a.run_id ORDER BY a.created_at DESC LIMIT 100`).all() as {
        routineId: string; userId: string; requestId: string; inputJson: string; resultJson: string; createdAt: string;
      }[];
    return rows.map(({ inputJson, resultJson, ...row }) => {
      const input = JSON.parse(inputJson) as { action: string; source: string; expectedStep: number };
      const result = JSON.parse(resultJson) as { status: string; eventId: string | null };
      return { ...row, action: input.action, source: input.source, expectedStep: input.expectedStep,
        nextStatus: result.status, eventId: result.eventId };
    });
  }

  voidEvent(userId: string, eventId: string) {
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.store.db.prepare(`SELECT e.id,e.voided_at FROM care_events e JOIN routine_runs r ON e.run_id=r.id
        WHERE e.id=? AND r.user_id=?`).get(eventId, userId) as { id: string; voided_at: string | null } | undefined;
      if (!row) throw new AppError(404, 'CARE_EVENT_NOT_FOUND', '没有找到你的护理记录。');
      if (!row.voided_at) this.store.db.prepare('UPDATE care_events SET voided_at=? WHERE id=?').run(new Date().toISOString(), eventId);
      this.store.db.exec('COMMIT'); return { eventId, voided: true };
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
  }
}

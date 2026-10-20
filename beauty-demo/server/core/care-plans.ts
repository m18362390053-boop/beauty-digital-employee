import { createHash } from 'node:crypto';
import { z } from 'zod';
import { idSchema } from '../contracts/index.js';
import { AppError } from './errors.js';
import { Store } from '../storage/store.js';

export const carePlanSchema = z.object({
  planId: idSchema, version: idSchema, period: z.enum(['morning', 'evening']),
  reviewStatus: z.literal('approved'), reviewedBy: z.string().trim().min(2).max(100),
  reviewedAt: z.string().datetime({ offset: true }),
  scope: z.string().trim().min(10).max(1000),
  reviewSource: z.object({ title: z.string().trim().min(2).max(200), locator: z.string().trim().min(4).max(1000) }).strict(),
  steps: z.array(z.object({ productId: idSchema, productVersion: idSchema, usageFactId: idSchema }).strict()).min(1).max(3),
}).strict().refine(plan => new Set(plan.steps.map(step => step.productId)).size === plan.steps.length, 'A product cannot appear twice');
export type CarePlan = z.infer<typeof carePlanSchema>;

export class CarePlans {
  constructor(private store: Store) {}
  list() {
    return (this.store.db.prepare('SELECT document FROM care_plans ORDER BY created_at DESC').all() as { document: string }[])
      .map(row => JSON.parse(row.document) as CarePlan);
  }
  validate(plan: CarePlan) {
    for (const step of plan.steps) {
      const product = this.store.getProduct(step.productId);
      if (product.dataKind !== 'business' || product.version !== step.productVersion) {
        throw new AppError(422, 'CARE_PLAN_PRODUCT_VERSION', '计划只接受当前版本的正式商品；商品版本变化后须重新审核计划。');
      }
      const usage = product.facts.find(fact => fact.factId === step.usageFactId && fact.category === 'usage' && fact.reviewStatus === 'approved');
      if (!usage || !product.sources.some(source => source.sourceId === usage.sourceId)) {
        throw new AppError(422, 'CARE_PLAN_USAGE_NOT_APPROVED', '每步必须指向该版本有来源的已审核用法。');
      }
    }
  }
  import(input: unknown) {
    const plan = carePlanSchema.parse(input); this.validate(plan);
    if (this.list().some(other => other.planId !== plan.planId && other.period === plan.period
      && other.steps.length === plan.steps.length && other.steps.every((step, i) => step.productId === plan.steps[i]?.productId))) {
      throw new AppError(409, 'CARE_PLAN_AMBIGUOUS', '同一时段和商品顺序已有另一份计划；请先通过同一计划ID更新版本。');
    }
    const document = JSON.stringify(plan); const digest = createHash('sha256').update(document).digest('hex');
    const previous = this.store.db.prepare('SELECT version,digest FROM care_plans WHERE id=?').get(plan.planId) as { version: string; digest: string } | undefined;
    if (previous?.version === plan.version) {
      if (previous.digest !== digest) throw new AppError(409, 'CARE_PLAN_VERSION_CONFLICT', '同版本计划不可更改；请使用新版本。');
      return { planId: plan.planId, version: plan.version, status: 'unchanged' };
    }
    this.store.db.prepare(`INSERT INTO care_plans(id,version,document,digest,created_at) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET version=excluded.version,document=excluded.document,digest=excluded.digest,created_at=excluded.created_at`)
      .run(plan.planId, plan.version, document, digest, new Date().toISOString());
    return { planId: plan.planId, version: plan.version, status: 'imported' };
  }
  matching(period: CarePlan['period'], productIds: string[]) {
    return this.list().find(plan => plan.period === period && plan.steps.length === productIds.length
      && plan.steps.every((step, index) => step.productId === productIds[index]
        && this.store.getProduct(step.productId).version === step.productVersion)) ?? null;
  }
}

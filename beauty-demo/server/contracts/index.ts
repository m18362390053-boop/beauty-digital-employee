import { z } from 'zod';

export const idSchema = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);
const text = z.string().trim().min(1).max(10_000);
const shortText = z.string().trim().min(1).max(200);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}, 'Use a real calendar date (YYYY-MM-DD)');
const timestamp = z.string().datetime({ offset: true });
const tags = z.array(shortText).max(30).refine(value => new Set(value).size === value.length, 'Duplicate tags');

function uniqueIds<T>(items: T[], key: (item: T) => string, ctx: z.RefinementCtx, path: string) {
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    const id = key(item);
    if (seen.has(id)) ctx.addIssue({ code: 'custom', path: [path, index], message: `Duplicate ID: ${id}` });
    seen.add(id);
  }
}

const sourceSchema = z.object({
  sourceId: idSchema,
  title: shortText,
  locator: text.describe('Source URL or business-managed file/page reference; never fetched automatically'),
  collectedAt: timestamp,
}).strict();

export const productSchema = z.object({
  productId: idSchema,
  name: shortText,
  version: idSchema,
  dataKind: z.enum(['demo', 'business']),
  recommendation: z.object({
    category: shortText, shade: shortText, texture: shortText,
    keywords: z.array(shortText).min(1).max(20), sourceId: idSchema,
    imageUrl: z.string().url().refine(value => new URL(value).protocol === 'https:', 'Use an HTTPS image URL').optional(),
    price: z.number().nonnegative().optional(),
  }).strict().optional(),
  sources: z.array(sourceSchema).min(1).max(100),
  facts: z.array(z.object({
    factId: idSchema,
    category: z.enum(['description', 'ingredients', 'usage', 'precautions', 'after_sales']),
    text,
    sourceId: idSchema,
    reviewStatus: z.enum(['draft', 'approved']),
  }).strict()).min(1).max(500),
}).strict().superRefine((value, ctx) => {
  uniqueIds(value.sources, item => item.sourceId, ctx, 'sources');
  uniqueIds(value.facts, item => item.factId, ctx, 'facts');
  const sources = new Set(value.sources.map(item => item.sourceId));
  value.facts.forEach((fact, i) => {
    if (!sources.has(fact.sourceId)) ctx.addIssue({ code: 'custom', path: ['facts', i, 'sourceId'], message: 'Unknown sourceId' });
  });
  if (value.recommendation && !value.facts.some(fact => fact.sourceId === value.recommendation!.sourceId && fact.reviewStatus === 'approved')) {
    ctx.addIssue({ code: 'custom', path: ['recommendation', 'sourceId'], message: 'Recommendation requires an approved fact from its declared source' });
  }
});
export type ProductDocument = z.infer<typeof productSchema>;

export const commentBatchSchema = z.object({
  batchId: idSchema,
  productId: idSchema,
  dataKind: z.enum(['demo', 'business']),
  period: z.object({ from: date, to: date, unknownDates: z.literal('separate') }).strict(),
  sources: z.array(sourceSchema).min(1).max(500),
  comments: z.array(z.object({
    commentId: idSchema,
    noteId: idSchema,
    text,
    publishedAt: date.nullable(),
    collectedAt: timestamp,
    sourceRef: idSchema,
    tags,
  }).strict()).min(1).max(5_000),
}).strict().superRefine((value, ctx) => {
  if (value.period.from > value.period.to) ctx.addIssue({ code: 'custom', path: ['period'], message: 'from must not be after to' });
  uniqueIds(value.sources, item => item.sourceId, ctx, 'sources');
  uniqueIds(value.comments, item => item.commentId, ctx, 'comments');
  const sources = new Set(value.sources.map(item => item.sourceId));
  value.comments.forEach((comment, i) => {
    if (!sources.has(comment.sourceRef)) ctx.addIssue({ code: 'custom', path: ['comments', i, 'sourceRef'], message: 'Unknown sourceRef' });
    if (comment.publishedAt && (comment.publishedAt < value.period.from || comment.publishedAt > value.period.to)) {
      ctx.addIssue({ code: 'custom', path: ['comments', i, 'publishedAt'], message: 'Outside declared period' });
    }
  });
});
export type CommentBatch = z.infer<typeof commentBatchSchema>;

export const createUserSchema = z.object({ userId: idSchema.optional(), displayName: shortText }).strict();
const factRecord = z.record(idSchema, z.object({
  value: z.string().trim().min(1).max(1_000),
  sourceMessageId: idSchema.nullable(),
}).strict()).refine(value => Object.keys(value).length <= 30, 'At most 30 confirmed fields');
export const cardPatchShape = {
  expectedVersion: z.number().int().nonnegative(),
  confirmedFacts: factRecord.optional(),
  preferences: z.array(shortText).max(30).optional(),
  concerns: z.array(shortText).max(30).optional(),
};
export const cardPatchSchema = z.object(cardPatchShape).strict().refine(value => value.confirmedFacts !== undefined || value.preferences !== undefined || value.concerns !== undefined,
  'At least one card field is required');
export type CardPatch = z.infer<typeof cardPatchSchema>;
export interface Card {
  userId: string;
  confirmedFacts: z.infer<typeof factRecord>;
  preferences: string[];
  concerns: string[];
  version: number;
  updatedAt: string;
}
export const createSessionSchema = z.object({ productId: idSchema }).strict();
export const userMessageSchema = z.object({ requestId: idSchema, content: text }).strict();
export type UserMessageInput = z.infer<typeof userMessageSchema>;

// Business IDs stay configurable until the team confirms the three skills/four intents.
export const skillDefinitionSchema = z.object({
  id: idSchema,
  version: idSchema,
  description: shortText,
  knowledgeScopes: z.array(z.enum(['product', 'after_sales', 'comment_insights'])).min(1),
  requiredFields: z.array(idSchema),
}).strict();
export type SkillDefinition = z.infer<typeof skillDefinitionSchema>;
export type RiskLevel = 'low' | 'medium' | 'high';
export type SessionStatus = 'AI_ACTIVE' | 'HANDOFF_PENDING' | 'HUMAN_ACTIVE' | 'RESOLVED';
export interface RouteDecision {
  intent: string | null;
  emotion: string | null;
  riskLevel: RiskLevel | null;
  primarySkill: string | null;
  needsHumanHandoff: boolean;
  action: 'answer' | 'clarify' | 'handoff' | 'fallback';
  routeStatus: 'jev' | 'rule_override' | 'degraded';
}

export const insightSchema = z.object({
  insightId: idSchema,
  productId: idSchema,
  datasetVersion: idSchema,
  dataKind: z.enum(['demo', 'business']),
  period: z.object({ from: date, to: date }).strict(),
  sampleSize: z.number().int().nonnegative(),
  method: text,
  tagCounts: z.array(z.object({
    tag: shortText, count: z.number().int().nonnegative(), evidenceCommentIds: z.array(idSchema),
  }).strict()),
  summary: text,
}).strict().superRefine((value, ctx) => {
  if (value.period.from > value.period.to) ctx.addIssue({ code: 'custom', path: ['period'], message: 'Invalid date range' });
  uniqueIds(value.tagCounts, item => item.tag, ctx, 'tagCounts');
  value.tagCounts.forEach((entry, i) => {
    if (entry.count > value.sampleSize || entry.count !== new Set(entry.evidenceCommentIds).size || entry.count !== entry.evidenceCommentIds.length) {
      ctx.addIssue({ code: 'custom', path: ['tagCounts', i], message: 'count must match unique evidence IDs and not exceed sampleSize' });
    }
  });
});

export const evaluationCaseSchema = z.object({
  caseId: idSchema,
  dataKind: z.enum(['demo', 'business']),
  message: text,
  cardContext: z.object({ confirmedFacts: factRecord, preferences: z.array(shortText), concerns: z.array(shortText) }).strict(),
  expected: z.object({
    intent: idSchema.nullable(),
    emotion: idSchema.nullable(),
    primarySkill: idSchema.nullable(),
    riskLevel: z.enum(['low', 'medium', 'high']),
    needsHumanHandoff: z.boolean(),
    action: z.enum(['answer', 'clarify', 'handoff', 'fallback']),
    mustInclude: z.array(text),
    mustNotInclude: z.array(text),
    sourceIds: z.array(idSchema),
  }).strict(),
  notes: text,
}).strict();

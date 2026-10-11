import { z } from 'zod';
import { idSchema, type Card, type ProductDocument, type RouteDecision, skillDefinitionSchema } from '../contracts/index.js';
import { faceRegions } from './face-guides.js';

const probability = z.number().min(0).max(1);
export const skillVersionSchema = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/);
export const businessSkillSchema = skillDefinitionSchema.extend({
  version: skillVersionSchema,
  description: z.string().trim().min(1).max(2_000),
  intents: z.array(idSchema).min(1), instructions: z.string().min(1).max(40_000),
  requiresKnowledge: z.boolean().default(true),
  recommendation: z.object({ maxClarifications: z.number().int().min(0).max(3), category: z.string().trim().min(1).max(100) }).strict().optional(),
  knowledge: z.array(z.object({ title: z.string().min(1).max(200), content: z.string().min(1).max(40_000) }).strict()).max(20).default([]),
});
export const businessConfigSchema = z.object({
  version: idSchema, reviewStatus: z.enum(['demo', 'reviewed']), notice: z.string(),
  intents: z.record(idSchema, z.string().min(1)).refine(v => Object.keys(v).length === 4, 'Exactly four business intents'),
  emotions: z.record(idSchema, z.string().min(1)).refine(v => Object.keys(v).length > 0),
  riskLevels: z.object({ low: z.string(), medium: z.string(), high: z.string() }).strict(),
  thresholds: z.object({ intent: probability, skill: probability, risk: probability, human: probability, information: probability }).strict(),
  skills: z.array(businessSkillSchema).max(30),
  rules: z.array(z.object({
    id: idSchema, riskLevel: z.enum(['low', 'medium', 'high']).nullable(),
    phrases: z.array(z.string().min(1)).min(1), ignorePhrases: z.array(z.string().min(1)), message: z.string().min(1),
  }).strict()),
  templates: z.object({ clarify: z.string(), unavailable: z.string(), noKnowledge: z.string(), risk: z.string(), waiting: z.string() }).strict(),
}).strict().superRefine((v, ctx) => {
  if (new Set(v.skills.map(s => s.id)).size !== v.skills.length) ctx.addIssue({ code: 'custom', path: ['skills'], message: 'Duplicate skill ID' });
  for (const [i, skill] of v.skills.entries()) {
    if (skill.id === 'other') ctx.addIssue({ code: 'custom', path: ['skills', i], message: 'other is reserved for fallback' });
    if (skill.intents.some(id => !Object.hasOwn(v.intents, id))) ctx.addIssue({ code: 'custom', path: ['skills', i, 'intents'], message: 'Unknown intent' });
  }
  if (Object.hasOwn(v.intents, 'other')) ctx.addIssue({ code: 'custom', path: ['intents'], message: 'other is reserved for out-of-scope input' });
  if (new Set(v.rules.map(r => r.id)).size !== v.rules.length) ctx.addIssue({ code: 'custom', path: ['rules'], message: 'Duplicate rule ID' });
});
export type BusinessConfig = z.infer<typeof businessConfigSchema>;
export type BusinessSkill = BusinessConfig['skills'][number];
export interface RouteRecord extends RouteDecision {
  policyVersion: string; policyStatus: 'demo' | 'reviewed';
  reasonCodes: string[]; ruleHits: string[]; model: string | null;
  rawAnswers: unknown; usage: unknown; latencyMs: number;
}
export interface DecisionInput { userText: string; card: Card; recentMessages: { role: string; content: string }[]; selectedProduct?: { id: string; name: string } }
export interface DecisionProvider {
  configured: boolean;
  decide(input: DecisionInput, config: BusinessConfig, signal: AbortSignal): Promise<RouteRecord>;
}
export interface GenerationProvider {
  configured: boolean;
  generate(input: DecisionInput & { skill: BusinessSkill; knowledge: ProductDocument; comments: unknown[];
    productCards?: ConsultResult['productCards']; responseMode?: 'answer' | 'clarify' | 'conversation' }, signal: AbortSignal):
    Promise<{ answer: string; sourceRefs: string[]; model: string; usage: unknown }>;
}
export const consultResultSchema = z.object({
  runId: idSchema, requestId: idSchema, sessionId: idSchema,
  status: z.enum(['answered', 'clarification_required', 'degraded', 'handoff_pending', 'human_active', 'resolved', 'cancelled', 'interrupted']),
  answer: z.string().nullable(), answerKind: z.enum(['generated', 'template', 'none']),
  messageId: idSchema.nullable(), sourceRefs: z.array(z.string()),
  productCards: z.array(z.object({ productId: idSchema, name: z.string(), shade: z.string(), texture: z.string(),
    imageUrl: z.string().optional(), price: z.number().optional(), sourceId: idSchema, dataKind: z.enum(['demo', 'business']) }).strict()).default([]),
  visualGuide: z.object({ region: z.enum(faceRegions), title: z.string(), location: z.string(),
    application: z.string(), caution: z.string() }).strict().nullable().default(null),
  route: z.record(z.unknown()).nullable(), warnings: z.array(z.string()),
  policyStatus: z.enum(['demo', 'reviewed']), dataKind: z.enum(['demo', 'business']),
  handoffId: idSchema.nullable(), generation: z.record(z.unknown()).nullable(),
  diagnostics: z.object({ stage: z.enum(['jev', 'chat']), code: z.string(), networkCode: z.string().nullable(), host: z.string().nullable(), attempts: z.number().int() }).optional(),
});
export type ConsultResult = z.infer<typeof consultResultSchema>;
export const feedbackSchema = z.object({ type: z.enum(['helpful', 'unresolved', 'request_human']), reason: z.string().trim().max(500).default('') }).strict();
export const humanReplySchema = z.object({ requestId: idSchema, content: z.string().trim().min(1).max(10_000) }).strict();

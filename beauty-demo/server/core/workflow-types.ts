import { z } from 'zod';
import { idSchema, type Card, type ProductDocument, type RouteDecision, skillDefinitionSchema } from '../contracts/index.js';

const probability = z.number().min(0).max(1);
export const businessConfigSchema = z.object({
  version: idSchema, reviewStatus: z.enum(['demo', 'reviewed']), notice: z.string(),
  intents: z.record(idSchema, z.string().min(1)).refine(v => Object.keys(v).length === 4, 'Exactly four business intents'),
  emotions: z.record(idSchema, z.string().min(1)).refine(v => Object.keys(v).length > 0),
  riskLevels: z.object({ low: z.string(), medium: z.string(), high: z.string() }).strict(),
  thresholds: z.object({ intent: probability, skill: probability, risk: probability, human: probability, information: probability }).strict(),
  skills: z.array(skillDefinitionSchema.extend({ intents: z.array(idSchema).min(1), instructions: z.string().min(1) })).length(3),
  rules: z.array(z.object({
    id: idSchema, riskLevel: z.enum(['low', 'medium', 'high']).nullable(),
    phrases: z.array(z.string().min(1)).min(1), ignorePhrases: z.array(z.string().min(1)), message: z.string().min(1),
  }).strict()),
  templates: z.object({ clarify: z.string(), unavailable: z.string(), noKnowledge: z.string(), risk: z.string(), waiting: z.string() }).strict(),
}).strict().superRefine((v, ctx) => {
  if (new Set(v.skills.map(s => s.id)).size !== 3) ctx.addIssue({ code: 'custom', path: ['skills'], message: 'Duplicate skill ID' });
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
export interface DecisionInput { userText: string; card: Card; recentMessages: { role: string; content: string }[] }
export interface DecisionProvider {
  configured: boolean;
  decide(input: DecisionInput, config: BusinessConfig, signal: AbortSignal): Promise<RouteRecord>;
}
export interface GenerationProvider {
  configured: boolean;
  generate(input: DecisionInput & { skill: BusinessSkill; knowledge: ProductDocument; comments: unknown[] }, signal: AbortSignal):
    Promise<{ answer: string; sourceRefs: string[]; model: string; usage: unknown }>;
}
export const consultResultSchema = z.object({
  runId: idSchema, requestId: idSchema, sessionId: idSchema,
  status: z.enum(['answered', 'clarification_required', 'degraded', 'handoff_pending', 'human_active', 'resolved', 'cancelled', 'interrupted']),
  answer: z.string().nullable(), answerKind: z.enum(['generated', 'template', 'none']),
  messageId: idSchema.nullable(), sourceRefs: z.array(z.string()),
  route: z.record(z.unknown()).nullable(), warnings: z.array(z.string()),
  policyStatus: z.enum(['demo', 'reviewed']), dataKind: z.enum(['demo', 'business']),
  handoffId: idSchema.nullable(), generation: z.record(z.unknown()).nullable(),
});
export type ConsultResult = z.infer<typeof consultResultSchema>;
export const feedbackSchema = z.object({ type: z.enum(['helpful', 'unresolved', 'request_human']), reason: z.string().trim().max(500).default('') }).strict();
export const humanReplySchema = z.object({ requestId: idSchema, content: z.string().trim().min(1).max(10_000) }).strict();

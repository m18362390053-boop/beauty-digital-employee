import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { businessConfigSchema, type BusinessConfig, type RouteRecord } from './workflow-types.js';

export function loadBusinessConfig(path = process.env.BUSINESS_CONFIG ?? './config/business.demo.json'): BusinessConfig {
  const config = businessConfigSchema.parse(JSON.parse(readFileSync(resolve(path), 'utf8')));
  const productConsult = config.skills.find(skill => skill.id === 'product_consult');
  if (productConsult && !productConsult.knowledge.some(item => item.title === '欧莱雅40岁以上女性护肤知识库（用户整理快照）')) {
    const content = readFileSync(resolve('skill-packages/makeup-color-synesthesia-skill/references/loreal-40plus-skincare-knowledge.md'), 'utf8').trim();
    productConsult.knowledge.push({ title: '欧莱雅40岁以上女性护肤知识库（用户整理快照）', content });
  }
  return businessConfigSchema.parse(config);
}
export function baseRoute(config: BusinessConfig, reason: string): RouteRecord {
  return {
    intent: null, emotion: null, riskLevel: null, primarySkill: null, needsHumanHandoff: false,
    action: 'fallback', routeStatus: 'degraded', policyVersion: config.version, policyStatus: config.reviewStatus,
    reasonCodes: [reason], ruleHits: [], model: null, rawAnswers: null, usage: null, latencyMs: 0,
  };
}

/**
 * Availability-only Jev fallback. It deliberately avoids personalized product routing:
 * routine questions use the broad product-consult skill, while any possible reaction or
 * discomfort is sent to a clarifying response mode. Explicit emergency phrases are handled
 * by ruleRoute before this function is reached.
 */
export function conservativeFallbackRoute(text: string, config: BusinessConfig): RouteRecord {
  const normalized = text.toLowerCase();
  const possibleReaction = /过敏|刺痛|疼痛|红肿|肿胀|发痒|瘙痒|不舒服|刺激|起疹|皮疹|湿疹|脱皮|灼热/.test(normalized);
  const afterSales = /退货|退款|物流|快递|破损|投诉|售后/.test(normalized);
  const emotional = /难过|焦虑|担心|生气|失望|烦恼|不开心/.test(normalized);
  const intent = possibleReaction ? 'safety' : afterSales ? 'after_sales' : emotional ? 'emotional_support'
    : /产品|面霜|乳液|护肤|眼霜|怎么用|用法|涂|抹|成分|价格|适合/.test(normalized) ? 'product_advice' : null;
  const skill = intent ? config.skills.find(item => item.intents.includes(intent)) : undefined;
  const route = {
    ...baseRoute(config, 'JEV_TEMPORARILY_UNAVAILABLE'),
    intent,
    emotion: emotional || possibleReaction ? 'anxious' : 'neutral',
    riskLevel: possibleReaction ? 'medium' as const : 'low' as const,
    primarySkill: skill?.id ?? null,
    action: possibleReaction ? 'clarify' as const : intent ? 'answer' as const : 'fallback' as const,
    reasonCodes: ['CONSERVATIVE_LOCAL_ROUTER', ...(possibleReaction ? ['POSSIBLE_ADVERSE_REACTION'] : [])],
  };
  return route;
}

export function ruleRoute(text: string, config: BusinessConfig): { route: RouteRecord; message: string } | null {
  // Explicit phrase rules are editable fixtures, not a validated clinical classifier.
  const hits = config.rules.filter(rule => {
    let candidate = text;
    for (const phrase of [...rule.ignorePhrases].sort((a, b) => b.length - a.length)) candidate = candidate.replaceAll(phrase, '');
    return rule.phrases.some(phrase => candidate.includes(phrase));
  });
  const rule = hits.find(item => item.riskLevel === 'high') ?? hits[0];
  if (!rule) return null;
  return { message: rule.message, route: {
    ...baseRoute(config, 'EXPLICIT_RULE'), riskLevel: rule.riskLevel, needsHumanHandoff: true,
    action: 'handoff', routeStatus: 'rule_override', ruleHits: hits.map(item => item.id),
  } };
}

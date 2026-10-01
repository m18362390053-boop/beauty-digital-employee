import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { businessConfigSchema, type BusinessConfig, type RouteRecord } from './workflow-types.js';

export function loadBusinessConfig(path = process.env.BUSINESS_CONFIG ?? './config/business.demo.json'): BusinessConfig {
  return businessConfigSchema.parse(JSON.parse(readFileSync(resolve(path), 'utf8')));
}
export function baseRoute(config: BusinessConfig, reason: string): RouteRecord {
  return {
    intent: null, emotion: null, riskLevel: null, primarySkill: null, needsHumanHandoff: false,
    action: 'fallback', routeStatus: 'degraded', policyVersion: config.version, policyStatus: config.reviewStatus,
    reasonCodes: [reason], ruleHits: [], model: null, rawAnswers: null, usage: null, latencyMs: 0,
  };
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

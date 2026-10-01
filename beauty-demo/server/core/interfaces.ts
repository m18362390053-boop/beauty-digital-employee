import type { Card, ProductDocument, RouteDecision, SkillDefinition } from '../contracts/index.js';

export interface Router {
  decide(input: { userText: string; card: Card; skills: SkillDefinition[] }, signal?: AbortSignal): Promise<RouteDecision>;
}

export interface SkillExecutor {
  execute(input: {
    skill: SkillDefinition;
    userText: string;
    card: Card;
    knowledge: ProductDocument;
    route: RouteDecision;
  }, signal?: AbortSignal): Promise<{ answer: string; sourceRefs: string[]; missingFields: string[] }>;
}

// Contracts only in phase 1. No fake router/answer implementation is mounted.

import { resolveActionPolicy, type ExecutionDecision, type RiskLevel } from '../config/policies';

export interface AgentActionCandidate {
  agentName: string;
  actionType: string;
  targetType: string;
  targetId: string;
  riskLevel: RiskLevel;
  reason: string;
  evidence?: string;
  metadata?: Record<string, unknown>;
}

export interface EvaluatedAgentAction extends AgentActionCandidate {
  decision: ExecutionDecision;
  fallbackActionType?: string;
  notes?: string;
}

export function evaluateAgentAction(candidate: AgentActionCandidate): EvaluatedAgentAction {
  const resolution = resolveActionPolicy(candidate.actionType, candidate.riskLevel);

  return {
    ...candidate,
    decision: resolution.decision,
    fallbackActionType: resolution.fallbackActionType,
    notes: resolution.notes,
  };
}

export function serializeMetadata(metadata?: Record<string, unknown>): string | undefined {
  if (!metadata) {
    return undefined;
  }

  return JSON.stringify(metadata);
}

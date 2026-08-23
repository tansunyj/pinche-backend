export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type ExecutionDecision = 'auto_execute' | 'requires_approval' | 'log_only' | 'blocked';

export interface PolicyResolution {
  actionType: string;
  decision: ExecutionDecision;
  fallbackActionType?: string;
  notes?: string;
}

const ACTION_POLICY_MATRIX: Record<string, Record<RiskLevel, PolicyResolution>> = {
  hide_content: {
    low: { actionType: 'hide_content', decision: 'auto_execute' },
    medium: { actionType: 'hide_content', decision: 'auto_execute' },
    high: { actionType: 'hide_content', decision: 'requires_approval' },
    critical: { actionType: 'hide_content', decision: 'requires_approval' },
  },
  delete_content: {
    low: {
      actionType: 'delete_content',
      decision: 'auto_execute',
      fallbackActionType: 'hide_content',
      notes: '低风险删除自动降级为隐藏，避免误删。',
    },
    medium: {
      actionType: 'delete_content',
      decision: 'requires_approval',
      fallbackActionType: 'hide_content',
      notes: '中风险删除进入审批，可先隐藏。',
    },
    high: {
      actionType: 'delete_content',
      decision: 'requires_approval',
      fallbackActionType: 'hide_content',
      notes: '高风险删除必须人工审批。',
    },
    critical: {
      actionType: 'delete_content',
      decision: 'requires_approval',
      fallbackActionType: 'hide_content',
      notes: '关键删除必须人工审批。',
    },
  },
  restrict_user: {
    low: { actionType: 'restrict_user', decision: 'log_only', notes: '低风险仅记录观察。' },
    medium: { actionType: 'restrict_user', decision: 'requires_approval' },
    high: { actionType: 'restrict_user', decision: 'requires_approval' },
    critical: { actionType: 'restrict_user', decision: 'requires_approval' },
  },
  notify_admin: {
    low: { actionType: 'notify_admin', decision: 'auto_execute' },
    medium: { actionType: 'notify_admin', decision: 'auto_execute' },
    high: { actionType: 'notify_admin', decision: 'auto_execute' },
    critical: { actionType: 'notify_admin', decision: 'auto_execute' },
  },
};

export function resolveActionPolicy(actionType: string, riskLevel: RiskLevel): PolicyResolution {
  const actionPolicy = ACTION_POLICY_MATRIX[actionType];
  if (!actionPolicy) {
    return {
      actionType,
      decision: 'requires_approval',
      notes: '未知动作类型默认进入审批，避免越权执行。',
    };
  }

  return actionPolicy[riskLevel];
}

import pool from '../../db/mysql';

interface AgentAuditInput {
  agentName: string;
  actionType: string;
  targetType: string;
  targetId?: string;
  decision: string;
  riskLevel: string;
  reason?: string;
  evidence?: string;
  metadata?: string;
  userId?: string;
}

function generateId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).substr(2, 9)}`;
}

export async function createAgentAuditLog(input: AgentAuditInput) {
  try {
    await pool.execute(
      `INSERT INTO agent_audit_log (
        id, agent_name, action_type, target_type, target_id,
        decision, risk_level, reason, evidence, metadata,
        user_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        generateId(),
        input.agentName,
        input.actionType,
        input.targetType,
        input.targetId || null,
        input.decision,
        input.riskLevel,
        input.reason || null,
        input.evidence || null,
        input.metadata || null,
        input.userId || null,
      ]
    );
    return { success: true };
  } catch (error: any) {
    console.error('[AgentAudit] 写入审计日志失败:', error.message);
    return null;
  }
}

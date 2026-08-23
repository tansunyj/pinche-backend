import pool from '../../db/mysql';

interface ApprovalRequestInput {
  actionType: string;
  targetType: string;
  targetId: string;
  riskLevel: string;
  reason: string;
  evidence?: string;
  payload?: string;
  requestedById?: string;
}

function generateId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).substr(2, 9)}`;
}

export async function enqueueApprovalRequest(input: ApprovalRequestInput) {
  try {
    await pool.execute(
      `INSERT INTO agent_approval (
        id, action_type, target_type, target_id,
        risk_level, reason, evidence, payload,
        requested_by_id, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NOW())`,
      [
        generateId(),
        input.actionType,
        input.targetType,
        input.targetId,
        input.riskLevel,
        input.reason,
        input.evidence || null,
        input.payload || null,
        input.requestedById || null,
      ]
    );
    return { success: true };
  } catch (error: any) {
    console.error('[AgentApproval] 创建审批请求失败:', error.message);
    return null;
  }
}

export async function getPendingApprovalCount() {
  try {
    const [rows] = await pool.execute(
      'SELECT COUNT(*) as count FROM agent_approval WHERE status = ?',
      ['pending']
    );
    return (rows as any[])[0]?.count || 0;
  } catch (error: any) {
    console.error('[AgentApproval] 获取待审批数量失败:', error.message);
    return 0;
  }
}

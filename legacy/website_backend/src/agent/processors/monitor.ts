import pool from '../../db/mysql';
import { enqueueApprovalRequest } from '../core/approval';
import { createAgentAuditLog } from '../core/audit';
import { evaluateAgentAction, serializeMetadata } from '../core/policy-engine';

/**
 * 异常行为监控模块 (Anomaly Detection)
 * 检查是否有用户在极短时间内发布大量水贴、大量刷评论、或者异常消耗系统金币。
 * 防止爬虫或者恶意注册账号刷屏。
 */
export async function monitorAnomalies() {
  console.log(`[SecurityMonitor] 🛡️ 开始分析网站异常流量与羊毛党行为...`);

  const now = new Date();
  const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);

  try {
    // 1. 查找在过去 5 分钟内发帖超过 5 次的用户（可能是在使用脚本刷贴）
    const [spamRows] = await pool.execute(
      `SELECT author_id, COUNT(*) as post_count
       FROM posts
       WHERE created_at >= ?
       GROUP BY author_id
       HAVING COUNT(*) > 5`,
      [fiveMinutesAgo]
    );
    const spamPosts = spamRows as any[];

    if (spamPosts.length > 0) {
      console.warn(`🚨 [SecurityMonitor] 检测到高频发帖用户！疑似脚本灌水：`);
      for (const spammer of spamPosts) {
        const [userRows] = await pool.execute(
          'SELECT id, username, role, balance FROM user_users WHERE id = ?',
          [spammer.author_id]
        );
        const user = (userRows as any[])[0];

        if (!user) {
          continue;
        }

        console.warn(`   - 用户: ${user?.username} (${user?.id}), 5分钟内发帖 ${spammer.post_count} 次`);

        const evaluatedAction = evaluateAgentAction({
          agentName: 'security-monitor',
          actionType: 'restrict_user',
          targetType: 'user',
          targetId: user.id,
          riskLevel: spammer.post_count >= 10 ? 'critical' : 'high',
          reason: `5分钟内发帖 ${spammer.post_count} 次，疑似自动灌水`,
          evidence: JSON.stringify({
            postCountInFiveMinutes: spammer.post_count,
            username: user.username,
            detectedAt: now.toISOString(),
          }),
          metadata: {
            username: user.username,
            currentRole: user.role,
            siliconCoins: user.balance,
          },
        });

        await createAgentAuditLog({
          agentName: evaluatedAction.agentName,
          actionType: evaluatedAction.actionType,
          targetType: evaluatedAction.targetType,
          targetId: evaluatedAction.targetId,
          decision: evaluatedAction.decision,
          riskLevel: evaluatedAction.riskLevel,
          reason: evaluatedAction.reason,
          evidence: evaluatedAction.evidence,
          metadata: serializeMetadata(evaluatedAction.metadata),
          userId: user.id,
        });

        await enqueueApprovalRequest({
          actionType: evaluatedAction.actionType,
          targetType: evaluatedAction.targetType,
          targetId: evaluatedAction.targetId,
          riskLevel: evaluatedAction.riskLevel,
          reason: evaluatedAction.reason,
          evidence: evaluatedAction.evidence,
          payload: serializeMetadata({
            proposedRole: 'restricted',
            proposedCoinBalance: 0,
            notes: '高风险账号限制需人工确认后执行。',
          }),
          requestedById: user.id,
        });

        console.log(`   - 已记录风险并提交审批，不再直接封禁用户 ${user.username}`);
      }
    } else {
      console.log(`[SecurityMonitor] 未检测到发帖异常。`);
    }

    // 2. 检查异常注册（同一时间段内大量新用户注册，可能被 DDoS 注册）
    const [newUserRows] = await pool.execute(
      'SELECT COUNT(*) as count FROM user_users WHERE created_at >= ?',
      [fiveMinutesAgo]
    );
    const newUsers = (newUserRows as any[])[0]?.count || 0;

    if (newUsers > 50) {
       console.error(`💥 [SecurityMonitor] 严重警告：5分钟内有 ${newUsers} 名新用户注册，疑似注册机攻击或撞库！建议临时开启注册验证码。`);
       await createAgentAuditLog({
         agentName: 'security-monitor',
         actionType: 'notify_admin',
         targetType: 'site',
         targetId: 'registration-flow',
         decision: 'auto_execute',
         riskLevel: newUsers > 100 ? 'critical' : 'high',
         reason: `5分钟内新增 ${newUsers} 个账号，注册流量异常`,
         evidence: JSON.stringify({
           newUsers,
           window: '5m',
           detectedAt: now.toISOString(),
         }),
       });
    } else {
      console.log(`[SecurityMonitor] 注册流量正常（5分钟新增 ${newUsers} 人）。`);
    }

    return true;
  } catch (error: any) {
    console.error(`❌ [SecurityMonitor] 异常流量监控执行失败:`, error.message);
    throw error;
  }
}

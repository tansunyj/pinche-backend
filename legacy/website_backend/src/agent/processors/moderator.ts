import pool from '../../db/mysql';
import { processWithLLM } from './llm';
import { enqueueApprovalRequest } from '../core/approval';
import { createAgentAuditLog } from '../core/audit';
import { evaluateAgentAction, serializeMetadata } from '../core/policy-engine';
import type { RiskLevel } from '../config/policies';

/**
 * 网站内容安全审查模块 (Content Moderation)
 * 检查过去 1 小时内新增的帖子、评论、技能和任务是否包含违规、广告、黑客攻击代码等。
 */
export async function moderateContent() {
  console.log(`[Moderator] 🛡️ 正在执行网站安全巡查与 UGC 审核...`);

  // 1. 获取过去 1 小时内创建的内容
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  try {
    const [postRows] = await pool.execute(
      `SELECT p.id, p.content, p.title, u.username as author_username
       FROM posts p
       LEFT JOIN users u ON p.author_id = u.id
       WHERE p.created_at >= ?
       LIMIT 10`,
      [oneHourAgo]
    );
    const recentPosts = postRows as any[];

    const [commentRows] = await pool.execute(
      `SELECT c.id, c.content, u.username as author_username
       FROM comment c
       LEFT JOIN users u ON c.author_id = u.id
       WHERE c.created_at >= ?
       LIMIT 10`,
      [oneHourAgo]
    );
    const recentComments = commentRows as any[];

    // 组合需要审核的内容列表
    const itemsToReview = [
      ...recentPosts.map(p => ({ id: p.id, type: 'post', content: p.content, author: p.author_username || 'unknown' })),
      ...recentComments.map(c => ({ id: c.id, type: 'comment', content: c.content, author: c.author_username || 'unknown' }))
    ];

    if (itemsToReview.length === 0) {
      console.log(`[Moderator] 过去一小时无新内容需要审核。`);
      return 0;
    }

    // 2. 将内容交给 LLM 批量审核
    const prompt = `
你是一个专业的中文社区网站内容安全审查官。
请审核以下提供的用户生成内容 (UGC)。
你的任务是找出其中包含以下特征的内容：
1. 明显的垃圾广告 (Spam / Ads)
2. 政治敏感或色情、暴力内容 (NSFW / Sensitive)
3. 恶意脚本或 XSS 攻击代码 (Malicious Code)
4. 钓鱼链接或诱导诈骗 (Phishing)

输入格式是一组 JSON 数组，每个对象包含 id, type, content, author。
请返回一个 JSON 对象，包含一个 \`violations\` 数组。如果没有任何违规，返回空数组 []。
违规对象格式：
{
  "id": "违规内容的 ID",
  "type": "违规内容的 type",
  "reason": "违规原因简述",
  "severity": "high / medium / low"
}
注意：请务必返回合法的 JSON 格式。
`;

    const contentStr = JSON.stringify(itemsToReview);
    const resultJsonStr = await processWithLLM(prompt, contentStr);
    const result = JSON.parse(resultJsonStr);

    if (!result.violations || !Array.isArray(result.violations)) {
      throw new Error('LLM 未返回正确的 violations 格式');
    }

    let violationsCount = 0;

    for (const violation of result.violations) {
      const riskLevel = normalizeRiskLevel(violation.severity);
      const primaryActionType = riskLevel === 'high' || riskLevel === 'critical'
        ? 'delete_content'
        : 'hide_content';
      const evaluatedAction = evaluateAgentAction({
        agentName: 'moderator',
        actionType: primaryActionType,
        targetType: violation.type,
        targetId: violation.id,
        riskLevel,
        reason: violation.reason,
        evidence: buildEvidence(violation),
        metadata: {
          source: 'llm_moderation',
          severity: violation.severity,
        },
      });

      console.warn(
        `🚨 [Moderator] 发现违规内容！ID: ${violation.id}, 原因: ${violation.reason} (严重程度: ${riskLevel})`
      );

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
      });

      if (evaluatedAction.decision === 'requires_approval') {
        await enqueueApprovalRequest({
          actionType: evaluatedAction.actionType,
          targetType: evaluatedAction.targetType,
          targetId: evaluatedAction.targetId,
          riskLevel: evaluatedAction.riskLevel,
          reason: evaluatedAction.reason,
          evidence: evaluatedAction.evidence,
          payload: serializeMetadata({
            fallbackActionType: evaluatedAction.fallbackActionType,
            notes: evaluatedAction.notes,
          }),
        });

        if (evaluatedAction.fallbackActionType === 'hide_content') {
          await applyContentAction('hide_content', violation.type, violation.id);
          console.log(`   - 已临时隐藏 ${violation.type} ${violation.id}，等待人工审批最终处置`);
        } else {
          console.log(`   - 已创建审批请求，等待人工处理 ${violation.type} ${violation.id}`);
        }
      } else if (evaluatedAction.decision === 'auto_execute') {
        await applyContentAction(evaluatedAction.actionType, violation.type, violation.id);
        console.log(`   - 已自动执行 ${evaluatedAction.actionType} -> ${violation.type} ${violation.id}`);
      } else {
        console.log(`   - 仅记录观察，不自动处理 ${violation.type} ${violation.id}`);
      }

      violationsCount++;
    }

    console.log(`[Moderator] 审核完毕，共扫描 ${itemsToReview.length} 条内容，发现 ${violationsCount} 条违规并已处理。`);
    return violationsCount;

  } catch (err: any) {
    console.error(`❌ [Moderator] 审核任务执行异常:`, err.message);
    throw err;
  }
}

function normalizeRiskLevel(value?: string): RiskLevel {
  if (value === 'critical' || value === 'high' || value === 'medium' || value === 'low') {
    return value;
  }

  return 'medium';
}

function buildEvidence(violation: { reason?: string; severity?: string }) {
  return JSON.stringify({
    reason: violation.reason,
    severity: violation.severity,
    detectedAt: new Date().toISOString(),
  });
}

async function applyContentAction(actionType: string, targetType: string, targetId: string) {
  if (targetType === 'post') {
    if (actionType === 'delete_content') {
      await pool.execute('DELETE FROM posts WHERE id = ?', [targetId]).catch(() => undefined);
      return;
    }

    await pool.execute(
      'UPDATE post SET content = ?, updated_at = NOW() WHERE id = ?',
      ['[该内容因违反社区规定已被系统隐藏]', targetId]
    ).catch(() => undefined);
    return;
  }

  if (targetType === 'comment') {
    if (actionType === 'delete_content') {
      await pool.execute('DELETE FROM comment WHERE id = ?', [targetId]).catch(() => undefined);
      return;
    }

    await pool.execute(
      'UPDATE comment SET content = ?, updated_at = NOW() WHERE id = ?',
      ['[该评论因违反社区规定已被系统隐藏]', targetId]
    ).catch(() => undefined);
  }
}

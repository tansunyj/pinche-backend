/**
 * 定时任务服务 - SchedulerService
 *
 * 负责调度以下定时任务：
 * - 月度结算：每月1日 00:05 执行
 */

import SettlementService from "./SettlementService";

class SchedulerService {
  private settlementTimer: NodeJS.Timeout | null = null;
  private isRunning = false;

  /**
   * 启动所有定时任务
   */
  start(): void {
    if (this.isRunning) {
      console.log("[Scheduler] 定时任务已在运行");
      return;
    }

    console.log("[Scheduler] 启动定时任务...");
    this.isRunning = true;

    // 启动月度结算定时器
    this.scheduleMonthlySettlement();

    console.log("[Scheduler] 定时任务启动完成");
  }

  /**
   * 停止所有定时任务
   */
  stop(): void {
    if (this.settlementTimer) {
      clearTimeout(this.settlementTimer);
      this.settlementTimer = null;
    }
    this.isRunning = false;
    console.log("[Scheduler] 定时任务已停止");
  }

  /**
   * 调度月度结算任务
   * 每月1日 00:05 执行
   * 注意：setTimeout 最大支持约 24.8 天，需要分段处理
   */
  private scheduleMonthlySettlement(): void {
    const now = new Date();
    const nextRun = this.getNextSettlementTime();
    const delay = nextRun.getTime() - now.getTime();

    // setTimeout 最大安全值：2^31-1 = 2147483647 毫秒（约 24.8 天）
    const MAX_SAFE_DELAY = 2147483647;

    if (delay > MAX_SAFE_DELAY) {
      // 延迟超过最大值，先等待 24 小时后再重新调度
      console.log(
        `[Scheduler] 距离下次结算还有 ${Math.floor(delay / 1000 / 60 / 60)} 小时，超过最大定时器限制，24小时后重新检查`
      );

      this.settlementTimer = setTimeout(() => {
        this.scheduleMonthlySettlement(); // 重新检查
      }, 24 * 60 * 60 * 1000); // 24 小时后再次检查
      return;
    }

    console.log(
      `[Scheduler] 月度结算下次执行时间: ${nextRun.toISOString()}, 还有 ${Math.floor(
        delay / 1000 / 60
      )} 分钟`
    );

    this.settlementTimer = setTimeout(async () => {
      try {
        console.log("[Scheduler] 开始执行月度结算...");
        await SettlementService.monthlySettlement();
        console.log("[Scheduler] 月度结算执行完成");
      } catch (err) {
        console.error("[Scheduler] 月度结算执行失败:", err);
      } finally {
        // 重新调度下一次
        this.scheduleMonthlySettlement();
      }
    }, delay);
  }

  /**
   * 获取下次结算时间（每月1日 00:05）
   */
  private getNextSettlementTime(): Date {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    const day = now.getDate();

    // 如果今天已经是1日且已经过了 00:05，则调度到下月1日
    if (day === 1) {
      const settlementTime = new Date(year, month, 1, 0, 5, 0);
      if (now.getTime() < settlementTime.getTime()) {
        return settlementTime; // 今天的 00:05 还没过
      }
    }

    // 调度到下月1日 00:05
    return new Date(year, month + 1, 1, 0, 5, 0);
  }

  /**
   * 立即执行月度结算（管理员手动触发）
   */
  async triggerSettlementNow(month?: string): Promise<{
    success: boolean;
    message: string;
  }> {
    try {
      const result = await SettlementService.monthlySettlement(month);
      return {
        success: true,
        message: result.message,
      };
    } catch (err: any) {
      return {
        success: false,
        message: err.message || "结算失败",
      };
    }
  }
}

export default new SchedulerService();

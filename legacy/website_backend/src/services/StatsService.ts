/**
 * 用户行为统计服务
 * 在业务行为发生时实时写入 Redis 统计数据
 * 供 admin_backend 同步到 unified_stats 使用
 */
import redis from "../utils/redis";

const KEY_TTL = 30 * 24 * 3600; // 30天过期

function getTodayDate(): string {
  return new Date().toISOString().split("T")[0];
}

class StatsService {
  /**
   * 记录新用户注册
   */
  async recordNewUser(userId: number): Promise<void> {
    const date = getTodayDate();
    const key = `stats:user:global:${date}`;

    try {
      await redis.hincrby(key, "new_users", 1);
      await redis.expire(key, KEY_TTL);
      console.log(`[Stats] 新用户注册统计: user=${userId}, date=${date}`);
    } catch (err) {
      console.error("[Stats] 记录新用户注册失败:", err);
    }
  }

  /**
   * 记录用户登录（用于DAU统计）
   */
  async recordUserLogin(userId: number): Promise<void> {
    const date = getTodayDate();

    try {
      // 使用 HyperLogLog 统计 DAU
      await redis.pfadd(`stats:user:active:${date}`, `u:${userId}`);
      await redis.expire(`stats:user:active:${date}`, KEY_TTL);

      // 同时记录登录次数（可选）
      const key = `stats:user:global:${date}`;
      await redis.hincrby(key, "logins", 1);
      await redis.expire(key, KEY_TTL);
    } catch (err) {
      console.error("[Stats] 记录用户登录失败:", err);
    }
  }

  /**
   * 记录Token创建
   */
  async recordTokenCreated(tokenId: number, userId: number): Promise<void> {
    const date = getTodayDate();
    const key = `stats:user:global:${date}`;

    try {
      await redis.hincrby(key, "tokens_created", 1);
      await redis.expire(key, KEY_TTL);

      // 同时更新用户的token统计
      const userKey = `stats:user:${userId}:${date}`;
      await redis.hincrby(userKey, "tokens", 1);
      await redis.expire(userKey, KEY_TTL);
    } catch (err) {
      console.error("[Stats] 记录Token创建失败:", err);
    }
  }

  /**
   * 记录充值订单创建
   */
  async recordRechargeOrder(
    userId: number,
    amountYuan: number,
    points: number
  ): Promise<void> {
    const date = getTodayDate();
    const key = `stats:billing:${date}`;

    try {
      await redis.hincrby(key, "orders_count", 1);
      await redis.expire(key, KEY_TTL);
      console.log(`[Stats] 充值订单统计: user=${userId}, amount=¥${amountYuan}`);
    } catch (err) {
      console.error("[Stats] 记录充值订单失败:", err);
    }
  }

  /**
   * 记录充值成功
   */
  async recordRechargeSuccess(
    userId: number,
    amountYuan: number,
    points: number
  ): Promise<void> {
    const date = getTodayDate();
    const key = `stats:billing:${date}`;

    try {
      const pipeline = redis.pipeline();
      pipeline.hincrby(key, "orders_success", 1);
      pipeline.hincrby(key, "amount_total", Math.round(amountYuan * 100)); // 转为分
      pipeline.hincrby(key, "points_total", points);
      pipeline.expire(key, KEY_TTL);

      // 记录充值用户数（使用 HyperLogLog）
      pipeline.pfadd(`stats:billing:users:${date}`, `u:${userId}`);
      pipeline.expire(`stats:billing:users:${date}`, KEY_TTL);

      // 记录余额充值（从流水角度）
      const userGlobalKey = `stats:user:global:${date}`;
      pipeline.hincrby(userGlobalKey, "balance_recharged", points);
      pipeline.expire(userGlobalKey, KEY_TTL);

      await pipeline.exec();
      console.log(
        `[Stats] 充值成功统计: user=${userId}, amount=¥${amountYuan}, points=${points}`
      );
    } catch (err) {
      console.error("[Stats] 记录充值成功失败:", err);
    }
  }

  /**
   * 记录充值失败
   */
  async recordRechargeFailed(userId: number): Promise<void> {
    const date = getTodayDate();
    const key = `stats:billing:${date}`;

    try {
      await redis.hincrby(key, "orders_failed", 1);
      await redis.expire(key, KEY_TTL);
    } catch (err) {
      console.error("[Stats] 记录充值失败失败:", err);
    }
  }

  /**
   * 记录余额消费
   */
  async recordBalanceConsumed(userId: number, points: number): Promise<void> {
    const date = getTodayDate();
    const key = `stats:user:global:${date}`;

    try {
      await redis.hincrby(key, "balance_consumed", points);
      await redis.expire(key, KEY_TTL);

      // 同时记录用户消费统计
      const userKey = `stats:user:${userId}:${date}`;
      await redis.hincrby(userKey, "quota", points);
      await redis.expire(userKey, KEY_TTL);
    } catch (err) {
      console.error("[Stats] 记录余额消费失败:", err);
    }
  }

  /**
   * 记录用户有API请求（用于统计有请求的用户数）
   */
  async recordUserRequest(userId: number, quota: number = 0): Promise<void> {
    const date = getTodayDate();

    try {
      const pipeline = redis.pipeline();

      // 使用 HyperLogLog 统计有请求的用户数
      pipeline.pfadd(`stats:user:requesters:${date}`, `u:${userId}`);
      pipeline.expire(`stats:user:requesters:${date}`, KEY_TTL);

      // 更新用户请求统计
      const userKey = `stats:user:${userId}:${date}`;
      pipeline.hincrby(userKey, "requests", 1);
      if (quota > 0) {
        pipeline.hincrby(userKey, "quota", quota);
      }
      pipeline.expire(userKey, KEY_TTL);

      await pipeline.exec();
    } catch (err) {
      console.error("[Stats] 记录用户请求失败:", err);
    }
  }

  /**
   * 记录Token活跃（有请求）
   */
  async recordTokenActive(tokenId: number): Promise<void> {
    const date = getTodayDate();

    try {
      await redis.pfadd(`stats:tokens:active:${date}`, `tk:${tokenId}`);
      await redis.expire(`stats:tokens:active:${date}`, KEY_TTL);
    } catch (err) {
      console.error("[Stats] 记录Token活跃失败:", err);
    }
  }

  // ============ 企业用户看板查询方法（读取 api-relay 写入的数据） ============

  /**
   * 获取用户实时QPS（最近3秒平均）
   */
  async getUserRealtimeQps(userId: number): Promise<number> {
    const currentSecond = Math.floor(Date.now() / 1000);
    const keys: string[] = [];
    for (let i = 0; i < 3; i++) {
      keys.push(`stats:user:${userId}:qps:${currentSecond - i}`);
    }

    const values = await redis.mget(...keys);
    const total = values.reduce((sum, v) => sum + (parseInt(v as string) || 0), 0);
    return Math.round(total / 3);
  }

  /**
   * 获取用户今日全局统计（看板核心指标）
   */
  async getUserDailyOverview(userId: number, date: string): Promise<{
    requests: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    quotaConsumed: number;
    successCount: number;
    errorCount: number;
    errorRate: number;
    latencyAvgMs: number;
    latencyMinMs: number;
    latencyMaxMs: number;
    uniqueTokens: number;
    uniqueModels: number;
  }> {
    const key = `stats:user:${userId}:${date}:global`;
    const stats = await redis.hgetall(key);

    if (!stats || !stats.requests) {
      return {
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        quotaConsumed: 0,
        successCount: 0,
        errorCount: 0,
        errorRate: 0,
        latencyAvgMs: 0,
        latencyMinMs: 0,
        latencyMaxMs: 0,
        uniqueTokens: 0,
        uniqueModels: 0,
      };
    }

    const latencyCount = parseInt(stats.latency_count) || 1;
    const latencySum = parseInt(stats.latency_sum) || 0;
    const requests = parseInt(stats.requests) || 0;
    const errorCount = parseInt(stats.error_count) || 0;

    return {
      requests,
      promptTokens: parseInt(stats.prompt_tokens) || 0,
      completionTokens: parseInt(stats.completion_tokens) || 0,
      totalTokens: parseInt(stats.total_tokens) || 0,
      quotaConsumed: parseInt(stats.quota_consumed) || 0,
      successCount: parseInt(stats.success_count) || 0,
      errorCount,
      errorRate: requests > 0 ? (errorCount / requests) * 100 : 0,
      latencyAvgMs: latencyCount ? Math.round(latencySum / latencyCount) : 0,
      latencyMinMs: parseInt(stats.latency_min) || 0,
      latencyMaxMs: parseInt(stats.latency_max) || 0,
      uniqueTokens: await redis.pfcount(`stats:user:${userId}:${date}:tokens`),
      uniqueModels: await redis.pfcount(`stats:user:${userId}:${date}:models`),
    };
  }

  /**
   * 获取用户请求分类统计（文字聊天、生图、生视频）
   */
  async getUserRequestBreakdown(userId: number, date: string): Promise<{
    chat: number;
    image: number;
    video: number;
  }> {
    const chatKey = `stats:user:${userId}:${date}:requests:chat`;
    const imageKey = `stats:user:${userId}:${date}:requests:image`;
    const videoKey = `stats:user:${userId}:${date}:requests:video`;

    const [chat, image, video] = await Promise.all([
      redis.get(chatKey).then((v) => parseInt(v as string) || 0),
      redis.get(imageKey).then((v) => parseInt(v as string) || 0),
      redis.get(videoKey).then((v) => parseInt(v as string) || 0),
    ]);

    return { chat, image, video };
  }

  /**
   * 获取用户过去24小时趋势（30分钟粒度，从当前时间往前推24小时）
   * 返回48个数据点（24小时 × 2个30分钟）
   */
  async getUserLast24hTrend(
    userId: number
  ): Promise<
    Array<{
      hour: string;
      datetime: string;
      requests: number;
      totalTokens: number;
      quotaConsumed: number;
      errorCount: number;
    }>
  > {
    const results: Array<{
      hour: string;
      datetime: string;
      requests: number;
      totalTokens: number;
      quotaConsumed: number;
      errorCount: number;
    }> = [];

    const now = new Date();

    // 获取过去24小时的30分钟粒度数据（48个点）
    for (let i = 47; i >= 0; i--) {
      const d = new Date(now);
      // 往前推 i 个30分钟
      d.setMinutes(d.getMinutes() - i * 30);

      const dateStr = d.toISOString().split("T")[0];
      const hour = d.getHours();
      const minute = d.getMinutes();
      // 30分钟索引: hour * 2 + (minute < 30 ? 0 : 1)
      const halfHourIndex = hour * 2 + (minute < 30 ? 0 : 1);

      const key = `stats:user:${userId}:${dateStr}:halfhour:${halfHourIndex}`;
      const stats = await redis.hgetall(key);

      // 格式化时间标签
      const timeLabel = `${hour.toString().padStart(2, "0")}:${minute < 30 ? "00" : "30"}`;
      const datetimeLabel = `${dateStr} ${timeLabel}`;

      results.push({
        hour: timeLabel,
        datetime: datetimeLabel,
        requests: parseInt(stats.requests) || 0,
        totalTokens: parseInt(stats.total_tokens) || 0,
        quotaConsumed: parseInt(stats.quota_consumed) || 0,
        errorCount: parseInt(stats.error_count) || 0,
      });
    }

    return results;
  }

  /**
   * 获取用户指定日期的小时趋势（24 个整点）。
   * 把半小时粒度数据（stats:user:{userId}:{date}:halfhour:{idx}）按小时聚合，
   * 兼容旧的 GET /api/dashboard 聚合接口（trend_24h / trend_tokens_24h）。
   */
  async getUserHourlyTrend(
    userId: number,
    date: string
  ): Promise<Array<{ hour: string; requests: number; totalTokens: number }>> {
    const results: Array<{ hour: string; requests: number; totalTokens: number }> = [];

    for (let h = 0; h < 24; h++) {
      // 30分钟索引: hour * 2 + (minute < 30 ? 0 : 1)
      const key0 = `stats:user:${userId}:${date}:halfhour:${h * 2}`;
      const key1 = `stats:user:${userId}:${date}:halfhour:${h * 2 + 1}`;
      const [s0, s1] = await Promise.all([redis.hgetall(key0), redis.hgetall(key1)]);

      results.push({
        hour: `${h.toString().padStart(2, "0")}:00`,
        requests: (parseInt(s0.requests) || 0) + (parseInt(s1.requests) || 0),
        totalTokens: (parseInt(s0.total_tokens) || 0) + (parseInt(s1.total_tokens) || 0),
      });
    }

    return results;
  }

  /**
   * 获取用户模型使用分布（用于模型占比图）
   */
  async getUserModelDistribution(
    userId: number,
    date: string,
    limit: number = 10
  ): Promise<Array<{ name: string; value: number; tokens: number; requests: number }>> {
    // 从Sorted Set获取排行
    const ranking = await redis.zrevrange(
      `stats:user:${userId}:${date}:rank:model`,
      0,
      limit - 1,
      "WITHSCORES"
    );

    const results: Array<{ name: string; value: number; tokens: number; requests: number }> = [];
    let totalTokens = 0;

    // 先收集所有模型数据
    for (let i = 0; i < ranking.length; i += 2) {
      const model = ranking[i];
      const tokens = parseInt(ranking[i + 1]) || 0;
      totalTokens += tokens;

      const modelKey = `stats:user:${userId}:${date}:model:${model}`;
      const stats = await redis.hgetall(modelKey);

      results.push({
        name: model,
        value: 0, // 后面计算百分比
        tokens,
        requests: parseInt(stats.requests) || 0,
      });
    }

    // 如果没有数据，返回空数组
    if (results.length === 0) {
      return [];
    }

    // 转换为百分比
    return results.map((r) => ({
      ...r,
      value: totalTokens > 0 ? Math.round((r.tokens / totalTokens) * 100 * 10) / 10 : 0,
    }));
  }

  // ============ 原有查询方法（供 Dashboard 使用） ============

  async getUserStats(date: string): Promise<{
    newUsers: number;
    activeUsers: number;
    logins: number;
    tokensCreated: number;
    balanceConsumed: number;
    balanceRecharged: number;
    usersWithRequests: number;
  }> {
    const key = `stats:user:global:${date}`;
    const stats = await redis.hgetall(key);

    return {
      newUsers: parseInt(stats.new_users) || 0,
      activeUsers: await redis.pfcount(`stats:user:active:${date}`),
      logins: parseInt(stats.logins) || 0,
      tokensCreated: parseInt(stats.tokens_created) || 0,
      balanceConsumed: parseInt(stats.balance_consumed) || 0,
      balanceRecharged: parseInt(stats.balance_recharged) || 0,
      usersWithRequests: await redis.pfcount(`stats:user:requesters:${date}`),
    };
  }

  async getBillingStats(date: string): Promise<{
    ordersCount: number;
    ordersSuccess: number;
    ordersFailed: number;
    amountTotal: number;
    pointsTotal: number;
    usersRecharged: number;
  }> {
    const key = `stats:billing:${date}`;
    const stats = await redis.hgetall(key);

    return {
      ordersCount: parseInt(stats.orders_count) || 0,
      ordersSuccess: parseInt(stats.orders_success) || 0,
      ordersFailed: parseInt(stats.orders_failed) || 0,
      amountTotal: parseInt(stats.amount_total) || 0,
      pointsTotal: parseInt(stats.points_total) || 0,
      usersRecharged: await redis.pfcount(`stats:billing:users:${date}`),
    };
  }
}

export default new StatsService();

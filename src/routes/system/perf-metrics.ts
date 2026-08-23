/**
 * 性能指标空 stub（挂载 /api/perf-metrics）
 *
 * 供前端 features/performance-metrics 消费（模型广场详情抽屉 Overview 的 TPS/延迟/成功率）。
 * 拼车后端暂无性能采集，返回空数据结构；组件对空 groups/models 有容错，显示「暂无数据」而非报错。
 */

import { Router, Request, Response } from "express";

const router = Router();

// GET /api/perf-metrics?model=&hours=
router.get("/", (req: Request, res: Response) => {
  res.json({
    success: true,
    message: "ok",
    data: {
      model_name: typeof req.query.model === "string" ? req.query.model : "",
      groups: [],
    },
  });
});

// GET /api/perf-metrics/summary?hours=
router.get("/summary", (_req: Request, res: Response) => {
  res.json({
    success: true,
    message: "ok",
    data: { models: [] },
  });
});

export default router;

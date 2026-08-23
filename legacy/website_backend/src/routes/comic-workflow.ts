import { Router, Request, Response } from "express";
import crypto from "crypto";

const router = Router();

type WorkflowMode = "fine" | "batch" | "happy-horse";

type WorkflowJob = {
  id: string;
  mode: WorkflowMode;
  title: string;
  status: string;
  eta: string;
  preset: string;
  shotCount: number;
  episodeCount: number;
  stageId: string;
  submittedAt: string;
  script: string;
  tuning: Record<string, number>;
};

const seedJobs: WorkflowJob[] = [
  {
    id: "cw_fine_seed_1",
    mode: "fine",
    title: "精细工作流 / 天台相遇分镜",
    status: "待审核",
    eta: "人工确认",
    preset: "电影感分镜",
    shotCount: 12,
    episodeCount: 1,
    stageId: "storyboard",
    submittedAt: new Date().toISOString(),
    script: "默认种子任务",
    tuning: { consistency: 92, detail: 88, cinematic: 76 },
  },
  {
    id: "cw_batch_seed_1",
    mode: "batch",
    title: "批量工作流 / 连载渠道包",
    status: "批量渲染中",
    eta: "9 分 20 秒",
    preset: "条漫连载",
    shotCount: 24,
    episodeCount: 6,
    stageId: "render",
    submittedAt: new Date().toISOString(),
    script: "默认种子任务",
    tuning: { throughput: 8, retryDepth: 2, qcThreshold: 84 },
  },
  {
    id: "cw_hh_seed_1",
    mode: "happy-horse",
    title: "Happy Horse / 雨夜便利店动态漫",
    status: "处理中",
    eta: "1 分 30 秒",
    preset: "Happy Horse 恋爱",
    shotCount: 10,
    episodeCount: 1,
    stageId: "motion",
    submittedAt: new Date().toISOString(),
    script: "默认种子任务",
    tuning: { styleLock: 95, motionCurve: 62, lipSync: 86, emotionDrive: 78 },
  },
];

const jobs: WorkflowJob[] = [...seedJobs];

function isWorkflowMode(value: string): value is WorkflowMode {
  return value === "fine" || value === "batch" || value === "happy-horse";
}

function getStatusByMode(mode: WorkflowMode): { status: string; eta: string } {
  if (mode === "fine") return { status: "待分镜", eta: "约 2 分钟" };
  if (mode === "batch") return { status: "已进入队列", eta: "约 6 分钟" };
  return { status: "模型处理中", eta: "约 90 秒" };
}

router.get("/jobs", (req: Request, res: Response) => {
  const mode = String(req.query.mode || "");
  if (!isWorkflowMode(mode)) {
    res.status(400).json({ error: "无效的工作流模式" });
    return;
  }

  const modeJobs = jobs
    .filter((job) => job.mode === mode)
    .sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1))
    .slice(0, 10)
    .map(({ script, tuning, ...job }) => job);

  res.json({ jobs: modeJobs });
});

router.post("/jobs", (req: Request, res: Response) => {
  const { mode, preset, script, shotCount, episodeCount, stageId, tuning } = req.body as {
    mode?: string;
    preset?: string;
    script?: string;
    shotCount?: number;
    episodeCount?: number;
    stageId?: string;
    tuning?: Record<string, number>;
  };

  if (!mode || !isWorkflowMode(mode)) {
    res.status(400).json({ error: "请选择有效的工作流模式" });
    return;
  }

  if (!preset || !script || !stageId) {
    res.status(400).json({ error: "预设、脚本和流程阶段不能为空" });
    return;
  }

  const { status, eta } = getStatusByMode(mode);
  const titlePrefix =
    mode === "fine" ? "精细工作流" : mode === "batch" ? "批量工作流" : "Happy Horse";

  const job: WorkflowJob = {
    id: `cw_${crypto.randomBytes(6).toString("hex")}`,
    mode,
    title: `${titlePrefix} / ${preset}`,
    status,
    eta,
    preset,
    shotCount: Number(shotCount || 0),
    episodeCount: Number(episodeCount || 0),
    stageId,
    submittedAt: new Date().toISOString(),
    script: script.slice(0, 1000),
    tuning: tuning || {},
  };

  jobs.unshift(job);

  res.status(201).json({
    message: `已提交 ${titlePrefix} 任务，当前阶段：${stageId}`,
    job: {
      id: job.id,
      mode: job.mode,
      title: job.title,
      status: job.status,
      eta: job.eta,
      submittedAt: job.submittedAt,
    },
  });
});

export default router;

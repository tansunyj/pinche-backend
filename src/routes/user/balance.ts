/**
 * 余额查询（挂载 /api/user/balance）
 * 直连网关库 users.balance；口径：1元 = 100000 额度
 */

import { Router, Request, Response } from "express";
import UserService from "../../services/user";
import { userAuth } from "../../middlewares/userAuth";

const router = Router();
router.use(userAuth);

router.get("/", async (req: Request, res: Response) => {
  try {
    const user = await UserService.findById(req.user!.userId);
    if (!user) {
      res.status(404).json({ error: "用户不存在" });
      return;
    }
    const balance = Number(user.balance) || 0;
    res.json({
      balance,
      // 计费口径：1 元 = 100000 额度
      unit: "额度",
      rate: 100000,
      balanceYuan: balance / 100000,
      cumulativeRecharge: (Number(user.cumulative_recharge) || 0) / 100000,
    });
  } catch (err) {
    console.error("Get balance error:", err);
    res.status(500).json({ error: "获取余额失败" });
  }
});

export default router;

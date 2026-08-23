/**
 * 用户资料/余额（挂载 /api/user/profile）
 */

import { Router, Request, Response } from "express";
import UserService, { getPublicUser } from "../../services/user";
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
    res.json(getPublicUser(user));
  } catch (err) {
    console.error("Get profile error:", err);
    res.status(500).json({ error: "获取用户信息失败" });
  }
});

export default router;

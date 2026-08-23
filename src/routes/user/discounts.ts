/**
 * 我的折扣（挂载 /api/user/discounts）
 * 车次已不再读写 user_model_discounts（该表也未并入 carpool 库），统一返回空
 */

import { Router, Request, Response } from "express";
import { userAuth } from "../../middlewares/userAuth";

const router = Router();
router.use(userAuth);

router.get("/", async (_req: Request, res: Response) => {
  res.json({ discounts: [] });
});

export default router;

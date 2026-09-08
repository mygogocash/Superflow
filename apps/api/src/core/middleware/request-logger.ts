import type { NextFunction, Request, Response } from "express";

import { logger, scrubLog } from "@/common/utils/logger";

export function requestLogger(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  logger.info(scrubLog(`${req.method} ${req.path}`));
  next();
}

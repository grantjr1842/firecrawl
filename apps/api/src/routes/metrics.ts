import express, { NextFunction, Request, Response } from "express";
import { config } from "../config";
import {
  metricsController,
  nuqMetricsController,
} from "../controllers/v0/admin/metrics";
import { wrap } from "./shared";

export const metricsRouter = express.Router();

// admin-ops-07: /metrics is mounted outside of /admin and gated on its own
// shared secret (METRICS_AUTH_KEY). When the env var is unset, the endpoint
// returns 404 so self-hosted operators do not accidentally expose the prom
// text to the network. The legacy /admin/:BULL_AUTH_KEY/metrics path is
// preserved for back-compat — see routes/admin.ts.
const metricsAuthMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (!config.METRICS_AUTH_KEY) {
    return res.status(404).json({ success: false, error: "Not Found" });
  }

  const headerToken =
    (req.headers["x-metrics-key"] as string | undefined) ??
    (req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice("Bearer ".length)
      : undefined);

  if (headerToken !== config.METRICS_AUTH_KEY) {
    return res
      .status(401)
      .set("WWW-Authenticate", 'Bearer realm="firecrawl-metrics"')
      .send("Unauthorized");
  }

  return next();
};

metricsRouter.get("/metrics", metricsAuthMiddleware, wrap(metricsController));
metricsRouter.get(
  "/metrics/nuq",
  metricsAuthMiddleware,
  wrap(nuqMetricsController),
);

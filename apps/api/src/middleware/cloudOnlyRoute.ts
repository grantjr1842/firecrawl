import { NextFunction, Request, Response } from "express";
import { isSelfHosted } from "../lib/deployment";

const SELF_HOST_DOCS_URL = "https://docs.firecrawl.dev/contributing/self-host";

/**
 * Middleware that returns HTTP 501 Not Implemented for cloud-only routes
 * when running in self-hosted mode.
 *
 * Self-host detection uses `config.USE_DB_AUTHENTICATION !== true` (see
 * `isSelfHosted()`). Routes wired with this middleware will short-circuit
 * with a stable 501 + JSON envelope so SDKs and operators can rely on the
 * behavior instead of a 500/404 from an unconfigured controller.
 */
export function cloudOnlyRoute(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (isSelfHosted()) {
    res.status(501).json({
      error: "NotImplemented",
      code: "cloud_only",
      message:
        "This endpoint requires Firecrawl Cloud. See " +
        SELF_HOST_DOCS_URL +
        " for the self-host feature matrix.",
      docs: SELF_HOST_DOCS_URL,
    });
    return;
  }
  next();
}

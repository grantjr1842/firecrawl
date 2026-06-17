import * as winston from "winston";

import { config } from "../config";
import { configDotenv } from "dotenv";
configDotenv();

const DEV_TRACE_BODY_MAX_BYTES = 4 * 1024; // 4KB cap on body preview

const logFormat = winston.format.printf(
  info =>
    `${info.timestamp} ${info.level} [${info.metadata.module ?? ""}:${info.metadata.method ?? ""}]: ${info.message} ${
      info.level.includes("error") || info.level.includes("warn")
        ? JSON.stringify(info.metadata, (_, value) => {
            if (value instanceof Error) {
              return {
                ...value,
                name: value.name,
                message: value.message,
                stack: value.stack,
                cause: value.cause,
              };
            } else {
              return value;
            }
          })
        : ""
    }`,
);

// Filter function to prevent logging when zeroDataRetention is true
const zeroDataRetentionFilter = winston.format(info => {
  if (
    info.metadata?.zeroDataRetention === true ||
    info.zeroDataRetention === true
  ) {
    return false; // Don't log this message
  }
  return info;
})();

export const logger = winston.createLogger({
  level: config.LOGGING_LEVEL?.toLowerCase() ?? "debug",
  format: winston.format.json({
    replacer(key, value) {
      if (value instanceof Error) {
        return {
          ...value,
          name: value.name,
          message: value.message,
          stack: value.stack,
          cause: value.cause,
        };
      } else {
        return value;
      }
    },
  }),
  transports: [
    ...(config.FIRECRAWL_LOG_TO_FILE
      ? [
          new winston.transports.File({
            filename:
              "firecrawl-" +
              (process.argv[1].includes("worker") ? "worker" : "app") +
              ".log",
            format: winston.format.combine(
              zeroDataRetentionFilter,
              winston.format.json(),
            ),
            maxsize: 10 * 1024 * 1024,
            maxFiles: 3,
            tailable: true,
          }),
        ]
      : []),
    new winston.transports.Console({
      format: winston.format.combine(
        zeroDataRetentionFilter,
        winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
        winston.format.metadata({
          fillExcept: ["message", "level", "timestamp"],
        }),
        ...(config.FIRECRAWL_LOG_FORMAT === "text"
          ? [winston.format.colorize(), logFormat]
          : [winston.format.json()]),
      ),
    }),
  ],
});

/**
 * Cheap, structured lifecycle logger for scrape/crawl events.
 *
 * Routes through the shared winston `logger.info` so log formatters,
 * transports, and the OBS-07 JSON output apply uniformly. Designed
 * to be safe on the hot path: when FIRECRAWL_DEV_TRACE is disabled
 * (or the env is production), the function returns early before any
 * object construction. The function name is intentionally short so
 * call sites read like `devTrace("scrape.received", { jobId })`.
 *
 * - `event`: short dotted event name, e.g. "scrape.received",
 *   "scrape.cache.lookup", "crawl.complete".
 * - `fields`: arbitrary structured fields; do NOT include large
 *   payloads. When FIRECRAWL_DEV_TRACE_BODY is set, a "body" field
 *   is truncated to the first 4KB to keep volume bounded.
 */
export function devTrace(
  event: string,
  fields: Record<string, unknown> = {},
): void {
  if (!isDevTraceEnabled()) {
    return;
  }

  const payload: Record<string, unknown> = {
    event,
    ts: new Date().toISOString(),
    ...fields,
  };

  if (config.FIRECRAWL_DEV_TRACE_BODY && "body" in payload) {
    payload.body = truncateBody(payload.body);
  }

  logger.info("devTrace", payload);
}

function isDevTraceEnabled(): boolean {
  if (config.FIRECRAWL_DEV_TRACE === undefined) {
    return config.ENV !== "production";
  }
  return config.FIRECRAWL_DEV_TRACE;
}

function truncateBody(body: unknown): unknown {
  if (typeof body === "string") {
    return body.length > DEV_TRACE_BODY_MAX_BYTES
      ? body.slice(0, DEV_TRACE_BODY_MAX_BYTES) + "...[truncated]"
      : body;
  }
  try {
    const serialized = JSON.stringify(body);
    if (serialized === undefined) {
      return body;
    }
    return serialized.length > DEV_TRACE_BODY_MAX_BYTES
      ? serialized.slice(0, DEV_TRACE_BODY_MAX_BYTES) + "...[truncated]"
      : body;
  } catch {
    return "[unserializable]";
  }
}

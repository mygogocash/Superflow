import winston from "winston";

/**
 * Strip CR/LF (and Unicode line separators) from a value before it is
 * interpolated into a log *message* string. Prevents log forging / log
 * injection (CodeQL js/log-injection) where attacker-controlled input
 * (request paths, ids, names) could inject fake log lines. Prefer passing
 * user data as winston metadata; use this when it must live in the message.
 */
export function scrubLog(value: unknown): string {
  return String(value).replace(/[\r\n\u2028\u2029]+/g, " ");
}

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  ),
  defaultMeta: { service: "nexora-api" },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple(),
      ),
    }),
  ],
});

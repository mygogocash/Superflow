import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { ZodError } from "zod";

import { HttpException } from "@/common/exceptions/http-exception";
import { logger, scrubLog } from "@/common/utils/logger";
import { trackFormValidationFailed } from "@/lib/events";

/** Prisma throws this class name; avoid importing @prisma/client in the API layer. */
function isPrismaClientKnownRequestError(
  err: Error,
): err is Error & { code: string; meta?: Record<string, unknown> } {
  return err.constructor.name === "PrismaClientKnownRequestError";
}

function mapPrismaKnownRequestError(err: Error & { code: string }) {
  switch (err.code) {
    case "P2002":
      return {
        status: 409 as const,
        code: "CONFLICT",
        message: "A record with this value already exists",
      };
    case "P2003":
      return {
        status: 400 as const,
        code: "INVALID_REFERENCE",
        message:
          "Related data is missing or invalid (for example a foreign key does not match an existing record)",
      };
    case "P2025":
      return {
        status: 404 as const,
        code: "NOT_FOUND",
        message: "Record not found",
      };
    default:
      return {
        status: 500 as const,
        code: "INTERNAL_ERROR",
        message: "Internal server error",
      };
  }
}

function zodIssuesForLog(err: ZodError) {
  return err.issues.map((issue) => ({
    path: issue.path.length ? issue.path.join(".") : "(root)",
    message: issue.message,
    code: issue.code,
  }));
}

function zodIssuesToDetails(err: ZodError) {
  return err.issues.map((issue) => ({
    field: issue.path.length ? issue.path.join(".") : undefined,
    message: issue.message,
  }));
}

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof ZodError) {
    logger.warn(scrubLog(`${req.method} ${req.path}`), {
      code: "VALIDATION_ERROR",
      issues: zodIssuesForLog(err),
    });
    if (req.user) {
      trackFormValidationFailed(
        { id: req.user.id, entityId: req.user.entityId },
        {
          form: req.path.replace(/^\/api\//, "").split("/")[0] ?? "unknown",
          field_count: err.issues.length,
        },
      );
    }
    return res.status(422).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Validation failed",
        details: zodIssuesToDetails(err),
      },
    });
  }

  if (err instanceof multer.MulterError) {
    logger.warn(scrubLog(`${req.method} ${req.path}`), {
      code: err.code,
      message: err.message,
    });
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        error: {
          code: "BAD_REQUEST",
          message: "File exceeds maximum upload size",
        },
      });
    }
    return res.status(400).json({
      error: {
        code: "BAD_REQUEST",
        message: err.message || "Upload failed",
      },
    });
  }

  if (err instanceof HttpException) {
    const logPayload = { code: err.code, message: err.message };
    if (err.status >= 500) {
      logger.error(scrubLog(`${req.method} ${req.path}`), logPayload);
    } else {
      logger.warn(scrubLog(`${req.method} ${req.path}`), logPayload);
    }
    return res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
      },
    });
  }

  if (
    err.constructor.name === "PrismaClientInitializationError" ||
    err.name === "PrismaClientInitializationError"
  ) {
    logger.error(scrubLog(`${req.method} ${req.path}`), {
      code: "PRISMA_INIT",
      message: err.message,
    });
    return res.status(503).json({
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "Database is unavailable",
      },
    });
  }

  if (isPrismaClientKnownRequestError(err)) {
    const mapped = mapPrismaKnownRequestError(err);
    const logFn = mapped.status >= 500 ? logger.error : logger.warn;
    logFn(scrubLog(`${req.method} ${req.path}`), {
      prismaCode: err.code,
      message: err.message,
    });
    return res.status(mapped.status).json({
      error: {
        code: mapped.code,
        message: mapped.message,
      },
    });
  }

  logger.error(scrubLog(`${req.method} ${req.path}`), {
    error: err.message,
    stack: err.stack,
  });

  return res.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: "Internal server error",
    },
  });
}

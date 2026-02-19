import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";
import { auditLog } from "../services/audit-log";

declare global {
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Generate or use existing request ID
  const requestId = (req.headers["x-request-id"] as string) || randomUUID();
  req.requestId = requestId;
  
  // Set response header for tracing
  res.setHeader("X-Request-Id", requestId);
  
  // Set audit context
  auditLog.setContext({
    requestId,
    ipAddress: req.ip || req.socket.remoteAddress,
    userAgent: req.headers["user-agent"],
  });

  // Clear context on response finish
  res.on("finish", () => {
    auditLog.clearContext();
  });

  next();
}

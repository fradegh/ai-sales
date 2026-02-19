import type { Request, Response, NextFunction } from "express";
import { auditLog } from "../services/audit-log";

declare global {
  namespace Express {
    interface Request {
      tenantId?: string;
      userId?: string;
    }
  }
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimits: Map<string, RateLimitEntry> = new Map();
const tenantLimits: Map<string, RateLimitEntry> = new Map();

export type RateLimitCategory = 
  | "public" 
  | "webhook" 
  | "ai" 
  | "onboarding" 
  | "conversation" 
  | "default";

interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
  keyGenerator?: (req: Request) => string;
  category?: RateLimitCategory;
  enableAudit?: boolean;
}

interface TenantRateLimitConfig {
  maxConversationsPerMin: number;
  maxAiCallsPerMin: number;
}

const DEFAULT_TENANT_LIMITS: TenantRateLimitConfig = {
  maxConversationsPerMin: 50,
  maxAiCallsPerMin: 30,
};

const tenantConfigs: Map<string, TenantRateLimitConfig> = new Map();

export function setTenantRateLimits(tenantId: string, config: Partial<TenantRateLimitConfig>): void {
  const existing = tenantConfigs.get(tenantId) || { ...DEFAULT_TENANT_LIMITS };
  tenantConfigs.set(tenantId, { ...existing, ...config });
}

export function getTenantRateLimits(tenantId: string): TenantRateLimitConfig {
  return tenantConfigs.get(tenantId) || { ...DEFAULT_TENANT_LIMITS };
}

const isDev = process.env.NODE_ENV !== "production";

const RATE_LIMIT_DEFAULTS: Record<RateLimitCategory, Omit<RateLimitOptions, 'keyGenerator'>> = {
  public: { windowMs: 60_000, maxRequests: isDev ? 500 : 100 },
  webhook: { windowMs: 60_000, maxRequests: 500 },
  ai: { windowMs: 60_000, maxRequests: isDev ? 100 : 20 },
  onboarding: { windowMs: 60_000, maxRequests: isDev ? 100 : 30 },
  conversation: { windowMs: 60_000, maxRequests: isDev ? 300 : 100 },
  default: { windowMs: 60_000, maxRequests: isDev ? 500 : 100 },
};

const defaultOptions: RateLimitOptions = {
  windowMs: 60_000,
  maxRequests: 100,
  category: "default",
  enableAudit: true,
};

export function createRateLimiter(options: Partial<RateLimitOptions> = {}) {
  const category = options.category || "default";
  const categoryDefaults = RATE_LIMIT_DEFAULTS[category];
  const opts: RateLimitOptions = { 
    ...defaultOptions, 
    ...categoryDefaults,
    ...options,
    category,
  };

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const baseKey = opts.keyGenerator?.(req) || req.ip || "unknown";
    const key = `${category}:${baseKey}`;
    const now = Date.now();
    
    let entry = rateLimits.get(key);
    
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + opts.windowMs };
      rateLimits.set(key, entry);
    }
    
    entry.count++;
    
    const remaining = Math.max(0, opts.maxRequests - entry.count);
    const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000);
    
    res.setHeader("X-RateLimit-Limit", opts.maxRequests);
    res.setHeader("X-RateLimit-Remaining", remaining);
    res.setHeader("X-RateLimit-Reset", Math.ceil(entry.resetAt / 1000));
    res.setHeader("X-RateLimit-Category", category);
    
    if (entry.count > opts.maxRequests) {
      res.setHeader("Retry-After", retryAfterSec);
      
      if (opts.enableAudit) {
        const clientIp = req.ip || req.socket?.remoteAddress || "unknown";
        await auditLog.log(
          "rate_limit_exceeded",
          "rate_limit",
          category,
          "system",
          "system",
          {
            category,
            clientIp,
            path: req.path,
            method: req.method,
            limit: opts.maxRequests,
            count: entry.count,
            retryAfter: retryAfterSec,
          }
        );
      }
      
      res.status(429).json({
        error: "Too many requests",
        retryAfter: retryAfterSec,
        category,
      });
      return;
    }
    
    next();
  };
}

export function createTenantRateLimiter(
  limitType: "conversation" | "ai"
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const tenantId = req.tenantId;
    if (!tenantId) {
      next();
      return;
    }
    
    const config = getTenantRateLimits(tenantId);
    const maxRequests = limitType === "conversation" 
      ? config.maxConversationsPerMin 
      : config.maxAiCallsPerMin;
    
    const key = `tenant:${tenantId}:${limitType}`;
    const now = Date.now();
    const windowMs = 60_000;
    
    let entry = tenantLimits.get(key);
    
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      tenantLimits.set(key, entry);
    }
    
    entry.count++;
    
    const remaining = Math.max(0, maxRequests - entry.count);
    const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000);
    
    res.setHeader("X-Tenant-RateLimit-Limit", maxRequests);
    res.setHeader("X-Tenant-RateLimit-Remaining", remaining);
    res.setHeader("X-Tenant-RateLimit-Reset", Math.ceil(entry.resetAt / 1000));
    
    if (entry.count > maxRequests) {
      res.setHeader("Retry-After", retryAfterSec);
      
      const clientIp = req.ip || req.socket?.remoteAddress || "unknown";
      await auditLog.log(
        "rate_limit_exceeded",
        "tenant_rate_limit",
        tenantId,
        req.userId || "system",
        req.userId ? "user" : "system",
        {
          tenantId,
          limitType,
          clientIp,
          path: req.path,
          method: req.method,
          limit: maxRequests,
          count: entry.count,
          retryAfter: retryAfterSec,
        }
      );
      
      res.status(429).json({
        error: "Tenant rate limit exceeded",
        limitType,
        retryAfter: retryAfterSec,
      });
      return;
    }
    
    next();
  };
}

export const apiRateLimiter = createRateLimiter({
  category: "public",
});

export const aiRateLimiter = createRateLimiter({
  category: "ai",
});

export const webhookRateLimiter = createRateLimiter({
  category: "webhook",
});

export const onboardingRateLimiter = createRateLimiter({
  category: "onboarding",
});

export const conversationRateLimiter = createRateLimiter({
  category: "conversation",
});

export const tenantConversationLimiter = createTenantRateLimiter("conversation");
export const tenantAiLimiter = createTenantRateLimiter("ai");

export function clearRateLimits(): void {
  rateLimits.clear();
  tenantLimits.clear();
}

export function getRateLimitStats(): { global: number; tenant: number } {
  return {
    global: rateLimits.size,
    tenant: tenantLimits.size,
  };
}

setInterval(() => {
  const now = Date.now();
  const globalEntries = Array.from(rateLimits.entries());
  for (const [key, entry] of globalEntries) {
    if (now >= entry.resetAt) {
      rateLimits.delete(key);
    }
  }
  const tenantEntries = Array.from(tenantLimits.entries());
  for (const [key, entry] of tenantEntries) {
    if (now >= entry.resetAt) {
      tenantLimits.delete(key);
    }
  }
}, 60_000);

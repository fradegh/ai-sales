import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { requestContextMiddleware } from "./middleware/request-context";
import { apiRateLimiter } from "./middleware/rate-limiter";
import { registerHealthRoutes } from "./routes/health";
import { validateConfig, checkRequiredServices } from "./config";
import { WhatsAppPersonalAdapter } from "./services/whatsapp-personal-adapter";
import { realtimeService } from "./services/websocket-server";
import { storage } from "./storage";
import { telegramClientManager } from "./services/telegram-client-manager";
import * as fs from "fs";
import { spawn, ChildProcess } from "child_process";
import { bootstrapPlatformOwner } from "./services/owner-bootstrap";

let maxPersonalProcess: ChildProcess | null = null;

// Validate configuration on startup
const config = validateConfig();
const serviceCheck = checkRequiredServices();
if (serviceCheck.warnings.length > 0) {
  console.warn("Configuration warnings:");
  serviceCheck.warnings.forEach((w) => console.warn(`  - ${w}`));
}

const app = express();
// Trust proxy for rate limiting behind reverse proxy
app.set('trust proxy', 1);
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

// Phase 0: Request context middleware (adds requestId, sets audit context)
app.use(requestContextMiddleware);

// Phase 0: Rate limiting for API endpoints
app.use("/api", apiRateLimiter);

// Phase 0: Health check routes (before auth/other middleware)
registerHealthRoutes(app);

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  realtimeService.initialize(httpServer);

  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    async () => {
      log(`serving on port ${port}`);
      
      // Bootstrap platform owner (idempotent)
      try {
        const ownerResult = await bootstrapPlatformOwner();
        if (ownerResult.action !== "skipped") {
          log(`Platform owner ${ownerResult.action}: ${ownerResult.userId}`, "startup");
        }
      } catch (err: any) {
        log(`Platform owner bootstrap failed: ${err.message}`, "startup");
      }
      
      // Ensure default tenant exists in database
      const tenant = await storage.ensureDefaultTenant();
      log(`Default tenant ready: ${tenant.id}`, "startup");
      
      // Auto-restore WhatsApp Personal sessions on startup
      // Pass the real tenant UUID to map file system "default" folder to database UUID
      await restoreWhatsAppSessions(tenant.id);
      
      // Auto-restore Telegram Personal sessions on startup
      try {
        await telegramClientManager.initialize();
        log("Telegram Personal sessions initialized", "startup");
      } catch (err: any) {
        log(`Telegram Personal initialization failed: ${err.message}`, "startup");
      }
      
      // Auto-start Max Personal Python service
      startMaxPersonalService();
    },
  );
})();

// Restore saved WhatsApp Personal sessions on server start
// Maps file system folder "default" to the actual database tenant UUID
async function restoreWhatsAppSessions(realTenantId: string) {
  const sessionsDir = "./whatsapp_sessions";
  
  if (!fs.existsSync(sessionsDir)) {
    return;
  }
  
  try {
    // Migrate "default" folder to real tenant UUID if needed
    const defaultPath = `${sessionsDir}/default`;
    const realPath = `${sessionsDir}/${realTenantId}`;
    
    if (fs.existsSync(defaultPath) && !fs.existsSync(realPath)) {
      log(`Migrating WhatsApp session from 'default' to '${realTenantId}'`, "whatsapp");
      fs.renameSync(defaultPath, realPath);
    }
    
    const tenantDirs = fs.readdirSync(sessionsDir);
    
    for (const tenantId of tenantDirs) {
      const tenantPath = `${sessionsDir}/${tenantId}`;
      if (fs.statSync(tenantPath).isDirectory()) {
        log(`Restoring WhatsApp session for tenant: ${tenantId}`, "whatsapp");
        
        try {
          const result = await WhatsAppPersonalAdapter.restoreSession(tenantId);
          if (result.connected) {
            log(`WhatsApp session restored for ${tenantId}: ${result.user?.phone || 'connected'}`, "whatsapp");
          } else if (result.error?.includes("Session expired")) {
            log(`WhatsApp session expired for ${tenantId}, needs re-auth`, "whatsapp");
          } else {
            log(`WhatsApp session restore failed for ${tenantId}: ${result.error}`, "whatsapp");
          }
        } catch (err: any) {
          log(`Failed to restore WhatsApp session for ${tenantId}: ${err.message}`, "whatsapp");
        }
      }
    }
  } catch (err: any) {
    log(`Error scanning WhatsApp sessions: ${err.message}`, "whatsapp");
  }
}

// Auto-start Max Personal Python microservice
function startMaxPersonalService() {
  const scriptPath = "./max_personal_service.py";
  
  if (!fs.existsSync(scriptPath)) {
    log("Max Personal service script not found, skipping auto-start", "max-personal");
    return;
  }
  
  // Check if already running
  if (maxPersonalProcess && !maxPersonalProcess.killed) {
    log("Max Personal service already running", "max-personal");
    return;
  }
  
  try {
    log("Starting Max Personal Python service...", "max-personal");
    
    maxPersonalProcess = spawn("python3", [scriptPath], {
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NODE_BACKEND_URL: `http://localhost:${process.env.PORT || 5000}`,
      },
    });
    
    maxPersonalProcess.stdout?.on("data", (data: Buffer) => {
      const lines = data.toString().trim().split("\n");
      lines.forEach(line => {
        if (line.includes("Uvicorn running")) {
          log("Max Personal service started on port 8100", "max-personal");
        }
      });
    });
    
    maxPersonalProcess.stderr?.on("data", (data: Buffer) => {
      const msg = data.toString().trim();
      if (!msg.includes("INFO:")) {
        console.error("[MaxPersonal]", msg);
      }
    });
    
    maxPersonalProcess.on("error", (err) => {
      log(`Max Personal service error: ${err.message}`, "max-personal");
    });
    
    maxPersonalProcess.on("exit", (code, signal) => {
      log(`Max Personal service exited (code: ${code}, signal: ${signal})`, "max-personal");
      maxPersonalProcess = null;
    });
    
  } catch (err: any) {
    log(`Failed to start Max Personal service: ${err.message}`, "max-personal");
  }
}

// Graceful shutdown
process.on("SIGTERM", () => {
  if (maxPersonalProcess && !maxPersonalProcess.killed) {
    maxPersonalProcess.kill();
  }
});

process.on("SIGINT", () => {
  if (maxPersonalProcess && !maxPersonalProcess.killed) {
    maxPersonalProcess.kill();
  }
});

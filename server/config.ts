import { z } from "zod";

// Environment configuration schema
const envSchema = z.object({
  // Required
  NODE_ENV: z.enum(["development", "staging", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(5000),
  
  // OpenAI
  AI_INTEGRATIONS_OPENAI_API_KEY: z.string().optional(),
  AI_INTEGRATIONS_OPENAI_BASE_URL: z.string().optional(),
  
  // Session
  SESSION_SECRET: z.string().min(32).optional(),
  
  // Database (optional for MVP)
  DATABASE_URL: z.string().optional(),
  
  // Rate limiting
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().default(100),
  RATE_LIMIT_AI_MAX_REQUESTS: z.coerce.number().default(20),
  
  // Logging
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  
  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
  
  // WhatsApp
  WHATSAPP_API_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_ID: z.string().optional(),
  
  // Sentry
  SENTRY_DSN: z.string().optional(),
});

export type EnvConfig = z.infer<typeof envSchema>;

let config: EnvConfig | null = null;

export function validateConfig(): EnvConfig {
  if (config) return config;
  
  const result = envSchema.safeParse(process.env);
  
  if (!result.success) {
    console.error("Configuration validation failed:");
    for (const error of result.error.errors) {
      console.error(`  - ${error.path.join(".")}: ${error.message}`);
    }
    
    // In development, allow startup with warnings
    if (process.env.NODE_ENV === "development") {
      console.warn("Starting in development mode with default configuration...");
      config = envSchema.parse({});
      return config;
    }
    
    throw new Error("Invalid configuration");
  }
  
  config = result.data;
  return config;
}

export function getConfig(): EnvConfig {
  if (!config) {
    return validateConfig();
  }
  return config;
}

// Validate required services
export function checkRequiredServices(): { valid: boolean; warnings: string[] } {
  const warnings: string[] = [];
  const cfg = getConfig();
  
  if (!cfg.AI_INTEGRATIONS_OPENAI_API_KEY && !process.env.OPENAI_API_KEY) {
    warnings.push("OpenAI API key not configured - AI features will not work");
  }
  
  if (!cfg.SESSION_SECRET && cfg.NODE_ENV !== "development") {
    warnings.push("SESSION_SECRET not set - using insecure default");
  }
  
  return {
    valid: warnings.length === 0,
    warnings,
  };
}

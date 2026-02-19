import type { FeatureFlag, InsertFeatureFlag, FeatureFlagName, FEATURE_FLAG_NAMES } from "@shared/schema";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";

const FLAGS_FILE = "./feature_flags.json";

// Default feature flag configurations
const DEFAULT_FLAGS: Record<FeatureFlagName, { description: string; enabled: boolean }> = {
  AI_SUGGESTIONS_ENABLED: {
    description: "Enable AI-powered response suggestions",
    enabled: true,
  },
  DECISION_ENGINE_ENABLED: {
    description: "Enable advanced decision engine for auto-responses",
    enabled: false,
  },
  AI_AUTOSEND_ENABLED: {
    description: "Enable automatic sending of AI responses without approval",
    enabled: false,
  },
  HUMAN_DELAY_ENABLED: {
    description: "Enable human-like delay before sending responses",
    enabled: false,
  },
  RAG_ENABLED: {
    description: "Enable RAG (Retrieval-Augmented Generation) for context",
    enabled: true,
  },
  FEW_SHOT_LEARNING: {
    description: "Enable few-shot learning with examples from approved responses",
    enabled: true,
  },
  TELEGRAM_CHANNEL_ENABLED: {
    description: "Enable Telegram messenger channel",
    enabled: false,
  },
  WHATSAPP_CHANNEL_ENABLED: {
    description: "Enable WhatsApp messenger channel",
    enabled: false,
  },
  MAX_CHANNEL_ENABLED: {
    description: "Enable Max (VK Teams) messenger channel",
    enabled: false,
  },
  TELEGRAM_PERSONAL_CHANNEL_ENABLED: {
    description: "Enable Telegram Personal (MTProto) channel",
    enabled: false,
  },
  WHATSAPP_PERSONAL_CHANNEL_ENABLED: {
    description: "Enable WhatsApp Personal (Baileys) channel",
    enabled: false,
  },
};

class FeatureFlagService {
  private flags: Map<string, FeatureFlag> = new Map();
  private initialized = false;

  constructor() {
    this.initializeDefaultFlags();
    this.loadFromFile();
  }

  private initializeDefaultFlags(): void {
    if (this.initialized) return;

    for (const [name, config] of Object.entries(DEFAULT_FLAGS)) {
      const flag: FeatureFlag = {
        id: randomUUID(),
        name,
        description: config.description,
        enabled: config.enabled,
        tenantId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      this.flags.set(this.getKey(name, null), flag);
    }
    this.initialized = true;
  }

  private loadFromFile(): void {
    try {
      if (fs.existsSync(FLAGS_FILE)) {
        const data = fs.readFileSync(FLAGS_FILE, "utf-8");
        const savedFlags = JSON.parse(data) as Record<string, { enabled: boolean }>;
        
        for (const [key, value] of Object.entries(savedFlags)) {
          const existing = this.flags.get(key);
          if (existing) {
            existing.enabled = value.enabled;
            existing.updatedAt = new Date();
          }
        }
        console.log("[FeatureFlags] Loaded saved flags from file");
      }
    } catch (err) {
      console.error("[FeatureFlags] Failed to load flags from file:", err);
    }
  }

  private saveToFile(): void {
    try {
      const toSave: Record<string, { enabled: boolean }> = {};
      this.flags.forEach((flag, key) => {
        toSave[key] = { enabled: flag.enabled };
      });
      fs.writeFileSync(FLAGS_FILE, JSON.stringify(toSave, null, 2));
    } catch (err) {
      console.error("[FeatureFlags] Failed to save flags to file:", err);
    }
  }

  private getKey(name: string, tenantId: string | null): string {
    return tenantId ? `${tenantId}:${name}` : `global:${name}`;
  }

  async isEnabled(name: FeatureFlagName, tenantId?: string): Promise<boolean> {
    return this.isEnabledSync(name, tenantId);
  }

  isEnabledSync(name: string, tenantId?: string): boolean {
    // First check tenant-specific flag
    if (tenantId) {
      const tenantFlag = this.flags.get(this.getKey(name, tenantId));
      if (tenantFlag) {
        return tenantFlag.enabled;
      }
    }
    
    // Fall back to global flag
    const globalFlag = this.flags.get(this.getKey(name, null));
    return globalFlag?.enabled ?? false;
  }

  async getFlag(name: string, tenantId?: string | null): Promise<FeatureFlag | undefined> {
    if (tenantId) {
      const tenantFlag = this.flags.get(this.getKey(name, tenantId));
      if (tenantFlag) return tenantFlag;
    }
    return this.flags.get(this.getKey(name, null));
  }

  async getAllFlags(tenantId?: string): Promise<FeatureFlag[]> {
    const result: FeatureFlag[] = [];
    const seenNames = new Set<string>();
    const allFlags = Array.from(this.flags.values());

    // Get tenant-specific flags first
    if (tenantId) {
      for (const flag of allFlags) {
        if (flag.tenantId === tenantId) {
          result.push(flag);
          seenNames.add(flag.name);
        }
      }
    }

    // Add global flags that aren't overridden
    for (const flag of allFlags) {
      if (flag.tenantId === null && !seenNames.has(flag.name)) {
        result.push(flag);
      }
    }

    return result;
  }

  async setFlag(name: string, enabled: boolean, tenantId?: string | null): Promise<FeatureFlag> {
    const key = this.getKey(name, tenantId ?? null);
    const existing = this.flags.get(key);

    if (existing) {
      const updated = { ...existing, enabled, updatedAt: new Date() };
      this.flags.set(key, updated);
      this.saveToFile();
      return updated;
    }

    // Create new tenant-specific flag
    const flag: FeatureFlag = {
      id: randomUUID(),
      name,
      description: DEFAULT_FLAGS[name as FeatureFlagName]?.description || null,
      enabled,
      tenantId: tenantId ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.flags.set(key, flag);
    this.saveToFile();
    return flag;
  }

  async createFlag(data: InsertFeatureFlag): Promise<FeatureFlag> {
    const flag: FeatureFlag = {
      id: randomUUID(),
      name: data.name,
      description: data.description ?? null,
      enabled: data.enabled ?? false,
      tenantId: data.tenantId ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.flags.set(this.getKey(flag.name, flag.tenantId), flag);
    return flag;
  }

  async deleteFlag(id: string): Promise<boolean> {
    const entries = Array.from(this.flags.entries());
    for (const [key, flag] of entries) {
      if (flag.id === id) {
        this.flags.delete(key);
        return true;
      }
    }
    return false;
  }
}

// Singleton instance
export const featureFlagService = new FeatureFlagService();

// Convenience function for dynamic imports
export function isFeatureEnabled(name: string, tenantId?: string): boolean {
  return featureFlagService.isEnabledSync(name, tenantId);
}

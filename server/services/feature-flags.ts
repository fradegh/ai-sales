import type { FeatureFlag, InsertFeatureFlag, FeatureFlagName } from "@shared/schema";
import { featureFlags } from "@shared/schema";
import { db } from "../db";
import { sql } from "drizzle-orm";
import { randomUUID } from "crypto";

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
  AUTO_PARTS_ENABLED: {
    description: "Enable auto parts dealer functionality (VIN lookup, gearbox ID, price search, Agent tab, price templates)",
    enabled: false,
  },
};

class FeatureFlagService {
  /** In-memory write-through cache: key = getKey(name, tenantId) */
  private flags: Map<string, FeatureFlag> = new Map();

  constructor() {
    this.seedDefaults();
  }

  // ---------------------------------------------------------------------------
  // Startup
  // ---------------------------------------------------------------------------

  /** Seed hard-coded defaults into the in-memory map (synchronous). */
  private seedDefaults(): void {
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
  }

  /**
   * Load persisted flags from the DB and merge them into the in-memory cache,
   * overwriting defaults with stored values.  Should be awaited at server
   * startup before requests are served.
   */
  async initFromDb(): Promise<void> {
    try {
      const rows = await db.select().from(featureFlags);
      for (const row of rows) {
        this.flags.set(this.getKey(row.name, row.tenantId), {
          ...row,
          createdAt: new Date(row.createdAt),
          updatedAt: new Date(row.updatedAt),
        });
      }
      console.log(`[FeatureFlags] Loaded ${rows.length} flag(s) from DB`);
    } catch (err) {
      console.error("[FeatureFlags] DB load failed — using in-memory defaults:", err);
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private getKey(name: string, tenantId: string | null): string {
    return tenantId ? `${tenantId}:${name}` : `global:${name}`;
  }

  /**
   * Upsert a flag row to the DB.
   * Uses two separate partial unique indexes (migration 0013) to handle the
   * nullable tenantId: global rows conflict on (name) WHERE tenant_id IS NULL,
   * per-tenant rows conflict on (name, tenant_id) WHERE tenant_id IS NOT NULL.
   */
  private async persistToDb(flag: FeatureFlag): Promise<void> {
    try {
      if (flag.tenantId === null) {
        await db.execute(sql`
          INSERT INTO feature_flags (id, name, description, enabled, tenant_id, created_at, updated_at)
          VALUES (${flag.id}, ${flag.name}, ${flag.description}, ${flag.enabled}, NULL, NOW(), NOW())
          ON CONFLICT (name) WHERE tenant_id IS NULL
          DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()
        `);
      } else {
        await db.execute(sql`
          INSERT INTO feature_flags (id, name, description, enabled, tenant_id, created_at, updated_at)
          VALUES (${flag.id}, ${flag.name}, ${flag.description}, ${flag.enabled}, ${flag.tenantId}, NOW(), NOW())
          ON CONFLICT (name, tenant_id) WHERE tenant_id IS NOT NULL
          DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()
        `);
      }
    } catch (err) {
      console.error("[FeatureFlags] DB persist failed:", err);
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async isEnabled(name: FeatureFlagName, tenantId?: string): Promise<boolean> {
    return this.isEnabledSync(name, tenantId);
  }

  isEnabledSync(name: string, tenantId?: string): boolean {
    if (tenantId) {
      const tenantFlag = this.flags.get(this.getKey(name, tenantId));
      if (tenantFlag) return tenantFlag.enabled;
    }
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

    if (tenantId) {
      for (const flag of this.flags.values()) {
        if (flag.tenantId === tenantId) {
          result.push(flag);
          seenNames.add(flag.name);
        }
      }
    }

    for (const flag of this.flags.values()) {
      if (flag.tenantId === null && !seenNames.has(flag.name)) {
        result.push(flag);
      }
    }

    return result;
  }

  async setFlag(name: string, enabled: boolean, tenantId?: string | null): Promise<FeatureFlag> {
    const key = this.getKey(name, tenantId ?? null);
    const existing = this.flags.get(key);

    const flag: FeatureFlag = existing
      ? { ...existing, enabled, updatedAt: new Date() }
      : {
          id: randomUUID(),
          name,
          description: DEFAULT_FLAGS[name as FeatureFlagName]?.description ?? null,
          enabled,
          tenantId: tenantId ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

    this.flags.set(key, flag);
    await this.persistToDb(flag);
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
    await this.persistToDb(flag);
    return flag;
  }

  async deleteFlag(id: string): Promise<boolean> {
    for (const [key, flag] of this.flags.entries()) {
      if (flag.id === id) {
        this.flags.delete(key);
        return true;
      }
    }
    return false;
  }
}

export const featureFlagService = new FeatureFlagService();

export function isFeatureEnabled(name: string, tenantId?: string): boolean {
  return featureFlagService.isEnabledSync(name, tenantId);
}

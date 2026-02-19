/**
 * Max Personal Adapter
 * 
 * Connects to personal Max messenger accounts via PyMax Python microservice.
 * Provides tenant isolation - each tenant has their own Max session.
 */

import type { ChannelAdapter, ParsedIncomingMessage, ChannelSendResult } from "./channel-adapter";
import type { ChannelType } from "@shared/schema";
import { featureFlagService } from "./feature-flags";

const MAX_SERVICE_URL = process.env.MAX_SERVICE_URL || "http://localhost:8100";

interface MaxAuthResult {
  success: boolean;
  status?: "disconnected" | "connecting" | "qr_ready" | "connected" | "error";
  qrCode?: string;
  qrDataUrl?: string;
  error?: string;
  user?: {
    id: string;
    name: string;
    phone: string;
  };
}

interface MaxSendResult {
  success: boolean;
  message_id?: string;
  timestamp?: string;
  error?: string;
}

export class MaxPersonalAdapter implements ChannelAdapter {
  readonly name: ChannelType = "max_personal";
  
  private tenantId: string;

  constructor(tenantId: string = "default") {
    this.tenantId = tenantId;
  }

  async sendMessage(
    externalConversationId: string,
    text: string,
    options?: { replyToMessageId?: string }
  ): Promise<ChannelSendResult> {
    const isEnabled = await featureFlagService.isEnabled("MAX_PERSONAL_CHANNEL_ENABLED");
    if (!isEnabled) {
      console.log("[MaxPersonal] Channel disabled by feature flag");
      return { success: false, error: "Max Personal channel disabled" };
    }

    try {
      const response = await fetch(`${MAX_SERVICE_URL}/send-message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenant_id: this.tenantId,
          chat_id: externalConversationId,
          text: text,
        }),
      });

      const result: MaxSendResult = await response.json();

      if (result.success) {
        console.log(`[MaxPersonal] Message sent to ${externalConversationId}`);
        return {
          success: true,
          externalMessageId: result.message_id || `max_${Date.now()}`,
          timestamp: result.timestamp ? new Date(result.timestamp) : new Date(),
        };
      } else {
        return { success: false, error: result.error };
      }
    } catch (error: any) {
      console.error("[MaxPersonal] Send error:", error.message);
      return { success: false, error: error.message };
    }
  }

  parseIncomingMessage(rawPayload: unknown): ParsedIncomingMessage | null {
    try {
      if (!rawPayload || typeof rawPayload !== "object") {
        console.log("[MaxPersonal] Parse: invalid payload");
        return null;
      }

      const msg = rawPayload as any;
      
      if (!msg.chat_id) {
        console.log("[MaxPersonal] Parse: no chat_id");
        return null;
      }

      return {
        externalMessageId: msg.id || `max_${Date.now()}`,
        externalConversationId: String(msg.chat_id),
        externalUserId: msg.sender_id || "unknown",
        text: msg.text || "",
        timestamp: msg.timestamp ? new Date(msg.timestamp) : new Date(),
        channel: "max_personal",
        metadata: { senderName: msg.sender_name, rawPayload: msg },
      };
    } catch (error) {
      console.error("[MaxPersonal] Parse error:", error);
      return null;
    }
  }

  /**
   * Start Max Personal authentication via QR code
   */
  static async startAuth(tenantId: string): Promise<MaxAuthResult> {
    try {
      const response = await fetch(`${MAX_SERVICE_URL}/start-auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenant_id: tenantId }),
      });

      const result = await response.json();
      // Map snake_case from Python to camelCase for TypeScript
      return {
        success: result.success,
        status: result.status,
        qrCode: result.qr_code,
        qrDataUrl: result.qr_data_url,
        user: result.user,
        error: result.error,
      };
    } catch (error: any) {
      console.error("[MaxPersonal] Start auth error:", error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Check authentication status
   */
  static async checkAuth(tenantId: string): Promise<MaxAuthResult> {
    try {
      const response = await fetch(`${MAX_SERVICE_URL}/check-auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenant_id: tenantId }),
      });

      const result = await response.json();
      return {
        success: true,
        status: result.status,
        qrCode: result.qr_code,
        qrDataUrl: result.qr_data_url,
        user: result.user,
        error: result.error,
      };
    } catch (error: any) {
      console.error("[MaxPersonal] Check auth error:", error.message);
      return { success: false, status: "error", error: error.message };
    }
  }

  /**
   * Logout and clear session
   */
  static async logout(tenantId: string): Promise<{ success: boolean; message?: string; error?: string }> {
    try {
      const response = await fetch(`${MAX_SERVICE_URL}/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenant_id: tenantId }),
      });

      const result = await response.json();
      return result;
    } catch (error: any) {
      console.error("[MaxPersonal] Logout error:", error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Check if connected
   */
  static async isConnected(tenantId: string): Promise<boolean> {
    try {
      const result = await MaxPersonalAdapter.checkAuth(tenantId);
      return result.status === "connected";
    } catch {
      return false;
    }
  }

  /**
   * Check if Python service is running
   */
  static async isServiceAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${MAX_SERVICE_URL}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(2000),
      });
      const result = await response.json();
      return result.status === "healthy";
    } catch {
      return false;
    }
  }
}

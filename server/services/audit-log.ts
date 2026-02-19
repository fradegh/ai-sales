import type { AuditEvent, InsertAuditEvent, AuditAction } from "@shared/schema";
import { randomUUID } from "crypto";
import { sanitizeDeep } from "../utils/sanitizer";

interface AuditContext {
  requestId?: string;
  ipAddress?: string;
  userAgent?: string;
  tenantId?: string;
}

class AuditLogService {
  private events: Map<string, AuditEvent> = new Map();
  private context: AuditContext = {};

  setContext(ctx: AuditContext): void {
    this.context = { ...this.context, ...ctx };
  }

  clearContext(): void {
    this.context = {};
  }

  async log(
    action: AuditAction,
    entityType: string,
    entityId: string,
    actor: string,
    actorType: "user" | "system" | "ai",
    metadata?: Record<string, unknown>
  ): Promise<AuditEvent> {
    const sanitizedMetadata = metadata ? sanitizeDeep(metadata) : {};
    
    const event: AuditEvent = {
      id: randomUUID(),
      tenantId: this.context.tenantId ?? null,
      actor,
      actorType,
      action,
      entityType,
      entityId,
      metadata: sanitizedMetadata,
      requestId: this.context.requestId ?? null,
      ipAddress: this.context.ipAddress ?? null,
      userAgent: this.context.userAgent ?? null,
      createdAt: new Date(),
    };

    this.events.set(event.id, event);
    
    // Log to console for observability
    console.log(JSON.stringify({
      level: "info",
      type: "audit",
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId,
      actor: event.actor,
      actorType: event.actorType,
      requestId: event.requestId,
      timestamp: event.createdAt.toISOString(),
    }));

    return event;
  }

  // Convenience methods for common actions
  async logSuggestionGenerated(
    suggestionId: string,
    conversationId: string,
    metadata?: Record<string, unknown>
  ): Promise<AuditEvent> {
    return this.log(
      "suggestion_generated",
      "suggestion",
      suggestionId,
      "system",
      "ai",
      { conversationId, ...metadata }
    );
  }

  async logSuggestionApproved(
    suggestionId: string,
    userId: string,
    metadata?: Record<string, unknown>
  ): Promise<AuditEvent> {
    return this.log(
      "suggestion_approved",
      "suggestion",
      suggestionId,
      userId,
      "user",
      metadata
    );
  }

  async logSuggestionEdited(
    suggestionId: string,
    userId: string,
    originalText: string,
    editedText: string
  ): Promise<AuditEvent> {
    return this.log(
      "suggestion_edited",
      "suggestion",
      suggestionId,
      userId,
      "user",
      { originalText, editedText }
    );
  }

  async logSuggestionRejected(
    suggestionId: string,
    userId: string,
    reason?: string
  ): Promise<AuditEvent> {
    return this.log(
      "suggestion_rejected",
      "suggestion",
      suggestionId,
      userId,
      "user",
      { reason }
    );
  }

  async logMessageSent(
    messageId: string,
    conversationId: string,
    actor: string,
    actorType: "user" | "ai"
  ): Promise<AuditEvent> {
    return this.log(
      "message_sent",
      "message",
      messageId,
      actor,
      actorType,
      { conversationId }
    );
  }

  async logConversationEscalated(
    conversationId: string,
    escalationId: string,
    reason: string,
    userId?: string
  ): Promise<AuditEvent> {
    return this.log(
      "conversation_escalated",
      "conversation",
      conversationId,
      userId || "system",
      userId ? "user" : "system",
      { escalationId, reason }
    );
  }

  async logEscalationResolved(
    escalationId: string,
    conversationId: string,
    userId: string,
    resolution: "handled" | "dismissed"
  ): Promise<AuditEvent> {
    const action = resolution === "handled" ? "escalation_resolved" : "escalation_dismissed";
    return this.log(
      action,
      "escalation",
      escalationId,
      userId,
      "user",
      { conversationId }
    );
  }

  async logConversationStatusChanged(
    conversationId: string,
    fromStatus: string,
    toStatus: string,
    actor: string,
    actorType: "user" | "system"
  ): Promise<AuditEvent> {
    return this.log(
      "conversation_status_changed",
      "conversation",
      conversationId,
      actor,
      actorType,
      { fromStatus, toStatus }
    );
  }

  async logFeatureFlagToggled(
    flagName: string,
    enabled: boolean,
    userId: string,
    tenantId?: string
  ): Promise<AuditEvent> {
    return this.log(
      "feature_flag_toggled",
      "feature_flag",
      flagName,
      userId,
      "user",
      { enabled, tenantId }
    );
  }

  // Query methods
  async getEventsByEntity(
    entityType: string,
    entityId: string,
    limit = 50
  ): Promise<AuditEvent[]> {
    return Array.from(this.events.values())
      .filter((e) => e.entityType === entityType && e.entityId === entityId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  async getEventsByConversation(conversationId: string, limit = 50): Promise<AuditEvent[]> {
    return Array.from(this.events.values())
      .filter((e) => 
        (e.entityType === "conversation" && e.entityId === conversationId) ||
        (e.metadata as Record<string, unknown>)?.conversationId === conversationId
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  async getRecentEvents(tenantId: string, limit = 100): Promise<AuditEvent[]> {
    return Array.from(this.events.values())
      .filter((e) => e.tenantId === tenantId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  async getAllEvents(limit = 1000): Promise<AuditEvent[]> {
    return Array.from(this.events.values())
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }
}

// Singleton instance
export const auditLog = new AuditLogService();

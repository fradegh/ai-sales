import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { db } from "./db";
import OpenAI from "openai";
import { z } from "zod";
import { insertProductSchema, insertKnowledgeDocSchema, insertMessageSchema, updateCustomerSchema, insertCustomerNoteSchema, VALID_INTENTS, TRAINING_POLICY_LIMITS, users, tenants } from "@shared/schema";
import { sql, count, gte } from "drizzle-orm";
import { registerPhase0Routes } from "./routes/phase0";
import authRouter from "./routes/auth";
import adminRouter from "./routes/admin";
import maxWebhookRouter from "./routes/max-webhook";
import { telegramWebhookHandler } from "./routes/telegram-webhook";
import { whatsappWebhookHandler, whatsappWebhookVerifyHandler } from "./routes/whatsapp-webhook";
import { featureFlagService } from "./services/feature-flags";
import { auditLog } from "./services/audit-log";
import { aiRateLimiter, onboardingRateLimiter, webhookRateLimiter, conversationRateLimiter, tenantAiLimiter, tenantConversationLimiter } from "./middleware/rate-limiter";
import { scheduleDelayedMessage, cancelDelayedMessage, getDelayedJobs, getQueueMetrics } from "./services/message-queue";
import { registerAuthRoutes } from "./routes/auth-api";
import { getSession } from "./session";
import { channelRegistry } from "./services/channel-adapter";
import { WhatsAppPersonalAdapter } from "./services/whatsapp-personal-adapter";
import { requireAuth, requireOperator, requireAdmin, requirePermission } from "./middleware/rbac";
import { requireActiveSubscription } from "./middleware/subscription";
import { requireActiveTenant } from "./middleware/fraud-protection";
import { fraudDetectionService } from "./services/fraud-detection-service";
import { sanitizeString } from "./utils/sanitizer";
import { createTrackedApp } from "./services/route-registry";
import { recordTrainingSample, getTrainingSamples, exportTrainingSamples, type TrainingOutcome } from "./services/training-sample-service";
import { addToLearningQueue } from "./services/learning-score-service";

// Constants for input validation
const MAX_NOTE_LENGTH = 2048; // 2KB limit for notes

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || undefined,
});

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  // Enable route tracking for RBAC coverage reporting
  createTrackedApp(app);
  
  // Setup session middleware for email/password auth
  app.use(getSession());
  
  registerAuthRoutes(app);
  
  // ============ TENANT ROUTES ============
  
  app.get("/api/tenant", requireAuth, requirePermission("VIEW_CONVERSATIONS"), async (req: Request, res: Response) => {
    try {
      const user = await storage.getUser(req.userId);
      if (!user?.tenantId) {
        return res.status(403).json({ error: "User not associated with a tenant" });
      }
      const tenant = await storage.getTenant(user.tenantId);
      if (!tenant) {
        return res.status(404).json({ error: "Tenant not found" });
      }
      res.json(tenant);
    } catch (error) {
      console.error("Error fetching tenant:", error);
      res.status(500).json({ error: "Failed to fetch tenant" });
    }
  });

  app.patch("/api/tenant", requireAuth, requirePermission("MANAGE_TENANT_SETTINGS"), async (req: Request, res: Response) => {
    try {
      const user = await storage.getUser(req.userId);
      if (!user?.tenantId) {
        return res.status(403).json({ error: "User not associated with a tenant" });
      }
      const updated = await storage.updateTenant(user.tenantId, req.body);
      res.json(updated);
    } catch (error) {
      console.error("Error updating tenant:", error);
      res.status(500).json({ error: "Failed to update tenant" });
    }
  });

  app.post("/api/onboarding/setup", requireAuth, requirePermission("MANAGE_TENANT_SETTINGS"), async (req: Request, res: Response) => {
    try {
      const data = req.body;
      let tenant = await storage.getDefaultTenant();
      
      if (tenant) {
        tenant = await storage.updateTenant(tenant.id, {
          name: data.name,
          language: data.language,
          tone: data.tone,
          addressStyle: data.addressStyle,
          currency: data.currency,
          timezone: data.timezone,
          workingHoursStart: data.workingHoursStart,
          workingHoursEnd: data.workingHoursEnd,
          autoReplyOutsideHours: data.autoReplyOutsideHours,
          escalationEmail: data.escalationEmail || null,
          allowDiscounts: data.allowDiscounts,
          maxDiscountPercent: data.maxDiscountPercent,
        });
      } else {
        tenant = await storage.createTenant({
          name: data.name,
          language: data.language,
          tone: data.tone,
          addressStyle: data.addressStyle,
          currency: data.currency,
          timezone: data.timezone,
          workingHoursStart: data.workingHoursStart,
          workingHoursEnd: data.workingHoursEnd,
          autoReplyOutsideHours: data.autoReplyOutsideHours,
          escalationEmail: data.escalationEmail || null,
          allowDiscounts: data.allowDiscounts,
          maxDiscountPercent: data.maxDiscountPercent,
        });
      }

      // Create initial knowledge docs from onboarding data
      if (data.deliveryOptions) {
        await storage.createKnowledgeDoc({
          tenantId: tenant!.id,
          title: "Delivery Options",
          content: data.deliveryOptions,
          category: "shipping",
        });
      }
      if (data.returnPolicy) {
        await storage.createKnowledgeDoc({
          tenantId: tenant!.id,
          title: "Return Policy",
          content: data.returnPolicy,
          category: "returns",
        });
      }

      res.json(tenant);
    } catch (error) {
      console.error("Error in onboarding setup:", error);
      res.status(500).json({ error: "Failed to complete setup" });
    }
  });

  // ============ CUSTOMER MEMORY ROUTES ============

  // GET /api/customers - List customers with optional search
  app.get("/api/customers", requireAuth, requirePermission("VIEW_CUSTOMERS"), async (req: Request, res: Response) => {
    try {
      const tenant = await storage.getDefaultTenant();
      if (!tenant) {
        return res.status(404).json({ error: "Tenant not found" });
      }
      const search = req.query.search as string | undefined;
      let customers;
      if (search && search.trim().length > 0) {
        customers = await storage.searchCustomers(tenant.id, search.trim());
      } else {
        customers = await storage.getCustomersByTenant(tenant.id);
      }
      res.json(customers);
    } catch (error) {
      console.error("Error fetching customers:", error);
      res.status(500).json({ error: "Failed to fetch customers" });
    }
  });

  // GET /api/customers/:id - Get single customer
  app.get("/api/customers/:id", requireAuth, requirePermission("VIEW_CUSTOMERS"), async (req: Request, res: Response) => {
    try {
      const customer = await storage.getCustomer(req.params.id);
      if (!customer) {
        return res.status(404).json({ error: "Customer not found" });
      }
      res.json(customer);
    } catch (error) {
      console.error("Error fetching customer:", error);
      res.status(500).json({ error: "Failed to fetch customer" });
    }
  });

  // PATCH /api/customers/:id - Update customer (displayName, tags)
  // RBAC: owner, admin, operator
  app.patch("/api/customers/:id", requireAuth, requireOperator, async (req: Request, res: Response) => {
    try {
      const customer = await storage.getCustomer(req.params.id);
      if (!customer) {
        return res.status(404).json({ error: "Customer not found" });
      }
      
      const parsed = updateCustomerSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid data", details: parsed.error.flatten() });
      }
      
      const updated = await storage.updateCustomer(req.params.id, parsed.data);
      res.json(updated);
    } catch (error) {
      console.error("Error updating customer:", error);
      res.status(500).json({ error: "Failed to update customer" });
    }
  });

  // GET /api/customers/:id/notes - Get customer notes
  app.get("/api/customers/:id/notes", requireAuth, requirePermission("VIEW_CUSTOMERS"), async (req: Request, res: Response) => {
    try {
      const customer = await storage.getCustomer(req.params.id);
      if (!customer) {
        return res.status(404).json({ error: "Customer not found" });
      }
      const notes = await storage.getCustomerNotes(req.params.id);
      res.json(notes);
    } catch (error) {
      console.error("Error fetching customer notes:", error);
      res.status(500).json({ error: "Failed to fetch customer notes" });
    }
  });

  // POST /api/customers/:id/notes - Create customer note
  // RBAC: operator+
  app.post("/api/customers/:id/notes", requireAuth, requireOperator, async (req: Request, res: Response) => {
    try {
      const customer = await storage.getCustomer(req.params.id);
      if (!customer) {
        return res.status(404).json({ error: "Customer not found" });
      }

      const noteInputSchema = insertCustomerNoteSchema.pick({
        noteText: true,
      }).extend({
        noteText: z.string()
          .min(1, "Note text is required")
          .max(MAX_NOTE_LENGTH, `Note text must be ${MAX_NOTE_LENGTH} characters or less`),
      });
      
      const parsed = noteInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid data", details: parsed.error.flatten() });
      }

      // Validate user exists (required for author attribution)
      if (!req.userId || req.userId === "system") {
        return res.status(403).json({ error: "User authentication required to create notes" });
      }
      
      const user = await storage.getUser(req.userId);
      if (!user) {
        return res.status(403).json({ error: "User not found in system" });
      }

      // Sanitize PII in note text before saving
      const sanitizedNoteText = sanitizeString(parsed.data.noteText);

      const note = await storage.createCustomerNote({
        tenantId: customer.tenantId,
        customerId: req.params.id,
        noteText: sanitizedNoteText,
        authorUserId: user.id,
      });
      
      // Audit log: note_added
      auditLog.setContext({ tenantId: customer.tenantId, requestId: req.requestId });
      await auditLog.log(
        "note_added" as any,
        "customer_note",
        note.id,
        user.id,
        "user",
        { customerId: customer.id, noteLength: sanitizedNoteText.length }
      );
      
      res.status(201).json(note);
    } catch (error) {
      console.error("Error creating customer note:", error);
      res.status(500).json({ error: "Failed to create customer note" });
    }
  });

  // DELETE /api/customers/:id/notes/:noteId - Delete customer note
  // RBAC: author or admin
  app.delete("/api/customers/:id/notes/:noteId", requireAuth, requireOperator, async (req: Request, res: Response) => {
    try {
      const customer = await storage.getCustomer(req.params.id);
      if (!customer) {
        return res.status(404).json({ error: "Customer not found" });
      }
      
      const note = await storage.getCustomerNote(req.params.noteId);
      if (!note) {
        return res.status(404).json({ error: "Note not found" });
      }
      
      // Check permission: author or admin
      const isAdmin = req.userRole === "admin" || req.userRole === "owner";
      
      // Resolve current user to check authorship
      let isAuthor = false;
      if (req.userId && note.authorUserId) {
        const currentUser = await storage.getUser(req.userId);
        if (currentUser) {
          isAuthor = note.authorUserId === currentUser.id;
        }
      }
      
      if (!isAuthor && !isAdmin) {
        return res.status(403).json({ error: "Only note author or admin can delete this note" });
      }
      
      await storage.deleteCustomerNote(req.params.noteId);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting customer note:", error);
      res.status(500).json({ error: "Failed to delete customer note" });
    }
  });

  // DELETE /api/customers/:id/data - Complete customer data deletion (GDPR compliance, admin only)
  app.delete("/api/customers/:id/data", requireAuth, requirePermission("DELETE_CUSTOMER_DATA"), async (req: Request, res: Response) => {
    try {
      const customerId = req.params.id;
      const tenantId = req.tenantId;
      const userId = req.userId;

      if (!tenantId || !userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const customer = await storage.getCustomer(customerId);
      
      if (!customer) {
        return res.json({
          success: true,
          customerId,
          tenantId,
          deletedEntities: {
            customers: 0,
            customerMemory: 0,
            customerNotes: 0,
            conversations: 0,
            messages: 0,
            aiSuggestions: 0,
            humanActions: 0,
            aiTrainingSamples: 0,
            csatRatings: 0,
            conversions: 0,
            lostDeals: 0,
          },
          deletedAt: new Date().toISOString(),
          message: "Customer data already deleted or does not exist",
        });
      }

      if (customer.tenantId !== tenantId) {
        return res.status(403).json({ error: "Cannot delete customer data from another tenant" });
      }

      const { deleteCustomerData } = await import("./services/customer-data-deletion-service");
      const result = await deleteCustomerData(customerId, tenantId, userId);

      res.json(result);
    } catch (error) {
      console.error("Error deleting customer data:", error);
      if (error instanceof Error && error.message === "TENANT_MISMATCH") {
        return res.status(403).json({ error: "Cannot delete customer data from another tenant" });
      }
      res.status(500).json({ error: "Failed to delete customer data" });
    }
  });

  // ============ CUSTOMER MEMORY ROUTES ============

  // GET /api/customers/:id/memory - Get customer memory (preferences + frequent topics)
  app.get("/api/customers/:id/memory", requireAuth, requirePermission("VIEW_CUSTOMERS"), async (req: Request, res: Response) => {
    try {
      const customer = await storage.getCustomer(req.params.id);
      if (!customer) {
        return res.status(404).json({ error: "Customer not found" });
      }
      
      const memory = await storage.getCustomerMemory(customer.tenantId, customer.id);
      if (!memory) {
        // Return empty memory structure
        return res.json({
          customerId: customer.id,
          tenantId: customer.tenantId,
          preferences: {},
          frequentTopics: {},
          lastSummaryText: null,
        });
      }
      
      res.json(memory);
    } catch (error) {
      console.error("Error fetching customer memory:", error);
      res.status(500).json({ error: "Failed to fetch customer memory" });
    }
  });

  // PATCH /api/customers/:id/memory - Update customer preferences
  // RBAC: operator+
  app.patch("/api/customers/:id/memory", requireAuth, requireOperator, async (req: Request, res: Response) => {
    try {
      const customer = await storage.getCustomer(req.params.id);
      if (!customer) {
        return res.status(404).json({ error: "Customer not found" });
      }
      
      const { preferences, lastSummaryText } = req.body;
      
      if (preferences && typeof preferences !== "object") {
        return res.status(400).json({ error: "preferences must be an object" });
      }
      
      let memory;
      if (preferences) {
        memory = await storage.updateCustomerPreferences(customer.tenantId, customer.id, preferences);
      } else {
        memory = await storage.upsertCustomerMemory({
          tenantId: customer.tenantId,
          customerId: customer.id,
          lastSummaryText: lastSummaryText ?? undefined,
        });
      }
      
      // Audit log: memory_updated
      auditLog.setContext({ tenantId: customer.tenantId, requestId: req.requestId });
      await auditLog.log(
        "memory_updated" as any,
        "customer_memory",
        customer.id,
        req.userId || "system",
        req.userId ? "user" : "system",
        { 
          updatedPreferences: preferences ? Object.keys(preferences) : [],
          updatedSummary: !!lastSummaryText,
        }
      );
      
      res.json(memory);
    } catch (error) {
      console.error("Error updating customer memory:", error);
      res.status(500).json({ error: "Failed to update customer memory" });
    }
  });

  // POST /api/customers/:id/memory/rebuild-summary - Rebuild customer summary via LLM
  // RBAC: admin only
  app.post("/api/customers/:id/memory/rebuild-summary", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      const customer = await storage.getCustomer(req.params.id);
      if (!customer) {
        return res.status(404).json({ error: "Customer not found" });
      }
      
      const { generateCustomerSummary } = await import("./services/customer-summary-service");
      const result = await generateCustomerSummary(customer.tenantId, customer.id, "manual_rebuild");
      
      if (!result.success) {
        return res.status(500).json({ error: result.error || "Failed to generate summary" });
      }
      
      // Audit log: summary_updated (manual rebuild by admin)
      auditLog.setContext({ tenantId: customer.tenantId, requestId: req.requestId });
      await auditLog.log(
        "summary_updated" as any,
        "customer_memory",
        customer.id,
        req.userId || "system",
        "user",
        { 
          triggeredBy: "manual_rebuild",
          summaryLength: result.summary?.length ?? 0,
        }
      );
      
      const memory = await storage.getCustomerMemory(customer.tenantId, customer.id);
      res.json({ 
        success: true, 
        summary: result.summary,
        memory 
      });
    } catch (error) {
      console.error("Error rebuilding customer summary:", error);
      res.status(500).json({ error: "Failed to rebuild customer summary" });
    }
  });

  // ============ DASHBOARD ROUTES ============

  app.get("/api/dashboard/metrics", requireAuth, requirePermission("VIEW_ANALYTICS"), async (req: Request, res: Response) => {
    try {
      const user = await storage.getUser(req.userId);
      if (!user?.tenantId) {
        return res.status(403).json({ error: "User not associated with a tenant" });
      }
      const metrics = await storage.getDashboardMetrics(user.tenantId);
      res.json(metrics);
    } catch (error) {
      console.error("Error fetching metrics:", error);
      res.status(500).json({ error: "Failed to fetch metrics" });
    }
  });

  // ============ CONVERSATION ROUTES ============

  // Helper to get user by OIDC ID or regular ID (for conversation routes)
  async function getUserForConversations(userId: string) {
    let user = await storage.getUserByOidcId(userId);
    if (!user) {
      user = await storage.getUser(userId);
    }
    return user;
  }

  app.get("/api/conversations", requireAuth, requirePermission("VIEW_CONVERSATIONS"), async (req: Request, res: Response) => {
    try {
      if (!req.userId || req.userId === "system") {
        return res.status(403).json({ error: "User authentication required" });
      }
      const user = await getUserForConversations(req.userId);
      if (!user?.tenantId) {
        return res.status(403).json({ error: "User not associated with a tenant" });
      }
      
      const status = req.query.status as string;
      let conversations;
      if (status === "active") {
        conversations = await storage.getActiveConversations(user.tenantId);
      } else {
        conversations = await storage.getConversationsByTenant(user.tenantId);
      }
      res.json(conversations);
    } catch (error) {
      console.error("Error fetching conversations:", error);
      res.status(500).json({ error: "Failed to fetch conversations" });
    }
  });

  app.get("/api/conversations/:id", requireAuth, requirePermission("VIEW_CONVERSATIONS"), async (req: Request, res: Response) => {
    try {
      if (!req.userId || req.userId === "system") {
        return res.status(403).json({ error: "User authentication required" });
      }
      const user = await getUserForConversations(req.userId);
      if (!user?.tenantId) {
        return res.status(403).json({ error: "User not associated with a tenant" });
      }
      
      const detail = await storage.getConversationDetail(req.params.id);
      if (!detail) {
        return res.status(404).json({ error: "Conversation not found" });
      }
      
      // Verify tenant ownership
      if (detail.tenantId !== user.tenantId) {
        return res.status(403).json({ error: "Access denied" });
      }
      
      res.json(detail);
    } catch (error) {
      console.error("Error fetching conversation:", error);
      res.status(500).json({ error: "Failed to fetch conversation" });
    }
  });

  // PATCH /api/conversations/:id - Update conversation status/mode
  // RBAC: operator+
  app.patch("/api/conversations/:id", requireAuth, requireOperator, async (req: Request, res: Response) => {
    try {
      const conversation = await storage.getConversation(req.params.id);
      if (!conversation) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      const { status, mode } = req.body;
      const previousStatus = conversation.status;

      const updated = await storage.updateConversation(req.params.id, { status, mode });
      
      if (status === "resolved" && previousStatus !== "resolved") {
        const { triggerSummaryOnConversationResolved } = await import("./services/customer-summary-service");
        triggerSummaryOnConversationResolved(conversation.tenantId, conversation.customerId).catch(err => {
          console.error("Failed to trigger summary on conversation resolved:", err);
        });
      }

      res.json(updated);
    } catch (error) {
      console.error("Error updating conversation:", error);
      res.status(500).json({ error: "Failed to update conversation" });
    }
  });

  // Mark conversation as read (reset unread count)
  app.post("/api/conversations/:id/read", requireAuth, requirePermission("VIEW_CONVERSATIONS"), async (req: Request, res: Response) => {
    try {
      if (!req.userId || req.userId === "system") {
        return res.status(403).json({ error: "User authentication required" });
      }
      const user = await getUserForConversations(req.userId);
      if (!user?.tenantId) {
        return res.status(403).json({ error: "User not associated with a tenant" });
      }

      const conversation = await storage.getConversation(req.params.id);
      if (!conversation || conversation.tenantId !== user.tenantId) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      await storage.updateConversation(req.params.id, { unreadCount: 0 });
      res.json({ success: true });
    } catch (error) {
      console.error("Error marking conversation as read:", error);
      res.status(500).json({ error: "Failed to mark conversation as read" });
    }
  });

  app.post("/api/conversations/:id/messages", requireAuth, requirePermission("MANAGE_CONVERSATIONS"), conversationRateLimiter, tenantConversationLimiter, async (req: Request, res: Response) => {
    try {
      const { content, role = "owner" } = req.body;
      
      // Validate content
      if (!content || typeof content !== "string" || content.trim().length === 0) {
        return res.status(400).json({ error: "Message content is required" });
      }
      
      // Get conversation details to determine channel and recipient
      const conversation = await storage.getConversationDetail(req.params.id);
      if (!conversation) {
        return res.status(404).json({ error: "Conversation not found" });
      }
      
      const message = await storage.createMessage({
        conversationId: req.params.id,
        role,
        content: content.trim(),
        attachments: [],
        metadata: {},
      });

      // Reset unread count when owner sends a message
      await storage.updateConversation(req.params.id, { unreadCount: 0 });

      // Send outbound message via appropriate channel (only for owner messages)
      if (role === "owner" && conversation.messages.length > 0) {
        // Detect channel from most recent customer message metadata
        const customerMessages = conversation.messages.filter(m => m.role === "customer");
        const lastCustomerMsg = customerMessages[customerMessages.length - 1];
        const channelType = (lastCustomerMsg?.metadata as any)?.channel;
        
        // Also try to detect channel from conversation's channel record if metadata missing
        let effectiveChannelType = channelType;
        if (!effectiveChannelType && conversation.channelId) {
          const channel = await storage.getChannel(conversation.channelId);
          effectiveChannelType = channel?.type;
          console.log(`[OutboundHandler] Channel type from DB: ${effectiveChannelType}`);
        }
        
        console.log(`[OutboundHandler] Sending message. Channel: ${effectiveChannelType}, ChannelId: ${conversation.channelId}, CustomerId: ${conversation.customer?.id}, CustomerExternalId: ${conversation.customer?.externalId}, LastMsgMeta: ${JSON.stringify(lastCustomerMsg?.metadata)}`);
        
        if (effectiveChannelType === "whatsapp_personal" && conversation.customer) {
          // Get WhatsApp JID from customer externalId
          let recipientJid = conversation.customer.externalId;
          if (!recipientJid.includes("@")) {
            recipientJid = `${recipientJid}@s.whatsapp.net`;
          }
          
          try {
            const adapter = new WhatsAppPersonalAdapter(conversation.tenantId);
            const sendResult = await adapter.sendMessage(recipientJid, content.trim());
            
            if (sendResult.success) {
              console.log(`[OutboundHandler] WhatsApp message sent: ${sendResult.externalMessageId}`);
            } else {
              console.error(`[OutboundHandler] WhatsApp send failed: ${sendResult.error}`);
            }
          } catch (sendError: any) {
            console.error(`[OutboundHandler] WhatsApp send error:`, sendError.message);
          }
        }
        
        // Handle Telegram Personal outbound messages
        // Get channelId from conversation or from message metadata as fallback
        const effectiveChannelId = conversation.channelId || (lastCustomerMsg?.metadata as any)?.channelId;
        
        if (effectiveChannelType === "telegram_personal" && conversation.customer && effectiveChannelId) {
          try {
            const { telegramClientManager } = await import("./services/telegram-client-manager");
            const recipientId = conversation.customer.externalId;
            
            console.log(`[OutboundHandler] Sending Telegram message to ${recipientId} via channel ${effectiveChannelId}`);
            
            const sendResult = await telegramClientManager.sendMessage(
              conversation.tenantId,
              effectiveChannelId,
              recipientId,
              content.trim()
            );
            
            if (sendResult.success) {
              console.log(`[OutboundHandler] Telegram message sent: ${sendResult.externalMessageId}`);
            } else {
              console.error(`[OutboundHandler] Telegram send failed: ${sendResult.error}`);
            }
          } catch (sendError: any) {
            console.error(`[OutboundHandler] Telegram send error:`, sendError.message);
          }
        }
      }

      res.status(201).json(message);
    } catch (error) {
      console.error("Error sending message:", error);
      res.status(500).json({ error: "Failed to send message" });
    }
  });

  // ============ AI SUGGESTION ROUTES ============

  // Phase 0: AI rate limiting (20 req/min) applied to AI generation endpoint
  // Phase 1: Now uses Decision Engine for confidence pipeline and decision making
  app.post("/api/conversations/:id/generate-suggestion", requireAuth, requirePermission("VIEW_CONVERSATIONS"), aiRateLimiter, tenantAiLimiter, async (req: Request, res: Response) => {
    try {
      const conversation = await storage.getConversationDetail(req.params.id);
      if (!conversation) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      const tenant = await storage.getDefaultTenant();
      if (!tenant) {
        return res.status(404).json({ error: "Tenant not found" });
      }

      const lastCustomerMessage = conversation.messages
        .filter((m) => m.role === "customer")
        .pop();
      
      if (!lastCustomerMessage) {
        return res.status(400).json({ error: "No customer message to respond to" });
      }

      const relevantDocs = await storage.searchKnowledgeDocs(tenant.id, lastCustomerMessage.content);
      const relevantProducts = await storage.searchProducts(tenant.id, lastCustomerMessage.content);

      const conversationHistory = conversation.messages.slice(-6).map((m) => ({
        role: (m.role === "customer" ? "user" : "assistant") as "user" | "assistant",
        content: m.content,
      }));

      // Phase 1: Use Decision Engine for AI generation with confidence pipeline
      const { generateWithDecisionEngine } = await import("./services/decision-engine");
      const decisionResult = await generateWithDecisionEngine({
        conversationId: req.params.id,
        tenantId: tenant.id,
        tenant,
        customerMessage: lastCustomerMessage.content,
        conversationHistory,
        products: relevantProducts,
        docs: relevantDocs,
      });

      const suggestion = await storage.createAiSuggestion({
        conversationId: req.params.id,
        messageId: lastCustomerMessage.id,
        suggestedReply: decisionResult.replyText,
        intent: decisionResult.intent,
        confidence: decisionResult.confidence.total,
        needsApproval: decisionResult.needsApproval,
        needsHandoff: decisionResult.needsHandoff,
        questionsToAsk: [],
        usedSources: decisionResult.usedSources,
        status: "pending",
        // Phase 1: Decision Engine fields
        similarityScore: decisionResult.confidence.similarity,
        intentScore: decisionResult.confidence.intent,
        selfCheckScore: decisionResult.confidence.selfCheck,
        decision: decisionResult.decision,
        explanations: decisionResult.explanations,
        penalties: decisionResult.penalties,
        sourceConflicts: decisionResult.usedSources.length > 0,
        missingFields: decisionResult.missingFields,
        // Phase 1.1: Triple lock autosend fields
        autosendEligible: decisionResult.autosendEligible,
        autosendBlockReason: decisionResult.autosendBlockReason,
        // Phase 1.1: Self-check handoff info  
        selfCheckNeedHandoff: decisionResult.selfCheckNeedHandoff,
        selfCheckReasons: decisionResult.selfCheckReasons,
      });

      // Phase 0: Audit log
      await auditLog.logSuggestionGenerated(suggestion.id, req.params.id, {
        intent: decisionResult.intent,
        confidence: decisionResult.confidence.total,
        decision: decisionResult.decision,
      });

      res.status(201).json(suggestion);
    } catch (error) {
      console.error("Error generating suggestion:", error);
      res.status(500).json({ error: "Failed to generate suggestion" });
    }
  });

  app.post("/api/suggestions/:id/approve", requireAuth, requirePermission("MANAGE_CONVERSATIONS"), async (req: Request, res: Response) => {
    try {
      const suggestion = await storage.getAiSuggestion(req.params.id);
      if (!suggestion) {
        return res.status(404).json({ error: "Suggestion not found" });
      }

      // Get tenant for working hours info
      const tenant = await storage.getDefaultTenant();
      if (!tenant) {
        return res.status(404).json({ error: "Tenant not found" });
      }

      // Phase 2: Check if human delay is enabled and calculate delay
      const humanDelayEnabled = await featureFlagService.isEnabled("HUMAN_DELAY_ENABLED");
      let delayResult = null;
      let messageToSend = suggestion.suggestedReply;

      if (humanDelayEnabled) {
        const { computeHumanDelay, getDefaultHumanDelaySettings } = await import("./services/human-delay-engine");
        const delaySettings = await storage.getHumanDelaySettings(tenant.id) || getDefaultHumanDelaySettings(tenant.id);
        
        if (delaySettings.enabled) {
          delayResult = computeHumanDelay({
            messageLength: suggestion.suggestedReply.length,
            settings: delaySettings,
            tenant: {
              workingHoursStart: tenant.workingHoursStart,
              workingHoursEnd: tenant.workingHoursEnd,
              timezone: tenant.timezone,
            },
          });

          // Handle night mode actions
          if (delayResult.nightModeAction === "DISABLE") {
            return res.status(400).json({ 
              error: "Sending disabled outside working hours",
              delayResult 
            });
          }

          if (delayResult.nightModeAction === "AUTO_REPLY" && delayResult.autoReplyText) {
            messageToSend = delayResult.autoReplyText;
          }
        }
      }

      // Update suggestion status
      await storage.updateAiSuggestion(req.params.id, { status: "approved" });

      // Create message from the suggestion
      const message = await storage.createMessage({
        conversationId: suggestion.conversationId,
        role: "assistant",
        content: messageToSend,
        attachments: [],
        metadata: { 
          suggestionId: suggestion.id,
          delayApplied: delayResult?.delay?.finalDelayMs || 0,
          isNightMode: delayResult?.delay?.isNightMode || false,
          status: "pending",
        },
      });

      // Create human action record
      await storage.createHumanAction({
        suggestionId: suggestion.id,
        action: "approve",
        originalText: suggestion.suggestedReply,
      });

      // Record training sample for ML dataset
      const messages = await storage.getMessagesByConversation(suggestion.conversationId);
      const lastCustomerMessage = [...messages].reverse().find(m => m.role === "customer");
      if (lastCustomerMessage) {
        await recordTrainingSample({
          suggestion,
          userMessage: lastCustomerMessage.content,
          finalAnswer: suggestion.suggestedReply,
          outcome: "APPROVED",
          tenantId: tenant.id,
        });
      }

      // Add to learning queue if score > 0
      await addToLearningQueue({
        suggestion,
        outcome: "APPROVED",
        messageCount: messages.length,
        tenantId: tenant.id,
        conversationId: suggestion.conversationId,
      });

      // Phase 2.1: Schedule delayed send if delay enabled, otherwise send immediately
      let scheduledJob = null;
      let sentImmediately = false;
      
      if (humanDelayEnabled && delayResult?.delay?.finalDelayMs) {
        const delaySettings = await storage.getHumanDelaySettings(tenant.id);
        scheduledJob = await scheduleDelayedMessage({
          tenantId: tenant.id,
          conversationId: suggestion.conversationId,
          messageId: message.id,
          suggestionId: suggestion.id,
          channel: "mock",
          text: messageToSend,
          delayMs: delayResult.delay.finalDelayMs,
          typingEnabled: delaySettings?.typingIndicatorEnabled || false,
        });
        
        // If queue unavailable, mark as sent immediately (fallback)
        if (!scheduledJob) {
          sentImmediately = true;
        }
      } else {
        // No delay - message sent immediately
        sentImmediately = true;
      }

      // Send message to channel - using same logic as manual message sending
      let channelSendResult = null;
      try {
        const conversationDetail = await storage.getConversationDetail(suggestion.conversationId);
        if (conversationDetail) {
          const messages = conversationDetail.messages || [];
          const lastCustomerMsg = messages.filter(m => m.role === "customer").pop();
          
          // Get channel type from customer or message metadata
          let effectiveChannelType = conversationDetail.customer?.channel as string | undefined;
          if (!effectiveChannelType && lastCustomerMsg) {
            effectiveChannelType = (lastCustomerMsg.metadata as any)?.channel;
          }
          if (!effectiveChannelType && conversationDetail.channelId) {
            const channel = await storage.getChannel(conversationDetail.channelId);
            effectiveChannelType = channel?.type;
          }
          
          // Get channel ID from conversation or from message metadata
          const effectiveChannelId = conversationDetail.channelId || (lastCustomerMsg?.metadata as any)?.channelId;
          
          console.log(`[Outbound] Approve - Channel: ${effectiveChannelType}, ChannelId: ${effectiveChannelId}, CustomerExternalId: ${conversationDetail.customer?.externalId}`);
          
          if (effectiveChannelType === "telegram_personal" && conversationDetail.customer && effectiveChannelId) {
            try {
              const { telegramClientManager } = await import("./services/telegram-client-manager");
              const recipientId = conversationDetail.customer.externalId;
              
              console.log(`[Outbound] Sending Telegram message to ${recipientId} via channel ${effectiveChannelId}`);
              
              channelSendResult = await telegramClientManager.sendMessage(
                conversationDetail.tenantId,
                effectiveChannelId,
                recipientId,
                messageToSend
              );
              
              if (channelSendResult.success) {
                console.log(`[Outbound] Telegram message sent: ${channelSendResult.externalMessageId}`);
              } else {
                console.error(`[Outbound] Telegram send failed: ${channelSendResult.error}`);
              }
            } catch (sendError: any) {
              console.error(`[Outbound] Telegram send error:`, sendError.message);
            }
          } else if (effectiveChannelType === "whatsapp_personal" && conversationDetail.customer) {
            let recipientJid = conversationDetail.customer.externalId;
            if (!recipientJid.includes("@")) {
              recipientJid = `${recipientJid}@s.whatsapp.net`;
            }
            const waAdapter = new WhatsAppPersonalAdapter(tenant.id);
            console.log(`[Outbound] Sending WhatsApp message to ${recipientJid}`);
            channelSendResult = await waAdapter.sendMessage(recipientJid, messageToSend);
            console.log(`[Outbound] Result:`, channelSendResult);
          }
        }
      } catch (channelError) {
        console.error("[Outbound] Channel send error:", channelError);
      }

      // Phase 0: Audit log
      await auditLog.logSuggestionApproved(suggestion.id, "operator");
      await auditLog.logMessageSent(message.id, suggestion.conversationId, "ai", "ai");

      res.json({ suggestion, message, delayResult, scheduledJob, sentImmediately, channelSendResult });
    } catch (error) {
      console.error("Error approving suggestion:", error);
      res.status(500).json({ error: "Failed to approve suggestion" });
    }
  });

  app.post("/api/suggestions/:id/edit", requireAuth, requirePermission("MANAGE_CONVERSATIONS"), async (req: Request, res: Response) => {
    try {
      const { editedText } = req.body;
      const suggestion = await storage.getAiSuggestion(req.params.id);
      if (!suggestion) {
        return res.status(404).json({ error: "Suggestion not found" });
      }

      // Get tenant for working hours info
      const tenant = await storage.getDefaultTenant();
      if (!tenant) {
        return res.status(404).json({ error: "Tenant not found" });
      }

      // Phase 2: Check if human delay is enabled and calculate delay
      const humanDelayEnabled = await featureFlagService.isEnabled("HUMAN_DELAY_ENABLED");
      let delayResult = null;

      if (humanDelayEnabled) {
        const { computeHumanDelay, getDefaultHumanDelaySettings } = await import("./services/human-delay-engine");
        const delaySettings = await storage.getHumanDelaySettings(tenant.id) || getDefaultHumanDelaySettings(tenant.id);
        
        if (delaySettings.enabled) {
          delayResult = computeHumanDelay({
            messageLength: editedText.length,
            settings: delaySettings,
            tenant: {
              workingHoursStart: tenant.workingHoursStart,
              workingHoursEnd: tenant.workingHoursEnd,
              timezone: tenant.timezone,
            },
          });

          // Handle night mode actions
          if (delayResult.nightModeAction === "DISABLE") {
            return res.status(400).json({ 
              error: "Sending disabled outside working hours",
              delayResult 
            });
          }
        }
      }

      // Update suggestion status
      await storage.updateAiSuggestion(req.params.id, { status: "edited" });

      // Create message with edited text
      const message = await storage.createMessage({
        conversationId: suggestion.conversationId,
        role: "assistant",
        content: editedText,
        attachments: [],
        metadata: { 
          suggestionId: suggestion.id, 
          edited: true,
          delayApplied: delayResult?.delay?.finalDelayMs || 0,
          isNightMode: delayResult?.delay?.isNightMode || false,
          status: "pending",
        },
      });

      // Create human action record
      await storage.createHumanAction({
        suggestionId: suggestion.id,
        action: "edit",
        originalText: suggestion.suggestedReply,
        editedText,
      });

      // Record training sample for ML dataset
      const convMessages = await storage.getMessagesByConversation(suggestion.conversationId);
      const lastCustomerMsg = [...convMessages].reverse().find(m => m.role === "customer");
      if (lastCustomerMsg) {
        await recordTrainingSample({
          suggestion,
          userMessage: lastCustomerMsg.content,
          finalAnswer: editedText,
          outcome: "EDITED",
          tenantId: tenant.id,
        });
      }

      // Add to learning queue if score > 0
      await addToLearningQueue({
        suggestion,
        outcome: "EDITED",
        messageCount: convMessages.length,
        tenantId: tenant.id,
        conversationId: suggestion.conversationId,
      });

      // Phase 2.1: Schedule delayed send if delay enabled, otherwise send immediately
      let scheduledJob = null;
      let sentImmediately = false;
      
      if (humanDelayEnabled && delayResult?.delay?.finalDelayMs) {
        const delaySettings = await storage.getHumanDelaySettings(tenant.id);
        scheduledJob = await scheduleDelayedMessage({
          tenantId: tenant.id,
          conversationId: suggestion.conversationId,
          messageId: message.id,
          suggestionId: suggestion.id,
          channel: "mock",
          text: editedText,
          delayMs: delayResult.delay.finalDelayMs,
          typingEnabled: delaySettings?.typingIndicatorEnabled || false,
        });
        
        // If queue unavailable, mark as sent immediately (fallback)
        if (!scheduledJob) {
          sentImmediately = true;
        }
      } else {
        // No delay - message sent immediately
        sentImmediately = true;
      }

      // Send message to channel - using same logic as manual message sending
      let channelSendResult = null;
      try {
        const conversationDetail = await storage.getConversationDetail(suggestion.conversationId);
        if (conversationDetail) {
          const messages = conversationDetail.messages || [];
          const lastCustomerMsg = messages.filter(m => m.role === "customer").pop();
          
          // Get channel type from customer or message metadata
          let effectiveChannelType = conversationDetail.customer?.channel as string | undefined;
          if (!effectiveChannelType && lastCustomerMsg) {
            effectiveChannelType = (lastCustomerMsg.metadata as any)?.channel;
          }
          if (!effectiveChannelType && conversationDetail.channelId) {
            const channel = await storage.getChannel(conversationDetail.channelId);
            effectiveChannelType = channel?.type;
          }
          
          // Get channel ID from conversation or from message metadata
          const effectiveChannelId = conversationDetail.channelId || (lastCustomerMsg?.metadata as any)?.channelId;
          
          console.log(`[Outbound] Edit - Channel: ${effectiveChannelType}, ChannelId: ${effectiveChannelId}, CustomerExternalId: ${conversationDetail.customer?.externalId}`);
          
          if (effectiveChannelType === "telegram_personal" && conversationDetail.customer && effectiveChannelId) {
            try {
              const { telegramClientManager } = await import("./services/telegram-client-manager");
              const recipientId = conversationDetail.customer.externalId;
              
              console.log(`[Outbound] Sending Telegram message to ${recipientId} via channel ${effectiveChannelId}`);
              
              channelSendResult = await telegramClientManager.sendMessage(
                conversationDetail.tenantId,
                effectiveChannelId,
                recipientId,
                editedText
              );
              
              if (channelSendResult.success) {
                console.log(`[Outbound] Telegram message sent: ${channelSendResult.externalMessageId}`);
              } else {
                console.error(`[Outbound] Telegram send failed: ${channelSendResult.error}`);
              }
            } catch (sendError: any) {
              console.error(`[Outbound] Telegram send error:`, sendError.message);
            }
          } else if (effectiveChannelType === "whatsapp_personal" && conversationDetail.customer) {
            let recipientJid = conversationDetail.customer.externalId;
            if (!recipientJid.includes("@")) {
              recipientJid = `${recipientJid}@s.whatsapp.net`;
            }
            const waAdapter = new WhatsAppPersonalAdapter(tenant.id);
            console.log(`[Outbound] Sending WhatsApp message to ${recipientJid}`);
            channelSendResult = await waAdapter.sendMessage(recipientJid, editedText);
            console.log(`[Outbound] Result:`, channelSendResult);
          }
        }
      } catch (channelError) {
        console.error("[Outbound] Channel send error:", channelError);
      }

      // Phase 0: Audit log
      await auditLog.logSuggestionEdited(suggestion.id, "operator", suggestion.suggestedReply, editedText);
      await auditLog.logMessageSent(message.id, suggestion.conversationId, "operator", "user");

      res.json({ suggestion, message, delayResult, scheduledJob, sentImmediately, channelSendResult });
    } catch (error) {
      console.error("Error editing suggestion:", error);
      res.status(500).json({ error: "Failed to edit suggestion" });
    }
  });

  app.post("/api/suggestions/:id/reject", requireAuth, requirePermission("MANAGE_CONVERSATIONS"), async (req: Request, res: Response) => {
    try {
      const suggestion = await storage.getAiSuggestion(req.params.id);
      if (!suggestion) {
        return res.status(404).json({ error: "Suggestion not found" });
      }

      await storage.updateAiSuggestion(req.params.id, { status: "rejected" });
      await storage.createHumanAction({
        suggestionId: suggestion.id,
        action: "reject",
        originalText: suggestion.suggestedReply,
        reason: req.body.reason,
      });

      // Record training sample for ML dataset
      const tenant = await storage.getDefaultTenant();
      if (tenant) {
        const rejectMessages = await storage.getMessagesByConversation(suggestion.conversationId);
        const lastCustomerMsgReject = [...rejectMessages].reverse().find(m => m.role === "customer");
        if (lastCustomerMsgReject) {
          await recordTrainingSample({
            suggestion,
            userMessage: lastCustomerMsgReject.content,
            finalAnswer: null, // explicitly null for REJECTED
            outcome: "REJECTED",
            tenantId: tenant.id,
            rejectionReason: req.body.reason || null,
          });
        }
        
        // Add to learning queue if score > 0
        await addToLearningQueue({
          suggestion,
          outcome: "REJECTED",
          messageCount: rejectMessages.length,
          tenantId: tenant.id,
          conversationId: suggestion.conversationId,
        });
      }

      // Phase 2.1: Cancel any scheduled messages for this suggestion
      const messages = await storage.getMessagesBySuggestionId?.(suggestion.id);
      if (messages) {
        for (const msg of messages) {
          await cancelDelayedMessage(msg.id, "rejected");
        }
      }

      // Phase 0: Audit log
      await auditLog.logSuggestionRejected(suggestion.id, "operator", req.body.reason);

      res.json({ success: true });
    } catch (error) {
      console.error("Error rejecting suggestion:", error);
      res.status(500).json({ error: "Failed to reject suggestion" });
    }
  });

  app.post("/api/suggestions/:id/escalate", requireAuth, requirePermission("MANAGE_CONVERSATIONS"), async (req: Request, res: Response) => {
    try {
      const suggestion = await storage.getAiSuggestion(req.params.id);
      if (!suggestion) {
        return res.status(404).json({ error: "Suggestion not found" });
      }

      // Update suggestion status
      await storage.updateAiSuggestion(req.params.id, { status: "rejected" });

      // Update conversation status
      await storage.updateConversation(suggestion.conversationId, { status: "escalated" });

      // Phase 2.1: Cancel any scheduled messages for this suggestion
      const messages = await storage.getMessagesBySuggestionId?.(suggestion.id);
      if (messages) {
        for (const msg of messages) {
          await cancelDelayedMessage(msg.id, "escalated");
        }
      }

      // Create escalation event
      const escalation = await storage.createEscalationEvent({
        conversationId: suggestion.conversationId,
        reason: suggestion.intent || "manual_escalation",
        summary: `AI suggestion escalated for review. Intent: ${suggestion.intent}`,
        suggestedResponse: suggestion.suggestedReply,
        clarificationNeeded: suggestion.questionsToAsk?.join(", ") || null,
        status: "pending",
      });

      // Create human action record
      await storage.createHumanAction({
        suggestionId: suggestion.id,
        action: "escalate",
        originalText: suggestion.suggestedReply,
      });

      // Phase 0: Audit log
      await auditLog.logConversationEscalated(
        suggestion.conversationId,
        escalation.id,
        suggestion.intent || "manual_escalation",
        "operator"
      );

      res.json({ escalation });
    } catch (error) {
      console.error("Error escalating suggestion:", error);
      res.status(500).json({ error: "Failed to escalate" });
    }
  });

  // ============ PHASE 1: DECISION SETTINGS ROUTES ============

  app.get("/api/settings/decision", requireAuth, requirePermission("VIEW_CONVERSATIONS"), async (req: Request, res: Response) => {
    try {
      const tenant = await storage.getDefaultTenant();
      if (!tenant) {
        return res.status(404).json({ error: "Tenant not found" });
      }
      
      const settings = await storage.getDecisionSettings(tenant.id);
      
      // Return defaults if no settings exist
      const { DEFAULT_SETTINGS } = await import("./services/decision-engine");
      res.json(settings || { ...DEFAULT_SETTINGS, tenantId: tenant.id });
    } catch (error) {
      console.error("Error fetching decision settings:", error);
      res.status(500).json({ error: "Failed to fetch decision settings" });
    }
  });

  app.patch("/api/settings/decision", requireAuth, requirePermission("MANAGE_AUTOSEND"), async (req: Request, res: Response) => {
    try {
      const tenant = await storage.getDefaultTenant();
      if (!tenant) {
        return res.status(404).json({ error: "Tenant not found" });
      }

      const { tAuto, tEscalate, autosendAllowed, intentsAutosendAllowed, intentsForceHandoff } = req.body;

      // Validate thresholds
      if (tAuto !== undefined && (tAuto < 0 || tAuto > 1)) {
        return res.status(400).json({ error: "tAuto must be between 0 and 1" });
      }
      if (tEscalate !== undefined && (tEscalate < 0 || tEscalate > 1)) {
        return res.status(400).json({ error: "tEscalate must be between 0 and 1" });
      }
      if (tAuto !== undefined && tEscalate !== undefined && tAuto < tEscalate) {
        return res.status(400).json({ error: "tAuto must be greater than or equal to tEscalate" });
      }

      // Phase 7.3: Readiness gating for autosend
      if (autosendAllowed === true) {
        const { calculateReadinessScore, READINESS_THRESHOLD } = await import("./services/readiness-score-service");
        const { isFeatureEnabled } = await import("./services/feature-flags");
        
        const result = await calculateReadinessScore(
          tenant.id,
          storage,
          (flag: string) => isFeatureEnabled(flag)
        );

        if (result.score < READINESS_THRESHOLD) {
          auditLog.setContext({ tenantId: tenant.id });
          await auditLog.log(
            "settings_updated" as any,
            "tenant",
            tenant.id,
            req.userId || "system",
            req.userId ? "user" : "system",
            { action: "autosend_blocked_readiness", score: result.score, threshold: READINESS_THRESHOLD }
          );

          return res.status(409).json({
            error: "Readiness score too low",
            message: `Невозможно включить автоотправку. Текущий показатель готовности: ${result.score}%, требуется: ${READINESS_THRESHOLD}%`,
            score: result.score,
            threshold: READINESS_THRESHOLD,
            recommendations: result.recommendations,
          });
        }
      }

      const updated = await storage.upsertDecisionSettings({
        tenantId: tenant.id,
        tAuto,
        tEscalate,
        autosendAllowed,
        intentsAutosendAllowed,
        intentsForceHandoff,
      });

      res.json(updated);
    } catch (error) {
      console.error("Error updating decision settings:", error);
      res.status(500).json({ error: "Failed to update decision settings" });
    }
  });

  // ============ PHASE 2: HUMAN DELAY SETTINGS ROUTES ============

  app.get("/api/settings/human-delay", requireAuth, requirePermission("VIEW_CONVERSATIONS"), async (req: Request, res: Response) => {
    try {
      const tenant = await storage.getDefaultTenant();
      if (!tenant) {
        return res.status(404).json({ error: "Tenant not found" });
      }
      
      const settings = await storage.getHumanDelaySettings(tenant.id);
      const { getDefaultHumanDelaySettings } = await import("./services/human-delay-engine");
      res.json(settings || getDefaultHumanDelaySettings(tenant.id));
    } catch (error) {
      console.error("Error fetching human delay settings:", error);
      res.status(500).json({ error: "Failed to fetch human delay settings" });
    }
  });

  const humanDelaySettingsValidation = z.object({
    enabled: z.boolean().optional(),
    delayProfiles: z.record(z.string(), z.object({
      baseMin: z.number().min(0),
      baseMax: z.number().min(0),
      typingSpeed: z.number().min(1),
      jitter: z.number().min(0),
    })).optional(),
    nightMode: z.enum(["AUTO_REPLY", "DELAY", "DISABLE"]).optional(),
    nightDelayMultiplier: z.number().min(1).max(10).optional(),
    nightAutoReplyText: z.string().optional(),
    minDelayMs: z.number().min(0).optional(),
    maxDelayMs: z.number().min(0).optional(),
    typingIndicatorEnabled: z.boolean().optional(),
  }).refine((data) => {
    if (data.minDelayMs !== undefined && data.maxDelayMs !== undefined) {
      return data.minDelayMs <= data.maxDelayMs;
    }
    return true;
  }, { message: "minDelayMs must be <= maxDelayMs" });

  app.patch("/api/settings/human-delay", requireAuth, requirePermission("MANAGE_AUTOSEND"), async (req: Request, res: Response) => {
    try {
      const tenant = await storage.getDefaultTenant();
      if (!tenant) {
        return res.status(404).json({ error: "Tenant not found" });
      }

      const parseResult = humanDelaySettingsValidation.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ 
          error: parseResult.error.errors[0]?.message || "Invalid request body" 
        });
      }

      const { 
        enabled, 
        delayProfiles, 
        nightMode, 
        nightDelayMultiplier,
        nightAutoReplyText,
        minDelayMs,
        maxDelayMs,
        typingIndicatorEnabled
      } = parseResult.data;

      const updated = await storage.upsertHumanDelaySettings({
        tenantId: tenant.id,
        enabled,
        delayProfiles,
        nightMode,
        nightDelayMultiplier,
        nightAutoReplyText,
        minDelayMs,
        maxDelayMs,
        typingIndicatorEnabled,
      });

      res.json(updated);
    } catch (error) {
      console.error("Error updating human delay settings:", error);
      res.status(500).json({ error: "Failed to update human delay settings" });
    }
  });

  // ============ PHASE 2.1: DELAYED JOBS ADMIN ROUTES ============

  app.get("/api/admin/delayed-jobs", requireAuth, requirePermission("VIEW_AUDIT_LOGS"), async (req: Request, res: Response) => {
    try {
      const jobs = await getDelayedJobs();
      const metrics = getQueueMetrics();
      res.json({ jobs, metrics });
    } catch (error) {
      console.error("Error fetching delayed jobs:", error);
      res.status(500).json({ error: "Failed to fetch delayed jobs" });
    }
  });

  // ============ RAG EMBEDDINGS ADMIN ROUTES ============

  app.post("/api/admin/rag/regenerate-embeddings", requireAuth, requirePermission("MANAGE_KNOWLEDGE_BASE"), async (req: Request, res: Response) => {
    try {
      const { embeddingService } = await import("./services/embedding-service");
      const pLimit = (await import("p-limit")).default;
      
      if (!embeddingService.isAvailable()) {
        return res.status(503).json({ error: "Embedding service not available - OPENAI_API_KEY not set" });
      }

      const isRagEnabled = await featureFlagService.isEnabled("RAG_ENABLED");
      if (!isRagEnabled) {
        return res.status(403).json({ error: "RAG feature is disabled" });
      }

      const tenant = await storage.getDefaultTenant();
      if (!tenant) {
        return res.status(404).json({ error: "Tenant not found" });
      }

      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const batchSize = Math.min(parseInt(req.query.batchSize as string) || 10, 50);
      const concurrency = Math.min(parseInt(req.query.concurrency as string) || 3, 5);
      const includeStale = req.query.includeStale === "true";

      let chunks = await storage.getRagChunksWithoutEmbedding(tenant.id, limit);
      
      if (includeStale) {
        const staleResult = await storage.invalidateStaleEmbeddings(tenant.id);
        if (staleResult.invalidated > 0) {
          console.log(`[RAG] Invalidated ${staleResult.invalidated} stale embeddings`);
          const additionalChunks = await storage.getRagChunksWithoutEmbedding(tenant.id, limit);
          chunks = additionalChunks;
        }
      }
      
      if (chunks.length === 0) {
        return res.json({ processed: 0, failed: 0, total: 0, message: "No chunks need embedding" });
      }

      let processed = 0;
      let failed = 0;
      const rateLimiter = pLimit(concurrency);

      const batches: typeof chunks[] = [];
      for (let i = 0; i < chunks.length; i += batchSize) {
        batches.push(chunks.slice(i, i + batchSize));
      }

      console.log(`[RAG] Processing ${chunks.length} chunks in ${batches.length} batches (concurrency: ${concurrency})`);

      for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex];
        
        const results = await Promise.all(
          batch.map(chunk => 
            rateLimiter(async () => {
              try {
                const result = await embeddingService.createEmbedding(chunk.chunkText);
                if (result) {
                  const updated = await storage.updateRagChunkEmbedding(chunk.id, result.embedding);
                  return updated ? "success" : "failed";
                }
                return "failed";
              } catch (err) {
                console.error(`[RAG] Embedding error for chunk ${chunk.id}:`, err);
                return "failed";
              }
            })
          )
        );

        processed += results.filter(r => r === "success").length;
        failed += results.filter(r => r === "failed").length;
        
        console.log(`[RAG] Batch ${batchIndex + 1}/${batches.length}: ${results.filter(r => r === "success").length} success, ${results.filter(r => r === "failed").length} failed`);

        if (batchIndex < batches.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }

      res.json({ 
        processed, 
        failed, 
        total: chunks.length,
        batches: batches.length,
        config: { batchSize, concurrency, includeStale }
      });
    } catch (error) {
      console.error("Error regenerating embeddings:", error);
      res.status(500).json({ error: "Failed to regenerate embeddings" });
    }
  });

  app.get("/api/admin/rag/status", requireAuth, requirePermission("MANAGE_KNOWLEDGE_BASE"), async (req: Request, res: Response) => {
    try {
      const { embeddingService } = await import("./services/embedding-service");
      
      const isRagEnabled = await featureFlagService.isEnabled("RAG_ENABLED");
      const isServiceAvailable = embeddingService.isAvailable();

      const tenant = await storage.getDefaultTenant();
      let pendingChunks = 0;
      let staleChunks = 0;
      
      if (tenant) {
        const pending = await storage.getRagChunksWithoutEmbedding(tenant.id, 1000);
        pendingChunks = pending.length;
        
        const stale = await storage.getRagChunksWithStaleHash(tenant.id, 1000);
        staleChunks = stale.length;
      }

      res.json({
        ragEnabled: isRagEnabled,
        embeddingServiceAvailable: isServiceAvailable,
        model: embeddingService.MODEL,
        dimensions: embeddingService.DIMENSIONS,
        pendingChunks,
        staleChunks,
      });
    } catch (error) {
      console.error("Error fetching RAG status:", error);
      res.status(500).json({ error: "Failed to fetch RAG status" });
    }
  });

  app.post("/api/admin/rag/invalidate-stale", requireAuth, requirePermission("MANAGE_KNOWLEDGE_BASE"), async (req: Request, res: Response) => {
    try {
      const isRagEnabled = await featureFlagService.isEnabled("RAG_ENABLED");
      if (!isRagEnabled) {
        return res.status(403).json({ error: "RAG feature is disabled" });
      }

      const tenant = await storage.getDefaultTenant();
      if (!tenant) {
        return res.status(404).json({ error: "Tenant not found" });
      }

      const result = await storage.invalidateStaleEmbeddings(tenant.id);
      console.log(`[RAG] Invalidated ${result.invalidated} stale embeddings`);

      res.json(result);
    } catch (error) {
      console.error("Error invalidating stale embeddings:", error);
      res.status(500).json({ error: "Failed to invalidate stale embeddings" });
    }
  });

  // ============ TRAINING SAMPLES ROUTES ============

  app.get("/api/admin/training-samples", requireAuth, requirePermission("MANAGE_TRAINING"), async (req: Request, res: Response) => {
    try {
      // Tenant isolation: get tenant from authenticated user context
      let tenantId: string;
      if (req.userId && req.userId !== "system") {
        const user = await storage.getUser(req.userId);
        if (user?.tenantId) {
          tenantId = user.tenantId;
        } else {
          // Fallback to default tenant for users without explicit tenantId
          const tenant = await storage.getDefaultTenant();
          if (!tenant) {
            return res.status(404).json({ error: "Tenant not found" });
          }
          tenantId = tenant.id;
        }
      } else {
        const tenant = await storage.getDefaultTenant();
        if (!tenant) {
          return res.status(404).json({ error: "Tenant not found" });
        }
        tenantId = tenant.id;
      }
      
      const outcome = req.query.outcome as TrainingOutcome | undefined;
      const samples = await getTrainingSamples(tenantId, outcome);
      res.json(samples);
    } catch (error) {
      console.error("Error fetching training samples:", error);
      res.status(500).json({ error: "Failed to fetch training samples" });
    }
  });

  app.post("/api/admin/training-samples/export", requireAuth, requirePermission("EXPORT_TRAINING_DATA"), async (req: Request, res: Response) => {
    try {
      // Tenant isolation: get tenant from authenticated user context
      let tenantId: string;
      if (req.userId && req.userId !== "system") {
        const user = await storage.getUser(req.userId);
        if (user?.tenantId) {
          tenantId = user.tenantId;
        } else {
          const tenant = await storage.getDefaultTenant();
          if (!tenant) {
            return res.status(404).json({ error: "Tenant not found" });
          }
          tenantId = tenant.id;
        }
      } else {
        const tenant = await storage.getDefaultTenant();
        if (!tenant) {
          return res.status(404).json({ error: "Tenant not found" });
        }
        tenantId = tenant.id;
      }
      
      const outcome = req.body.outcome as TrainingOutcome | undefined;
      const exportData = await exportTrainingSamples(tenantId, outcome);
      res.json(exportData);
    } catch (error) {
      console.error("Error exporting training samples:", error);
      res.status(500).json({ error: "Failed to export training samples" });
    }
  });

  // ============ TRAINING POLICIES ROUTES ============

  app.get("/api/admin/training-policies", requireAuth, requirePermission("MANAGE_POLICIES"), async (req: Request, res: Response) => {
    try {
      if (!req.userId || req.userId === "system") {
        return res.status(403).json({ error: "User authentication required" });
      }
      const user = await storage.getUser(req.userId);
      if (!user?.tenantId) {
        return res.status(403).json({ error: "User not associated with a tenant" });
      }
      const tenantId = user.tenantId;

      const policy = await storage.getAiTrainingPolicy(tenantId);
      if (!policy) {
        return res.json({
          tenantId,
          alwaysEscalateIntents: [],
          forbiddenTopics: [],
          disabledLearningIntents: [],
          updatedAt: new Date(),
        });
      }
      res.json(policy);
    } catch (error) {
      console.error("Error fetching training policy:", error);
      res.status(500).json({ error: "Failed to fetch training policy" });
    }
  });

  app.put("/api/admin/training-policies", requireAuth, requirePermission("MANAGE_POLICIES"), async (req: Request, res: Response) => {
    try {
      if (!req.userId || req.userId === "system") {
        return res.status(403).json({ error: "User authentication required" });
      }
      const user = await storage.getUser(req.userId);
      if (!user?.tenantId) {
        return res.status(403).json({ error: "User not associated with a tenant" });
      }
      const tenantId = user.tenantId;

      const { alwaysEscalateIntents, forbiddenTopics, disabledLearningIntents } = req.body;
      
      // Validate intent arrays contain only valid intents
      const validIntentSet = new Set(VALID_INTENTS);
      const validateIntents = (intents: unknown[], fieldName: string): string[] | null => {
        if (!Array.isArray(intents)) return [];
        if (intents.length > TRAINING_POLICY_LIMITS.maxIntentsListSize) {
          return null; // exceeds limit
        }
        const filtered = intents.filter((i): i is string => 
          typeof i === "string" && validIntentSet.has(i as any)
        );
        return filtered;
      };

      const validatedAlwaysEscalate = validateIntents(alwaysEscalateIntents ?? [], "alwaysEscalateIntents");
      const validatedDisabledLearning = validateIntents(disabledLearningIntents ?? [], "disabledLearningIntents");
      
      if (validatedAlwaysEscalate === null) {
        return res.status(400).json({ error: `alwaysEscalateIntents exceeds maximum of ${TRAINING_POLICY_LIMITS.maxIntentsListSize} items` });
      }
      if (validatedDisabledLearning === null) {
        return res.status(400).json({ error: `disabledLearningIntents exceeds maximum of ${TRAINING_POLICY_LIMITS.maxIntentsListSize} items` });
      }

      // Validate forbiddenTopics
      let validatedForbiddenTopics: string[] = [];
      if (Array.isArray(forbiddenTopics)) {
        if (forbiddenTopics.length > TRAINING_POLICY_LIMITS.maxForbiddenTopicsSize) {
          return res.status(400).json({ error: `forbiddenTopics exceeds maximum of ${TRAINING_POLICY_LIMITS.maxForbiddenTopicsSize} items` });
        }
        validatedForbiddenTopics = forbiddenTopics
          .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
          .map(t => t.trim().slice(0, TRAINING_POLICY_LIMITS.maxTopicLength));
      }

      const policy = await storage.upsertAiTrainingPolicy({
        tenantId,
        alwaysEscalateIntents: validatedAlwaysEscalate,
        forbiddenTopics: validatedForbiddenTopics,
        disabledLearningIntents: validatedDisabledLearning,
      });
      res.json(policy);
    } catch (error) {
      console.error("Error updating training policy:", error);
      res.status(500).json({ error: "Failed to update training policy" });
    }
  });

  // ============ LEARNING QUEUE ROUTES ============

  app.get("/api/admin/learning-queue", requireAuth, requirePermission("MANAGE_TRAINING"), async (req: Request, res: Response) => {
    try {
      if (!req.userId || req.userId === "system") {
        return res.status(403).json({ error: "User authentication required" });
      }
      const user = await storage.getUser(req.userId);
      if (!user?.tenantId) {
        return res.status(403).json({ error: "User not associated with a tenant" });
      }
      const tenantId = user.tenantId;

      const minScore = req.query.minScore ? parseInt(req.query.minScore as string, 10) : undefined;
      const items = await storage.getLearningQueueByTenant(tenantId, minScore);
      
      res.json({
        items,
        total: items.length,
        minScore: minScore ?? 0,
      });
    } catch (error) {
      console.error("Error fetching learning queue:", error);
      res.status(500).json({ error: "Failed to fetch learning queue" });
    }
  });

  app.patch("/api/admin/learning-queue/:conversationId/review", requireAuth, requirePermission("MANAGE_TRAINING"), async (req: Request, res: Response) => {
    try {
      if (!req.userId || req.userId === "system") {
        return res.status(403).json({ error: "User authentication required" });
      }
      
      const user = await storage.getUser(req.userId);
      if (!user?.tenantId) {
        return res.status(403).json({ error: "User not associated with a tenant" });
      }
      
      const item = await storage.getLearningQueueItem(req.params.conversationId);
      if (!item) {
        return res.status(404).json({ error: "Learning queue item not found" });
      }
      
      // Tenant isolation check
      if (item.tenantId !== user.tenantId) {
        return res.status(403).json({ error: "Access denied" });
      }

      const updated = await storage.updateLearningQueueItem(item.id, {
        status: "reviewed",
        reviewedBy: req.userId,
      });
      
      res.json(updated);
    } catch (error) {
      console.error("Error updating learning queue item:", error);
      res.status(500).json({ error: "Failed to update learning queue item" });
    }
  });

  // ============ ONBOARDING ROUTES ============
  
  const ONBOARDING_STEPS = ["BUSINESS", "CHANNELS", "PRODUCTS", "POLICIES", "KB", "REVIEW", "DONE"] as const;
  type OnboardingStep = typeof ONBOARDING_STEPS[number];
  
  const ONBOARDING_STATUSES = ["NOT_STARTED", "IN_PROGRESS", "DONE"] as const;
  type OnboardingStatus = typeof ONBOARDING_STATUSES[number];

  // Helper to get user by OIDC ID or regular ID
  async function getUserByIdOrOidcId(userId: string) {
    let user = await storage.getUserByOidcId(userId);
    if (!user) {
      user = await storage.getUser(userId);
    }
    return user;
  }

  // GET /api/onboarding/state - get current onboarding state
  app.get("/api/onboarding/state", requireAuth, requirePermission("VIEW_CONVERSATIONS"), async (req: Request, res: Response) => {
    try {
      if (!req.userId || req.userId === "system") {
        return res.status(403).json({ error: "User authentication required" });
      }
      const user = await getUserByIdOrOidcId(req.userId);
      if (!user?.tenantId) {
        return res.status(403).json({ error: "User not associated with a tenant" });
      }
      
      // Check role: operator+ can access
      if (!user.role || !["operator", "admin", "owner"].includes(user.role)) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }

      let state = await storage.getOnboardingState(user.tenantId);
      
      // Return default state if not exists
      if (!state) {
        state = {
          tenantId: user.tenantId,
          status: "NOT_STARTED",
          currentStep: "BUSINESS",
          completedSteps: [],
          answers: {},
          updatedAt: new Date(),
        };
      }
      
      res.json({
        ...state,
        steps: ONBOARDING_STEPS,
        totalSteps: ONBOARDING_STEPS.length - 1, // exclude DONE
      });
    } catch (error) {
      console.error("Error fetching onboarding state:", error);
      res.status(500).json({ error: "Failed to fetch onboarding state" });
    }
  });

  // PUT /api/onboarding/state - update onboarding state
  app.put("/api/onboarding/state", requireAuth, async (req: Request, res: Response) => {
    try {
      if (!req.userId || req.userId === "system") {
        return res.status(403).json({ error: "User authentication required" });
      }
      const user = await getUserByIdOrOidcId(req.userId);
      if (!user?.tenantId) {
        return res.status(403).json({ error: "User not associated with a tenant" });
      }
      
      // Check role: operator+ can access
      if (!user.role || !["operator", "admin", "owner"].includes(user.role)) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }

      const { status, currentStep, completedSteps, answers } = req.body;
      
      // Validate status
      if (status && !ONBOARDING_STATUSES.includes(status)) {
        return res.status(400).json({ error: `Invalid status: ${status}` });
      }
      
      // Validate currentStep
      if (currentStep && !ONBOARDING_STEPS.includes(currentStep)) {
        return res.status(400).json({ error: `Invalid step: ${currentStep}` });
      }
      
      // Validate completedSteps
      if (completedSteps && !Array.isArray(completedSteps)) {
        return res.status(400).json({ error: "completedSteps must be an array" });
      }
      if (completedSteps) {
        for (const step of completedSteps) {
          if (!ONBOARDING_STEPS.includes(step)) {
            return res.status(400).json({ error: `Invalid step in completedSteps: ${step}` });
          }
        }
      }

      const state = await storage.upsertOnboardingState({
        tenantId: user.tenantId,
        status,
        currentStep,
        completedSteps,
        answers,
      });

      // Audit log
      auditLog.setContext({ tenantId: user.tenantId });
      await auditLog.log(
        "settings_updated" as any,
        "tenant",
        user.tenantId,
        req.userId,
        "user",
        { action: "onboarding_state_updated", status, currentStep, completedStepsCount: completedSteps?.length ?? 0 }
      );
      
      res.json(state);
    } catch (error) {
      console.error("Error updating onboarding state:", error);
      res.status(500).json({ error: "Failed to update onboarding state" });
    }
  });

  // POST /api/onboarding/complete-step - complete a step and advance
  app.post("/api/onboarding/complete-step", requireAuth, requirePermission("MANAGE_TENANT_SETTINGS"), async (req: Request, res: Response) => {
    try {
      if (!req.userId || req.userId === "system") {
        return res.status(403).json({ error: "User authentication required" });
      }
      const user = await getUserByIdOrOidcId(req.userId);
      if (!user?.tenantId) {
        return res.status(403).json({ error: "User not associated with a tenant" });
      }
      
      // Check role: operator+ can access
      if (!user.role || !["operator", "admin", "owner"].includes(user.role)) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }

      const { step, answers: stepAnswers } = req.body;
      
      if (!step || !ONBOARDING_STEPS.includes(step)) {
        return res.status(400).json({ error: `Invalid step: ${step}` });
      }

      // Get current state
      let currentState = await storage.getOnboardingState(user.tenantId);
      if (!currentState) {
        currentState = {
          tenantId: user.tenantId,
          status: "NOT_STARTED",
          currentStep: "BUSINESS",
          completedSteps: [],
          answers: {},
          updatedAt: new Date(),
        };
      }

      // Mark step as completed (deduplicate)
      const stepsSet = new Set(currentState.completedSteps ?? []);
      stepsSet.add(step);
      const completedSteps = Array.from(stepsSet);
      
      // Merge answers
      const answers = {
        ...(currentState.answers ?? {}),
        [step]: stepAnswers,
      };
      
      // Determine next step
      const currentIndex = ONBOARDING_STEPS.indexOf(step as OnboardingStep);
      const nextStep = currentIndex < ONBOARDING_STEPS.length - 1 
        ? ONBOARDING_STEPS[currentIndex + 1] 
        : "DONE";
      
      // Determine status
      const status: OnboardingStatus = nextStep === "DONE" ? "DONE" : "IN_PROGRESS";

      const state = await storage.upsertOnboardingState({
        tenantId: user.tenantId,
        status,
        currentStep: nextStep,
        completedSteps,
        answers,
      });

      // Audit log
      auditLog.setContext({ tenantId: user.tenantId });
      await auditLog.log(
        "settings_updated" as any,
        "tenant",
        user.tenantId,
        req.userId,
        "user",
        { action: "onboarding_step_completed", completedStep: step, nextStep, status }
      );
      
      res.json({
        ...state,
        completedStep: step,
        nextStep,
      });
    } catch (error) {
      console.error("Error completing onboarding step:", error);
      res.status(500).json({ error: "Failed to complete onboarding step" });
    }
  });

  // POST /api/onboarding/generate-templates - generate KB templates
  app.post("/api/onboarding/generate-templates", requireAuth, requirePermission("MANAGE_TENANT_SETTINGS"), onboardingRateLimiter, async (req: Request, res: Response) => {
    try {
      if (!req.userId || req.userId === "system") {
        return res.status(403).json({ error: "User authentication required" });
      }
      const user = await getUserByIdOrOidcId(req.userId);
      if (!user?.tenantId) {
        return res.status(403).json({ error: "User not associated with a tenant" });
      }
      
      if (!user.role || !["operator", "admin", "owner"].includes(user.role)) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }

      const { generateTemplates, templateOptionsSchema } = await import("./services/onboarding-templates");
      
      const optionsResult = templateOptionsSchema.safeParse(req.body.options || {});
      if (!optionsResult.success) {
        return res.status(400).json({ error: "Invalid options", details: optionsResult.error.errors });
      }
      const options = optionsResult.data;

      const answers = req.body.answers || {};
      const businessInfo = answers.BUSINESS || {};
      const policiesInfo = answers.POLICIES || {};

      const input = {
        businessName: businessInfo.name || "Магазин",
        businessDescription: businessInfo.description,
        categories: businessInfo.categories,
        deliveryInfo: policiesInfo.delivery,
        returnsInfo: policiesInfo.returns,
        paymentInfo: policiesInfo.payment,
        discountInfo: policiesInfo.discount,
      };

      const drafts = await generateTemplates(input, options);

      auditLog.setContext({ tenantId: user.tenantId });
      await auditLog.log(
        "settings_updated" as any,
        "tenant",
        user.tenantId,
        req.userId,
        "user",
        { action: "templates_generated", count: drafts.length, types: drafts.map(d => d.docType) }
      );

      res.json({ drafts });
    } catch (error) {
      console.error("Error generating templates:", error);
      res.status(500).json({ error: "Failed to generate templates" });
    }
  });

  // POST /api/onboarding/apply-templates - apply templates to KB
  app.post("/api/onboarding/apply-templates", requireAuth, requirePermission("MANAGE_TENANT_SETTINGS"), async (req: Request, res: Response) => {
    try {
      if (!req.userId || req.userId === "system") {
        return res.status(403).json({ error: "User authentication required" });
      }
      const user = await getUserByIdOrOidcId(req.userId);
      if (!user?.tenantId) {
        return res.status(403).json({ error: "User not associated with a tenant" });
      }
      
      if (!user.role || !["operator", "admin", "owner"].includes(user.role)) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }

      const { applyDraftsSchema } = await import("./services/onboarding-templates");
      const { indexDocument } = await import("./services/rag-indexer");
      
      const result = applyDraftsSchema.safeParse(req.body);
      if (!result.success) {
        return res.status(400).json({ error: "Invalid drafts", details: result.error.errors });
      }

      const { drafts } = result.data;
      const createdDocs: any[] = [];
      const ragEnabled = process.env.RAG_ENABLED === "true" && process.env.OPENAI_API_KEY;

      for (const draft of drafts) {
        const knowledgeDoc = await storage.createKnowledgeDoc({
          tenantId: user.tenantId,
          title: draft.title,
          content: draft.content,
          docType: draft.docType,
          category: draft.docType,
          tags: ["onboarding", "auto-generated"],
          isActive: true,
        });
        createdDocs.push(knowledgeDoc);

        if (ragEnabled) {
          try {
            const ragResult = indexDocument(knowledgeDoc);
            const ragDoc = await storage.createRagDocument(ragResult.ragDocument);
            
            for (const chunk of ragResult.chunks) {
              await storage.createRagChunk({
                ragDocumentId: ragDoc.id,
                chunkText: chunk.chunkText,
                chunkIndex: chunk.chunkIndex,
                tokenCount: chunk.tokenCount,
                metadata: chunk.metadata,
              });
            }
          } catch (ragError) {
            console.error(`Error indexing document ${knowledgeDoc.id}:`, ragError);
          }
        }
      }

      auditLog.setContext({ tenantId: user.tenantId });
      await auditLog.log(
        "settings_updated" as any,
        "tenant",
        user.tenantId,
        req.userId,
        "user",
        { action: "templates_applied", count: createdDocs.length, docIds: createdDocs.map(d => d.id) }
      );

      res.json({ 
        success: true, 
        createdDocs: createdDocs.length,
        ragEnabled,
        documents: createdDocs.map(d => ({ id: d.id, title: d.title, docType: d.docType })),
      });
    } catch (error) {
      console.error("Error applying templates:", error);
      res.status(500).json({ error: "Failed to apply templates" });
    }
  });

  // GET /api/onboarding/readiness - calculate readiness score
  app.get("/api/onboarding/readiness", requireAuth, requirePermission("VIEW_CONVERSATIONS"), async (req: Request, res: Response) => {
    try {
      if (!req.userId || req.userId === "system") {
        return res.status(403).json({ error: "User authentication required" });
      }
      const user = await getUserByIdOrOidcId(req.userId);
      if (!user?.tenantId) {
        return res.status(403).json({ error: "User not associated with a tenant" });
      }
      
      if (!user.role || !["operator", "admin", "owner"].includes(user.role)) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }

      const { calculateReadinessScore, READINESS_THRESHOLD } = await import("./services/readiness-score-service");
      const { isFeatureEnabled } = await import("./services/feature-flags");

      const result = await calculateReadinessScore(
        user.tenantId,
        storage,
        (flag: string) => isFeatureEnabled(flag)
      );

      await storage.createReadinessReport({
        tenantId: user.tenantId,
        score: result.score,
        checks: result.checks,
        recommendations: result.recommendations,
      });

      auditLog.setContext({ tenantId: user.tenantId });
      await auditLog.log(
        "settings_updated" as any,
        "tenant",
        user.tenantId,
        req.userId,
        "user",
        { action: "readiness_calculated", score: result.score, threshold: READINESS_THRESHOLD }
      );

      res.json({
        score: result.score,
        checks: result.checks,
        recommendations: result.recommendations,
        threshold: READINESS_THRESHOLD,
        ready: result.score >= READINESS_THRESHOLD,
      });
    } catch (error) {
      console.error("Error calculating readiness:", error);
      res.status(500).json({ error: "Failed to calculate readiness" });
    }
  });

  // GET /api/onboarding/run-smoke-test/stream - run smoke test with SSE progress
  app.get("/api/onboarding/run-smoke-test/stream", requireAuth, requirePermission("VIEW_CONVERSATIONS"), onboardingRateLimiter, async (req: Request, res: Response) => {
    try {
      if (!req.userId || req.userId === "system") {
        return res.status(403).json({ error: "User authentication required" });
      }
      const user = await getUserByIdOrOidcId(req.userId);
      if (!user?.tenantId) {
        return res.status(403).json({ error: "User not associated with a tenant" });
      }
      
      if (!user.role || !["operator", "admin", "owner"].includes(user.role)) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      const { runSmokeTest } = await import("./services/smoke-test-service");
      
      const result = await runSmokeTest(user.tenantId, (progress) => {
        res.write(`data: ${JSON.stringify({ type: "progress", ...progress })}\n\n`);
      });

      auditLog.setContext({ tenantId: user.tenantId });
      await auditLog.log(
        "settings_updated" as any,
        "tenant",
        user.tenantId,
        req.userId,
        "user",
        { 
          action: "smoke_test_run", 
          passedCount: result.passedCount, 
          totalCount: result.totalCount,
          checkStatus: result.check.status,
        }
      );

      res.write(`data: ${JSON.stringify({ 
        type: "complete",
        results: result.results,
        passedCount: result.passedCount,
        totalCount: result.totalCount,
        check: result.check,
        recommendations: result.recommendations,
      })}\n\n`);
      
      res.end();
    } catch (error) {
      console.error("Error running smoke test:", error);
      res.write(`data: ${JSON.stringify({ type: "error", error: "Failed to run smoke test" })}\n\n`);
      res.end();
    }
  });

  // POST /api/onboarding/run-smoke-test - run smoke test for AI validation (non-streaming fallback)
  app.post("/api/onboarding/run-smoke-test", requireAuth, requirePermission("VIEW_CONVERSATIONS"), onboardingRateLimiter, async (req: Request, res: Response) => {
    try {
      if (!req.userId || req.userId === "system") {
        return res.status(403).json({ error: "User authentication required" });
      }
      const user = await getUserByIdOrOidcId(req.userId);
      if (!user?.tenantId) {
        return res.status(403).json({ error: "User not associated with a tenant" });
      }
      
      if (!user.role || !["operator", "admin", "owner"].includes(user.role)) {
        return res.status(403).json({ error: "Insufficient permissions" });
      }

      const { runSmokeTest } = await import("./services/smoke-test-service");
      const result = await runSmokeTest(user.tenantId);

      auditLog.setContext({ tenantId: user.tenantId });
      await auditLog.log(
        "settings_updated" as any,
        "tenant",
        user.tenantId,
        req.userId,
        "user",
        { 
          action: "smoke_test_run", 
          passedCount: result.passedCount, 
          totalCount: result.totalCount,
          checkStatus: result.check.status,
        }
      );

      res.json({
        results: result.results,
        passedCount: result.passedCount,
        totalCount: result.totalCount,
        check: result.check,
        recommendations: result.recommendations,
      });
    } catch (error) {
      console.error("Error running smoke test:", error);
      res.status(500).json({ error: "Failed to run smoke test" });
    }
  });

  // ============ PHASE 8: CSAT ROUTES ============

  // POST /api/conversations/:id/csat - submit CSAT rating
  app.post("/api/conversations/:id/csat", requireAuth, requirePermission("MANAGE_CONVERSATIONS"), async (req: Request, res: Response) => {
    try {
      if (!req.userId || req.userId === "system") {
        return res.status(403).json({ error: "User authentication required" });
      }
      const user = await getUserByIdOrOidcId(req.userId);
      if (!user?.tenantId) {
        return res.status(403).json({ error: "User not associated with a tenant" });
      }

      const conversationId = req.params.id;
      const { rating, comment } = req.body;

      if (!rating || rating < 1 || rating > 5) {
        return res.status(400).json({ error: "Rating must be between 1 and 5" });
      }

      const conversation = await storage.getConversationWithCustomer(conversationId);
      if (!conversation) {
        return res.status(404).json({ error: "Conversation not found" });
      }

      if (conversation.tenantId !== user.tenantId) {
        return res.status(403).json({ error: "Access denied" });
      }

      const messages = await storage.getMessagesByConversation(conversationId);
      const lastAiSuggestion = messages
        .filter(m => m.suggestionId)
        .map(m => m.suggestionId)
        .pop();

      let intent: string | null = null;
      let decision: string | null = null;

      if (lastAiSuggestion) {
        const suggestion = await storage.getAiSuggestion(lastAiSuggestion);
        if (suggestion) {
          intent = suggestion.intent || null;
          decision = suggestion.decision || null;
        }
      }

      const { submitCsatRating } = await import("./services/csat-service");
      const result = await submitCsatRating({
        tenantId: user.tenantId,
        conversationId,
        rating,
        comment: comment || null,
        intent,
        decision,
      });

      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }

      auditLog.setContext({ tenantId: user.tenantId });
      await auditLog.log(
        "settings_updated" as any,
        "conversation",
        conversationId,
        req.userId,
        "user",
        { action: "csat_submitted", rating, intent, decision }
      );

      res.json({ success: true });
    } catch (error) {
      console.error("Error submitting CSAT:", error);
      res.status(500).json({ error: "Failed to submit CSAT rating" });
    }
  });

  // GET /api/analytics/csat - get CSAT analytics
  app.get("/api/analytics/csat", requireAuth, requirePermission("VIEW_ANALYTICS"), async (req: Request, res: Response) => {
    try {
      if (!req.userId || req.userId === "system") {
        return res.status(403).json({ error: "User authentication required" });
      }
      const user = await getUserByIdOrOidcId(req.userId);
      if (!user?.tenantId) {
        return res.status(403).json({ error: "User not associated with a tenant" });
      }

      const { getCsatAnalytics } = await import("./services/csat-service");
      const analytics = await getCsatAnalytics(user.tenantId);

      res.json(analytics);
    } catch (error) {
      console.error("Error getting CSAT analytics:", error);
      res.status(500).json({ error: "Failed to get CSAT analytics" });
    }
  });

  // GET /api/conversations/:id/csat - check if CSAT already submitted
  app.get("/api/conversations/:id/csat", requireAuth, requirePermission("VIEW_CONVERSATIONS"), async (req: Request, res: Response) => {
    try {
      if (!req.userId || req.userId === "system") {
        return res.status(403).json({ error: "User authentication required" });
      }
      const user = await getUserByIdOrOidcId(req.userId);
      if (!user?.tenantId) {
        return res.status(403).json({ error: "User not associated with a tenant" });
      }

      const conversationId = req.params.id;
      const existing = await storage.getCsatRatingByConversation(conversationId);

      res.json({ submitted: !!existing, rating: existing?.rating || null });
    } catch (error) {
      console.error("Error checking CSAT:", error);
      res.status(500).json({ error: "Failed to check CSAT status" });
    }
  });

  // ============ CONVERSION ROUTES ============

  // POST /api/conversations/:id/conversion - record a conversion (purchase)
  app.post("/api/conversations/:id/conversion", requireAuth, requirePermission("MANAGE_CONVERSATIONS"), async (req: Request, res: Response) => {
    try {
      if (!req.userId || req.userId === "system") {
        return res.status(403).json({ error: "User authentication required" });
      }
      const user = await getUserByIdOrOidcId(req.userId);
      if (!user?.tenantId) {
        return res.status(403).json({ error: "User not associated with a tenant" });
      }

      const conversationId = req.params.id;
      const { amount, currency } = req.body;

      if (!amount || typeof amount !== "number" || amount <= 0) {
        return res.status(400).json({ error: "Amount must be a positive number" });
      }

      const { submitConversion } = await import("./services/conversion-service");
      const result = await submitConversion({
        tenantId: user.tenantId,
        conversationId,
        amount,
        currency: currency || "RUB",
      });

      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }

      res.json({ success: true, conversion: result.conversion });
    } catch (error) {
      console.error("Error recording conversion:", error);
      res.status(500).json({ error: "Failed to record conversion" });
    }
  });

  // GET /api/conversations/:id/conversion - check if conversion exists
  app.get("/api/conversations/:id/conversion", requireAuth, requirePermission("VIEW_CONVERSATIONS"), async (req: Request, res: Response) => {
    try {
      if (!req.userId || req.userId === "system") {
        return res.status(403).json({ error: "User authentication required" });
      }
      const user = await getUserByIdOrOidcId(req.userId);
      if (!user?.tenantId) {
        return res.status(403).json({ error: "User not associated with a tenant" });
      }

      const conversationId = req.params.id;
      
      const conversation = await storage.getConversation(conversationId);
      if (!conversation) {
        return res.status(404).json({ error: "Conversation not found" });
      }
      if (conversation.tenantId !== user.tenantId) {
        return res.status(403).json({ error: "Access denied" });
      }
      
      const { getConversionByConversation } = await import("./services/conversion-service");
      const conversion = await getConversionByConversation(conversationId);

      res.json({ 
        hasConversion: !!conversion, 
        amount: conversion?.amount || null,
        currency: conversion?.currency || null,
      });
    } catch (error) {
      console.error("Error checking conversion:", error);
      res.status(500).json({ error: "Failed to check conversion" });
    }
  });

  // POST /api/conversations/:id/vehicle-lookup-case - create vehicle lookup case (VIN/FRAME)
  app.post("/api/conversations/:id/vehicle-lookup-case", requireAuth, requirePermission("MANAGE_CONVERSATIONS"), async (req: Request, res: Response) => {
    try {
      if (!req.userId || req.userId === "system") {
        return res.status(403).json({ error: "User authentication required" });
      }
      const user = await getUserByIdOrOidcId(req.userId);
      if (!user?.tenantId) {
        return res.status(403).json({ error: "User not associated with a tenant" });
      }

      const conversationId = req.params.id;
      const { idType, value } = req.body;

      if (!idType || (idType !== "VIN" && idType !== "FRAME")) {
        return res.status(400).json({ error: "idType must be \"VIN\" or \"FRAME\"" });
      }
      if (!value || typeof value !== "string" || value.trim().length === 0) {
        return res.status(400).json({ error: "value is required and must be a non-empty string" });
      }

      const rawValue = value.trim();
      const normalizedValue = idType === "VIN"
        ? rawValue.toUpperCase().replace(/\s/g, "")
        : rawValue.replace(/\s/g, "");

      const conversation = await storage.getConversation(conversationId);
      if (!conversation) {
        return res.status(404).json({ error: "Conversation not found" });
      }
      if (conversation.tenantId !== user.tenantId) {
        return res.status(403).json({ error: "Access denied" });
      }

      const row = await storage.createVehicleLookupCase({
        tenantId: user.tenantId,
        conversationId,
        messageId: null,
        idType,
        rawValue,
        normalizedValue,
        status: "PENDING",
        verificationStatus: "NONE",
      });

      const { enqueueVehicleLookup } = await import("./services/vehicle-lookup-queue");
      await enqueueVehicleLookup({
        caseId: row.id,
        tenantId: user.tenantId,
        conversationId,
        idType,
        normalizedValue,
      });

      res.status(201).json({ caseId: row.id });
    } catch (error) {
      console.error("Error creating vehicle lookup case:", error);
      res.status(500).json({ error: "Failed to create vehicle lookup case" });
    }
  });

  // GET /api/analytics/conversion - get conversion analytics
  app.get("/api/analytics/conversion", requireAuth, requirePermission("VIEW_ANALYTICS"), async (req: Request, res: Response) => {
    try {
      if (!req.userId || req.userId === "system") {
        return res.status(403).json({ error: "User authentication required" });
      }
      const user = await getUserByIdOrOidcId(req.userId);
      if (!user?.tenantId) {
        return res.status(403).json({ error: "User not associated with a tenant" });
      }

      const { getConversionAnalytics } = await import("./services/conversion-service");
      const analytics = await getConversionAnalytics(user.tenantId);

      res.json(analytics);
    } catch (error) {
      console.error("Error fetching conversion analytics:", error);
      res.status(500).json({ error: "Failed to fetch conversion analytics" });
    }
  });

  // GET /api/analytics/intents - get intent performance analytics
  app.get("/api/analytics/intents", requireAuth, requirePermission("VIEW_ANALYTICS"), async (req: Request, res: Response) => {
    try {
      if (!req.userId || req.userId === "system") {
        return res.status(403).json({ error: "User authentication required" });
      }
      const user = await getUserByIdOrOidcId(req.userId);
      if (!user?.tenantId) {
        return res.status(403).json({ error: "User not associated with a tenant" });
      }

      const { getIntentAnalytics } = await import("./services/intent-analytics-service");
      const analytics = await getIntentAnalytics(user.tenantId);

      res.json(analytics);
    } catch (error) {
      console.error("Error fetching intent analytics:", error);
      res.status(500).json({ error: "Failed to fetch intent analytics" });
    }
  });

  // GET /api/analytics/lost-deals - get lost deals analytics
  app.get("/api/analytics/lost-deals", requireAuth, requirePermission("VIEW_ANALYTICS"), async (req: Request, res: Response) => {
    try {
      if (!req.userId || req.userId === "system") {
        return res.status(403).json({ error: "User authentication required" });
      }
      const user = await getUserByIdOrOidcId(req.userId);
      if (!user?.tenantId) {
        return res.status(403).json({ error: "User not associated with a tenant" });
      }

      const { LostDealsService } = await import("./services/lost-deals-service");
      const lostDealsService = new LostDealsService(storage);
      const analytics = await lostDealsService.getLostDealsAnalytics(user.tenantId);

      res.json(analytics);
    } catch (error) {
      console.error("Error fetching lost deals analytics:", error);
      res.status(500).json({ error: "Failed to fetch lost deals analytics" });
    }
  });

  // POST /api/lost-deals - manually record a lost deal
  app.post("/api/lost-deals", requireAuth, requirePermission("VIEW_ANALYTICS"), async (req: Request, res: Response) => {
    try {
      if (!req.userId || req.userId === "system") {
        return res.status(403).json({ error: "User authentication required" });
      }
      const user = await getUserByIdOrOidcId(req.userId);
      if (!user?.tenantId) {
        return res.status(403).json({ error: "User not associated with a tenant" });
      }

      const { conversationId, reason, notes } = req.body;
      if (!conversationId || !reason) {
        return res.status(400).json({ error: "conversationId and reason are required" });
      }

      const sanitizedNotes = notes ? sanitizeString(notes) : notes;

      const { LostDealsService } = await import("./services/lost-deals-service");
      const lostDealsService = new LostDealsService(storage);
      const lostDeal = await lostDealsService.recordManualLostDeal(
        user.tenantId,
        conversationId,
        reason,
        sanitizedNotes
      );

      res.status(201).json(lostDeal);
    } catch (error: any) {
      console.error("Error recording lost deal:", error);
      if (error.message?.includes("already recorded")) {
        return res.status(409).json({ error: error.message });
      }
      res.status(500).json({ error: "Failed to record lost deal" });
    }
  });

  // ============ ESCALATION ROUTES ============

  app.get("/api/escalations", requireAuth, requirePermission("VIEW_CONVERSATIONS"), async (req: Request, res: Response) => {
    try {
      const user = await storage.getUser(req.userId);
      if (!user?.tenantId) {
        return res.status(403).json({ error: "User not associated with a tenant" });
      }
      const status = req.query.status as string;
      let escalations;
      if (status === "recent") {
        escalations = await storage.getRecentEscalations(user.tenantId, 5);
      } else if (status === "pending") {
        escalations = (await storage.getEscalationsByTenant(user.tenantId)).filter(e => e.status === "pending");
      } else {
        escalations = await storage.getEscalationsByTenant(user.tenantId);
      }
      res.json(escalations);
    } catch (error) {
      console.error("Error fetching escalations:", error);
      res.status(500).json({ error: "Failed to fetch escalations" });
    }
  });

  app.patch("/api/escalations/:id", requireAuth, requirePermission("MANAGE_CONVERSATIONS"), async (req: Request, res: Response) => {
    try {
      const { status } = req.body;
      const escalation = await storage.updateEscalationEvent(req.params.id, {
        status,
        handledAt: new Date(),
      });
      if (!escalation) {
        return res.status(404).json({ error: "Escalation not found" });
      }

      // If handled, update conversation status
      if (status === "handled" || status === "dismissed") {
        await storage.updateConversation(escalation.conversationId, { status: "active" });
      }

      res.json(escalation);
    } catch (error) {
      console.error("Error updating escalation:", error);
      res.status(500).json({ error: "Failed to update escalation" });
    }
  });

  // ============ PRODUCT ROUTES ============

  app.get("/api/products", requireAuth, requirePermission("MANAGE_PRODUCTS"), async (req: Request, res: Response) => {
    try {
      const tenant = await storage.getDefaultTenant();
      if (!tenant) {
        return res.status(404).json({ error: "Tenant not found" });
      }
      const products = await storage.getProductsByTenant(tenant.id);
      res.json(products);
    } catch (error) {
      console.error("Error fetching products:", error);
      res.status(500).json({ error: "Failed to fetch products" });
    }
  });

  app.post("/api/products", requireAuth, requirePermission("MANAGE_PRODUCTS"), async (req: Request, res: Response) => {
    try {
      const tenant = await storage.getDefaultTenant();
      if (!tenant) {
        return res.status(404).json({ error: "Tenant not found" });
      }
      
      // Validate request body
      const productData = insertProductSchema.omit({ tenantId: true }).safeParse(req.body);
      if (!productData.success) {
        return res.status(400).json({ error: "Invalid product data", details: productData.error.issues });
      }
      
      const product = await storage.createProduct({
        tenantId: tenant.id,
        ...productData.data,
      });
      res.status(201).json(product);
    } catch (error) {
      console.error("Error creating product:", error);
      res.status(500).json({ error: "Failed to create product" });
    }
  });

  app.patch("/api/products/:id", requireAuth, requirePermission("MANAGE_PRODUCTS"), async (req: Request, res: Response) => {
    try {
      const product = await storage.updateProduct(req.params.id, req.body);
      if (!product) {
        return res.status(404).json({ error: "Product not found" });
      }
      res.json(product);
    } catch (error) {
      console.error("Error updating product:", error);
      res.status(500).json({ error: "Failed to update product" });
    }
  });

  app.delete("/api/products/:id", requireAuth, requirePermission("MANAGE_PRODUCTS"), async (req: Request, res: Response) => {
    try {
      const product = await storage.getProduct(req.params.id);
      if (!product) {
        return res.status(404).json({ error: "Product not found" });
      }
      
      const deleted = await storage.deleteProduct(req.params.id);
      if (!deleted) {
        return res.status(404).json({ error: "Product not found" });
      }
      
      await storage.deleteRagBySource(product.tenantId, "PRODUCT", product.id);
      
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting product:", error);
      res.status(500).json({ error: "Failed to delete product" });
    }
  });

  app.post("/api/products/import", requireAuth, requirePermission("MANAGE_PRODUCTS"), async (req: Request, res: Response) => {
    try {
      // For MVP, we'll handle CSV parsing on the frontend
      // This endpoint expects an array of product objects
      const tenant = await storage.getDefaultTenant();
      if (!tenant) {
        return res.status(404).json({ error: "Tenant not found" });
      }
      
      const products = req.body.products || [];
      let count = 0;
      
      for (const p of products) {
        await storage.createProduct({
          tenantId: tenant.id,
          name: p.name,
          sku: p.sku,
          description: p.description,
          price: parseFloat(p.price) || null,
          category: p.category,
          inStock: p.inStock !== "false" && p.inStock !== false,
          stockQuantity: parseInt(p.stockQuantity) || null,
        });
        count++;
      }
      
      res.json({ count, message: `Imported ${count} products` });
    } catch (error) {
      console.error("Error importing products:", error);
      res.status(500).json({ error: "Failed to import products" });
    }
  });

  // ============ KNOWLEDGE BASE ROUTES ============

  app.get("/api/knowledge-docs", requireAuth, requirePermission("MANAGE_KNOWLEDGE_BASE"), async (req: Request, res: Response) => {
    try {
      const tenant = await storage.getDefaultTenant();
      if (!tenant) {
        return res.status(404).json({ error: "Tenant not found" });
      }
      const docs = await storage.getKnowledgeDocsByTenant(tenant.id);
      res.json(docs);
    } catch (error) {
      console.error("Error fetching knowledge docs:", error);
      res.status(500).json({ error: "Failed to fetch knowledge docs" });
    }
  });

  app.post("/api/knowledge-docs", requireAuth, requirePermission("MANAGE_KNOWLEDGE_BASE"), async (req: Request, res: Response) => {
    try {
      const tenant = await storage.getDefaultTenant();
      if (!tenant) {
        return res.status(404).json({ error: "Tenant not found" });
      }
      
      // Validate request body
      const docData = insertKnowledgeDocSchema.omit({ tenantId: true }).safeParse(req.body);
      if (!docData.success) {
        return res.status(400).json({ error: "Invalid document data", details: docData.error.issues });
      }
      
      const doc = await storage.createKnowledgeDoc({
        tenantId: tenant.id,
        ...docData.data,
      });
      res.status(201).json(doc);
    } catch (error) {
      console.error("Error creating knowledge doc:", error);
      res.status(500).json({ error: "Failed to create knowledge doc" });
    }
  });

  app.patch("/api/knowledge-docs/:id", requireAuth, requirePermission("MANAGE_KNOWLEDGE_BASE"), async (req: Request, res: Response) => {
    try {
      const doc = await storage.updateKnowledgeDoc(req.params.id, req.body);
      if (!doc) {
        return res.status(404).json({ error: "Document not found" });
      }
      res.json(doc);
    } catch (error) {
      console.error("Error updating knowledge doc:", error);
      res.status(500).json({ error: "Failed to update knowledge doc" });
    }
  });

  app.delete("/api/knowledge-docs/:id", requireAuth, requirePermission("MANAGE_KNOWLEDGE_BASE"), async (req: Request, res: Response) => {
    try {
      const doc = await storage.getKnowledgeDoc(req.params.id);
      if (!doc) {
        return res.status(404).json({ error: "Document not found" });
      }
      
      const deleted = await storage.deleteKnowledgeDoc(req.params.id);
      if (!deleted) {
        return res.status(404).json({ error: "Document not found" });
      }
      
      await storage.deleteRagBySource(doc.tenantId, "DOC", doc.id);
      
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting knowledge doc:", error);
      res.status(500).json({ error: "Failed to delete knowledge doc" });
    }
  });

  // ============ CHANNEL MANAGEMENT ROUTES ============

  const channelConnectionCache = new Map<string, {
    connected: boolean;
    botInfo?: { user_id?: number; first_name?: string; username?: string };
    lastError?: string;
    lastChecked?: string;
  }>();

  app.get("/api/channels/status", requireAuth, requirePermission("MANAGE_CHANNELS"), async (req: Request, res: Response) => {
    try {
      const maxToken = process.env.MAX_TOKEN;
      const maxCache = channelConnectionCache.get("max");
      
      const statuses = [
        {
          channel: "max",
          enabled: await featureFlagService.isEnabled("MAX_CHANNEL_ENABLED"),
          connected: maxCache?.connected ?? !!maxToken,
          lastError: maxCache?.lastError,
          botInfo: maxCache?.botInfo,
        },
        {
          channel: "telegram",
          enabled: await featureFlagService.isEnabled("TELEGRAM_CHANNEL_ENABLED"),
          connected: channelConnectionCache.get("telegram")?.connected ?? !!process.env.TELEGRAM_BOT_TOKEN,
          lastError: channelConnectionCache.get("telegram")?.lastError,
          botInfo: channelConnectionCache.get("telegram")?.botInfo,
        },
        await (async () => {
          const { telegramClientManager } = await import("./services/telegram-client-manager");
          const tenantId = (req as any).user?.tenantId;
          
          let isConnected = false;
          let botInfo = channelConnectionCache.get("telegram_personal")?.botInfo;
          
          if (tenantId) {
            const channels = await storage.getChannelsByTenant(tenantId);
            const tgChannel = channels.find(c => c.type === "telegram_personal");
            if (tgChannel) {
              // Do real verification instead of cached status
              const verification = await telegramClientManager.verifyConnection(tenantId, tgChannel.id);
              isConnected = verification.connected;
              
              if (verification.user) {
                botInfo = {
                  user_id: verification.user.id,
                  first_name: verification.user.firstName,
                  username: verification.user.username,
                };
              } else {
                // Fallback to stored config
                const config = tgChannel.config as { user?: { id?: number; firstName?: string; username?: string } } | null;
                if (config?.user) {
                  botInfo = {
                    user_id: config.user.id,
                    first_name: config.user.firstName,
                    username: config.user.username,
                  };
                }
              }
            }
          }
          
          return {
            channel: "telegram_personal",
            enabled: await featureFlagService.isEnabled("TELEGRAM_PERSONAL_CHANNEL_ENABLED"),
            connected: isConnected,
            lastError: channelConnectionCache.get("telegram_personal")?.lastError,
            botInfo,
          };
        })(),
        {
          channel: "whatsapp",
          enabled: await featureFlagService.isEnabled("WHATSAPP_CHANNEL_ENABLED"),
          connected: channelConnectionCache.get("whatsapp")?.connected ?? (!!process.env.WHATSAPP_ACCESS_TOKEN && !!process.env.WHATSAPP_PHONE_NUMBER_ID),
          lastError: channelConnectionCache.get("whatsapp")?.lastError,
          botInfo: channelConnectionCache.get("whatsapp")?.botInfo,
        },
        await (async () => {
          // Get tenant ID for WhatsApp Personal status check
          const tenant = await storage.getDefaultTenant();
          const tenantId = tenant?.id || "default";
          const sessionInfo = WhatsAppPersonalAdapter.getSessionInfo(tenantId);
          
          return {
            channel: "whatsapp_personal",
            enabled: await featureFlagService.isEnabled("WHATSAPP_PERSONAL_CHANNEL_ENABLED"),
            connected: WhatsAppPersonalAdapter.isConnected(tenantId),
            lastError: channelConnectionCache.get("whatsapp_personal")?.lastError,
            botInfo: sessionInfo.user ? {
              user_id: parseInt(sessionInfo.user.id.split(":")[0], 10) || 0,
              first_name: sessionInfo.user.name,
              username: sessionInfo.user.phone,
            } : channelConnectionCache.get("whatsapp_personal")?.botInfo,
          };
        })(),
        {
          channel: "max_personal",
          enabled: await featureFlagService.isEnabled("MAX_PERSONAL_CHANNEL_ENABLED"),
          connected: channelConnectionCache.get("max_personal")?.connected ?? false,
          lastError: channelConnectionCache.get("max_personal")?.lastError,
          botInfo: channelConnectionCache.get("max_personal")?.botInfo,
        },
      ];

      res.json(statuses);
    } catch (error) {
      console.error("Error fetching channel status:", error);
      res.status(500).json({ error: "Failed to fetch channel status" });
    }
  });

  app.get("/api/channels/feature-flags", requireAuth, requirePermission("MANAGE_CHANNELS"), async (req: Request, res: Response) => {
    try {
      const flags = {
        MAX_CHANNEL_ENABLED: await featureFlagService.isEnabled("MAX_CHANNEL_ENABLED"),
        MAX_PERSONAL_CHANNEL_ENABLED: await featureFlagService.isEnabled("MAX_PERSONAL_CHANNEL_ENABLED"),
        TELEGRAM_CHANNEL_ENABLED: await featureFlagService.isEnabled("TELEGRAM_CHANNEL_ENABLED"),
        TELEGRAM_PERSONAL_CHANNEL_ENABLED: await featureFlagService.isEnabled("TELEGRAM_PERSONAL_CHANNEL_ENABLED"),
        WHATSAPP_CHANNEL_ENABLED: await featureFlagService.isEnabled("WHATSAPP_CHANNEL_ENABLED"),
        WHATSAPP_PERSONAL_CHANNEL_ENABLED: await featureFlagService.isEnabled("WHATSAPP_PERSONAL_CHANNEL_ENABLED"),
      };

      res.json(flags);
    } catch (error) {
      console.error("Error fetching channel feature flags:", error);
      res.status(500).json({ error: "Failed to fetch channel feature flags" });
    }
  });

  app.post("/api/channels/:channel/toggle", requireAuth, requirePermission("MANAGE_CHANNELS"), requireActiveSubscription, requireActiveTenant, async (req: Request, res: Response) => {
    try {
      const { channel } = req.params;
      const { enabled } = req.body;

      const flagNameMap: Record<string, string> = {
        max: "MAX_CHANNEL_ENABLED",
        max_personal: "MAX_PERSONAL_CHANNEL_ENABLED",
        telegram: "TELEGRAM_CHANNEL_ENABLED",
        telegram_personal: "TELEGRAM_PERSONAL_CHANNEL_ENABLED",
        whatsapp: "WHATSAPP_CHANNEL_ENABLED",
        whatsapp_personal: "WHATSAPP_PERSONAL_CHANNEL_ENABLED",
      };

      const flagName = flagNameMap[channel];
      if (!flagName) {
        return res.status(400).json({ error: "Unknown channel" });
      }

      await featureFlagService.setFlag(flagName, enabled);

      await auditLog.log(
        "feature_flag_toggled" as any,
        "channel",
        channel,
        "system",
        "system",
        { flagName, enabled }
      );

      res.json({ success: true, channel, enabled });
    } catch (error) {
      console.error("Error toggling channel:", error);
      res.status(500).json({ error: "Failed to toggle channel" });
    }
  });

  app.post("/api/channels/:channel/config", requireAuth, requirePermission("MANAGE_CHANNELS"), requireActiveSubscription, requireActiveTenant, async (req: Request, res: Response) => {
    try {
      const { channel } = req.params;
      const { token, webhookSecret, accessToken, phoneNumberId, verifyToken, appSecret } = req.body;

      if (channel !== "max" && channel !== "telegram" && channel !== "whatsapp") {
        return res.status(400).json({ error: "Channel configuration not supported yet" });
      }

      const user = await storage.getUserByOidcId(req.userId!) || await storage.getUser(req.userId!);
      const userTenantId = user?.tenantId;

      if (!userTenantId) {
        return res.status(403).json({ error: "User not associated with a tenant" });
      }

      const hasChannelCredentials = token || accessToken || phoneNumberId;
      if (hasChannelCredentials) {
        const channelType = channel === "telegram" ? "telegram" : channel === "max" ? "max" : "whatsapp_business";
        let fingerprintInput;
        
        if (channel === "telegram") {
          fingerprintInput = { telegram: { botToken: token } };
        } else if (channel === "max") {
          fingerprintInput = { max: { workspaceId: token } };
        } else {
          fingerprintInput = { whatsapp_business: { businessId: accessToken, phoneNumber: phoneNumberId } };
        }
        
        const fraudCheck = await fraudDetectionService.validateChannelConnection(
          userTenantId,
          channelType as any,
          fingerprintInput
        );

        if (!fraudCheck.allowed) {
          return res.status(403).json({ 
            error: fraudCheck.message,
            code: "FRAUD_DETECTED"
          });
        }
      }

      await auditLog.log(
        "channel_config_updated" as any,
        "channel",
        channel,
        "system",
        "system",
        { hasToken: !!token, hasWebhookSecret: !!webhookSecret, hasAccessToken: !!accessToken, hasPhoneNumberId: !!phoneNumberId }
      );

      if (channel === "whatsapp") {
        const secretsNeeded = [];
        if (accessToken) secretsNeeded.push("WHATSAPP_ACCESS_TOKEN");
        if (phoneNumberId) secretsNeeded.push("WHATSAPP_PHONE_NUMBER_ID");
        if (verifyToken) secretsNeeded.push("WHATSAPP_VERIFY_TOKEN");
        if (appSecret) secretsNeeded.push("WHATSAPP_APP_SECRET");
        
        res.json({ 
          success: true, 
          message: `Для применения конфигурации добавьте следующие секреты: ${secretsNeeded.join(", ")}. После этого перезапустите приложение.` 
        });
        return;
      }

      const secretName = channel === "max" ? "MAX_TOKEN" : "TELEGRAM_BOT_TOKEN";
      res.json({ 
        success: true, 
        message: `Для применения токена добавьте его в Secrets (${secretName}). После этого перезапустите приложение.` 
      });
    } catch (error) {
      console.error("Error saving channel config:", error);
      res.status(500).json({ error: "Failed to save channel config" });
    }
  });

  app.post("/api/channels/:channel/test", requireAuth, requirePermission("MANAGE_CHANNELS"), async (req: Request, res: Response) => {
    try {
      const { channel } = req.params;
      const { token } = req.body;

      if (channel === "max") {
        const { MaxAdapter } = await import("./services/max-adapter");
        const testAdapter = new MaxAdapter(token || process.env.MAX_TOKEN);
        const result = await testAdapter.verifyAuth();

        if (result.success && result.botInfo) {
          channelConnectionCache.set("max", {
            connected: true,
            botInfo: {
              user_id: result.botInfo.user_id,
              first_name: result.botInfo.first_name,
              username: result.botInfo.username || undefined,
            },
            lastError: undefined,
            lastChecked: new Date().toISOString(),
          });
        } else {
          channelConnectionCache.set("max", {
            connected: false,
            botInfo: undefined,
            lastError: result.error,
            lastChecked: new Date().toISOString(),
          });
        }

        res.json(result);
        return;
      }

      if (channel === "telegram") {
        const { TelegramAdapter } = await import("./services/telegram-adapter");
        const testAdapter = new TelegramAdapter(token || process.env.TELEGRAM_BOT_TOKEN);
        const result = await testAdapter.verifyAuth();

        if (result.success && result.botInfo) {
          channelConnectionCache.set("telegram", {
            connected: true,
            botInfo: {
              user_id: result.botInfo.id,
              first_name: result.botInfo.first_name,
              username: result.botInfo.username,
            },
            lastError: undefined,
            lastChecked: new Date().toISOString(),
          });
        } else {
          channelConnectionCache.set("telegram", {
            connected: false,
            botInfo: undefined,
            lastError: result.error,
            lastChecked: new Date().toISOString(),
          });
        }

        res.json(result);
        return;
      }

      if (channel === "whatsapp") {
        const { whatsappAdapter } = await import("./services/whatsapp-adapter");
        const result = await whatsappAdapter.testConnection();

        if (result.success) {
          channelConnectionCache.set("whatsapp", {
            connected: true,
            botInfo: undefined,
            lastError: undefined,
            lastChecked: new Date().toISOString(),
          });
        } else {
          channelConnectionCache.set("whatsapp", {
            connected: false,
            botInfo: undefined,
            lastError: result.error,
            lastChecked: new Date().toISOString(),
          });
        }

        res.json(result);
        return;
      }

      return res.status(400).json({ error: "Channel test not supported yet" });
    } catch (error) {
      console.error("Error testing channel:", error);
      res.status(500).json({ error: "Failed to test channel connection" });
    }
  });

  // ============ TELEGRAM PERSONAL AUTH ROUTES ============

  app.post("/api/telegram-personal/start-auth", requireAuth, requirePermission("MANAGE_CHANNELS"), requireActiveSubscription, requireActiveTenant, async (req: Request, res: Response) => {
    try {
      const { phoneNumber } = req.body;
      
      const user = await storage.getUserByOidcId(req.userId!) || await storage.getUser(req.userId!);
      const userTenantId = user?.tenantId;

      if (!phoneNumber) {
        return res.status(400).json({ error: "Phone number is required" });
      }
      
      if (!userTenantId) {
        return res.status(403).json({ error: "User not associated with a tenant" });
      }

      const fraudCheck = await fraudDetectionService.validateChannelConnection(
        userTenantId,
        "telegram",
        { telegram: { botId: phoneNumber } }
      );

      if (!fraudCheck.allowed) {
        return res.status(403).json({ 
          error: fraudCheck.message,
          code: "FRAUD_DETECTED"
        });
      }

      const sessionId = `tg_auth_${Date.now()}_${Math.random().toString(36).substring(7)}`;

      const { TelegramPersonalAdapter } = await import("./services/telegram-personal-adapter");
      const result = await TelegramPersonalAdapter.startAuth(sessionId, phoneNumber);

      if (result.success) {
        res.json({ success: true, sessionId });
      } else {
        res.status(400).json({ success: false, error: result.error });
      }
    } catch (error: any) {
      console.error("Error starting Telegram auth:", error);
      res.status(500).json({ error: error.message || "Failed to start authentication" });
    }
  });

  app.post("/api/telegram-personal/verify-code", requireAuth, requirePermission("MANAGE_CHANNELS"), requireActiveSubscription, async (req: Request, res: Response) => {
    try {
      const { sessionId, phoneNumber, code, tenantId } = req.body;

      if (!sessionId || !phoneNumber || !code) {
        return res.status(400).json({ error: "Session ID, phone number, and code are required" });
      }

      const { TelegramPersonalAdapter } = await import("./services/telegram-personal-adapter");
      const result = await TelegramPersonalAdapter.verifyCode(sessionId, phoneNumber, code);

      if (result.success) {
        channelConnectionCache.set("telegram_personal", {
          connected: true,
          botInfo: result.user ? {
            user_id: result.user.id,
            first_name: result.user.firstName,
            username: result.user.username,
          } : undefined,
          lastError: undefined,
          lastChecked: new Date().toISOString(),
        });

        res.json({
          success: true,
          sessionString: result.sessionString,
          user: result.user,
        });
      } else if (result.needs2FA) {
        res.json({ success: false, needs2FA: true, sessionId });
      } else {
        res.status(400).json({ success: false, error: result.error });
      }
    } catch (error: any) {
      console.error("Error verifying Telegram code:", error);
      res.status(500).json({ error: error.message || "Failed to verify code" });
    }
  });

  app.post("/api/telegram-personal/verify-2fa", requireAuth, requirePermission("MANAGE_CHANNELS"), requireActiveSubscription, async (req: Request, res: Response) => {
    try {
      const { sessionId, password, tenantId } = req.body;

      if (!sessionId || !password) {
        return res.status(400).json({ error: "Session ID and password are required" });
      }

      const { TelegramPersonalAdapter } = await import("./services/telegram-personal-adapter");
      const result = await TelegramPersonalAdapter.verify2FA(sessionId, password);

      if (result.success) {
        channelConnectionCache.set("telegram_personal", {
          connected: true,
          botInfo: result.user ? {
            user_id: result.user.id,
            first_name: result.user.firstName,
            username: result.user.username,
          } : undefined,
          lastError: undefined,
          lastChecked: new Date().toISOString(),
        });

        res.json({
          success: true,
          sessionString: result.sessionString,
          user: result.user,
        });
      } else {
        res.status(400).json({ success: false, error: result.error });
      }
    } catch (error: any) {
      console.error("Error verifying 2FA:", error);
      res.status(500).json({ error: error.message || "Failed to verify 2FA" });
    }
  });

  app.post("/api/telegram-personal/cancel-auth", requireAuth, requirePermission("MANAGE_CHANNELS"), async (req: Request, res: Response) => {
    try {
      const { sessionId } = req.body;

      if (sessionId) {
        const { TelegramPersonalAdapter } = await import("./services/telegram-personal-adapter");
        await TelegramPersonalAdapter.cancelAuth(sessionId);
      }

      res.json({ success: true });
    } catch (error: any) {
      console.error("Error canceling auth:", error);
      res.json({ success: true });
    }
  });

  app.post("/api/telegram-personal/verify-session", requireAuth, requirePermission("MANAGE_CHANNELS"), requireActiveSubscription, async (req: Request, res: Response) => {
    try {
      const { sessionString } = req.body;

      if (!sessionString) {
        return res.status(400).json({ error: "Session string is required" });
      }

      const { TelegramPersonalAdapter } = await import("./services/telegram-personal-adapter");
      const result = await TelegramPersonalAdapter.verifySession(sessionString);

      if (result.success) {
        channelConnectionCache.set("telegram_personal", {
          connected: true,
          botInfo: result.user ? {
            user_id: result.user.id,
            first_name: result.user.firstName,
            username: result.user.username,
          } : undefined,
          lastError: undefined,
          lastChecked: new Date().toISOString(),
        });
      }

      res.json(result);
    } catch (error: any) {
      console.error("Error verifying session:", error);
      res.status(500).json({ error: error.message || "Failed to verify session" });
    }
  });

  app.post("/api/telegram-personal/start-qr-auth", requireAuth, requirePermission("MANAGE_CHANNELS"), async (req: Request, res: Response) => {
    try {
      const sessionId = `qr_${Date.now()}_${Math.random().toString(36).substring(7)}`;

      const { TelegramPersonalAdapter } = await import("./services/telegram-personal-adapter");
      const result = await TelegramPersonalAdapter.startQrAuth(sessionId);

      if (result.success && result.qrUrl) {
        const QRCode = await import("qrcode");
        const qrImageDataUrl = await QRCode.toDataURL(result.qrUrl, {
          width: 256,
          margin: 2,
          color: {
            dark: "#000000",
            light: "#ffffff",
          },
        });

        res.json({
          success: true,
          sessionId,
          qrImageDataUrl,
          qrUrl: result.qrUrl,
          expiresAt: result.expiresAt,
        });
      } else {
        res.status(400).json({ success: false, error: result.error });
      }
    } catch (error: any) {
      console.error("Error starting QR auth:", error);
      res.status(500).json({ error: error.message || "Failed to start QR auth" });
    }
  });

  app.post("/api/telegram-personal/check-qr-auth", requireAuth, requirePermission("MANAGE_CHANNELS"), async (req: Request, res: Response) => {
    try {
      const { sessionId } = req.body;

      if (!sessionId) {
        return res.status(400).json({ error: "Session ID is required" });
      }

      const { TelegramPersonalAdapter } = await import("./services/telegram-personal-adapter");
      const result = await TelegramPersonalAdapter.checkQrAuth(sessionId);

      if (result.status === "authorized" && result.sessionString) {
        const tenantId = (req as any).user?.tenantId;
        
        if (tenantId) {
          const existingChannels = await storage.getChannelsByTenant(tenantId);
          let channel = existingChannels.find(c => c.type === "telegram_personal");
          
          if (channel) {
            await storage.updateChannel(channel.id, {
              config: { sessionData: result.sessionString, user: result.user },
              isActive: true,
            });
          } else {
            channel = await storage.createChannel({
              tenantId,
              type: "telegram_personal",
              name: `Telegram Personal (${result.user?.firstName || "Connected"})`,
              config: { sessionData: result.sessionString, user: result.user },
              isActive: true,
            });
          }
          
          const { telegramClientManager } = await import("./services/telegram-client-manager");
          await telegramClientManager.connect(tenantId, channel.id, result.sessionString);
          
          // Auto-sync dialogs after successful connection
          console.log(`[TelegramPersonal] Starting auto-sync for tenant ${tenantId}, channel ${channel.id}`);
          telegramClientManager.syncDialogs(tenantId, channel.id, { limit: 50, messageLimit: 20 })
            .then(syncResult => {
              console.log(`[TelegramPersonal] Sync complete: ${syncResult.dialogsImported} dialogs, ${syncResult.messagesImported} messages`);
            })
            .catch(err => {
              console.error(`[TelegramPersonal] Sync error:`, err.message);
            });
        }
        
        channelConnectionCache.set("telegram_personal", {
          connected: true,
          botInfo: result.user ? {
            user_id: result.user.id,
            first_name: result.user.firstName,
            username: result.user.username,
          } : undefined,
          lastError: undefined,
          lastChecked: new Date().toISOString(),
        });
      }

      if (result.qrUrl) {
        const QRCode = await import("qrcode");
        const qrImageDataUrl = await QRCode.toDataURL(result.qrUrl, {
          width: 256,
          margin: 2,
          color: {
            dark: "#000000",
            light: "#ffffff",
          },
        });
        
        res.json({
          ...result,
          qrImageDataUrl,
        });
      } else {
        res.json(result);
      }
    } catch (error: any) {
      console.error("Error checking QR auth:", error);
      res.status(500).json({ error: error.message || "Failed to check QR auth" });
    }
  });

  app.post("/api/telegram-personal/verify-qr-2fa", requireAuth, requirePermission("MANAGE_CHANNELS"), async (req: Request, res: Response) => {
    try {
      const { sessionId, password } = req.body;

      if (!sessionId || !password) {
        return res.status(400).json({ error: "Session ID and password are required" });
      }

      const { TelegramPersonalAdapter } = await import("./services/telegram-personal-adapter");
      const result = await TelegramPersonalAdapter.verify2FAForQr(sessionId, password);

      if (result.success && result.sessionString) {
        const tenantId = (req as any).user?.tenantId;
        
        if (tenantId) {
          const existingChannels = await storage.getChannelsByTenant(tenantId);
          let channel = existingChannels.find(c => c.type === "telegram_personal");
          
          if (channel) {
            await storage.updateChannel(channel.id, {
              config: { sessionData: result.sessionString, user: result.user },
              isActive: true,
            });
          } else {
            channel = await storage.createChannel({
              tenantId,
              type: "telegram_personal",
              name: `Telegram Personal (${result.user?.firstName || "Connected"})`,
              config: { sessionData: result.sessionString, user: result.user },
              isActive: true,
            });
          }
          
          const { telegramClientManager } = await import("./services/telegram-client-manager");
          await telegramClientManager.connect(tenantId, channel.id, result.sessionString);
          
          // Auto-sync dialogs after successful 2FA connection
          console.log(`[TelegramPersonal] Starting auto-sync for tenant ${tenantId}, channel ${channel.id}`);
          telegramClientManager.syncDialogs(tenantId, channel.id, { limit: 50, messageLimit: 20 })
            .then(syncResult => {
              console.log(`[TelegramPersonal] Sync complete: ${syncResult.dialogsImported} dialogs, ${syncResult.messagesImported} messages`);
            })
            .catch(err => {
              console.error(`[TelegramPersonal] Sync error:`, err.message);
            });
        }
        
        channelConnectionCache.set("telegram_personal", {
          connected: true,
          botInfo: result.user ? {
            user_id: result.user.id,
            first_name: result.user.firstName,
            username: result.user.username,
          } : undefined,
          lastError: undefined,
          lastChecked: new Date().toISOString(),
        });

        res.json({
          success: true,
          sessionString: result.sessionString,
          user: result.user,
        });
      } else {
        res.status(400).json({ success: false, error: result.error });
      }
    } catch (error: any) {
      console.error("Error verifying QR 2FA:", error);
      res.status(500).json({ error: error.message || "Failed to verify 2FA" });
    }
  });

  app.post("/api/telegram-personal/disconnect", requireAuth, requirePermission("MANAGE_CHANNELS"), async (req: Request, res: Response) => {
    try {
      const tenantId = (req as any).user?.tenantId;
      
      if (!tenantId) {
        return res.status(403).json({ error: "User not associated with a tenant" });
      }

      const existingChannels = await storage.getChannelsByTenant(tenantId);
      const channel = existingChannels.find(c => c.type === "telegram_personal");
      
      if (channel) {
        const { telegramClientManager } = await import("./services/telegram-client-manager");
        await telegramClientManager.disconnect(tenantId, channel.id);
        
        await storage.updateChannel(channel.id, {
          config: {},
          isActive: false,
        });
      }
      
      channelConnectionCache.set("telegram_personal", {
        connected: false,
        botInfo: undefined,
        lastError: undefined,
        lastChecked: new Date().toISOString(),
      });

      res.json({ success: true });
    } catch (error: any) {
      console.error("Error disconnecting Telegram Personal:", error);
      res.status(500).json({ error: error.message || "Failed to disconnect" });
    }
  });

  app.post("/api/telegram-personal/start-conversation", requireAuth, async (req: Request, res: Response) => {
    try {
      const tenantId = (req as any).user?.tenantId;
      
      if (!tenantId) {
        return res.status(403).json({ error: "User not associated with a tenant" });
      }

      const { phoneNumber, initialMessage } = req.body;
      
      if (!phoneNumber) {
        return res.status(400).json({ error: "Phone number is required" });
      }

      const cleanPhone = String(phoneNumber).replace(/[^\d+]/g, "");
      if (cleanPhone.length < 10 || cleanPhone.length > 15 || !/^\+?\d+$/.test(cleanPhone)) {
        return res.status(400).json({ error: "Invalid phone number format" });
      }

      const existingChannels = await storage.getChannelsByTenant(tenantId);
      const channel = existingChannels.find(c => c.type === "telegram_personal" && c.isActive);
      
      if (!channel) {
        return res.status(400).json({ error: "No active Telegram Personal channel" });
      }

      const { telegramClientManager } = await import("./services/telegram-client-manager");
      const result = await telegramClientManager.startConversationByPhone(
        tenantId,
        channel.id,
        phoneNumber,
        initialMessage
      );

      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }

      // Find or create customer
      let customer = await storage.getCustomerByExternalId(tenantId, "telegram_personal", result.userId!);
      if (!customer) {
        const resolveResult = await telegramClientManager.resolvePhoneNumber(tenantId, channel.id, phoneNumber);
        const customerName = resolveResult.success 
          ? `${resolveResult.firstName || ""} ${resolveResult.lastName || ""}`.trim() || "Telegram User"
          : "Telegram User";

        try {
          customer = await storage.createCustomer({
            tenantId,
            externalId: result.userId!,
            name: customerName,
            channel: "telegram_personal",
            metadata: { phone: phoneNumber },
          });
        } catch (e: any) {
          // Customer might have been created by another request
          customer = await storage.getCustomerByExternalId(tenantId, "telegram_personal", result.userId!);
          if (!customer) throw e;
        }
      }

      // Find existing conversation with this customer
      const allConversations = await storage.getConversationsByTenant(tenantId);
      let conversation = allConversations.find(c => c.customerId === customer!.id);

      if (!conversation) {
        conversation = await storage.createConversation({
          tenantId,
          customerId: customer.id,
          channelId: channel.id,
          status: "active",
          mode: "learning",
        });
      }

      res.json({ 
        success: true, 
        conversationId: conversation.id,
      });
    } catch (error: any) {
      console.error("Error starting Telegram conversation:", error);
      res.status(500).json({ error: error.message || "Failed to start conversation" });
    }
  });

  // ============ WHATSAPP PERSONAL ROUTES ============

  app.post("/api/whatsapp-personal/start-auth", requireAuth, requirePermission("MANAGE_CHANNELS"), requireActiveSubscription, async (req: Request, res: Response) => {
    try {
      // Get user's actual tenantId for proper tenant isolation
      const user = await storage.getUserByOidcId(req.userId!) || await storage.getUser(req.userId!);
      const tenantId = user?.tenantId;
      
      if (!tenantId) {
        return res.status(403).json({ error: "User not associated with a tenant" });
      }

      const { WhatsAppPersonalAdapter } = await import("./services/whatsapp-personal-adapter");
      const result = await WhatsAppPersonalAdapter.startAuth(tenantId);

      if (result.success) {
        if (result.qrCode || result.qrDataUrl) {
          res.json({
            success: true,
            status: "qr_ready",
            qrCode: result.qrCode,
            qrDataUrl: result.qrDataUrl,
          });
        } else {
          channelConnectionCache.set("whatsapp_personal", {
            connected: true,
            lastError: undefined,
            lastChecked: new Date().toISOString(),
          });
          res.json({ success: true, status: "connected" });
        }
      } else {
        res.status(400).json({ success: false, error: result.error });
      }
    } catch (error: any) {
      console.error("Error starting WhatsApp Personal auth:", error);
      res.status(500).json({ error: error.message || "Failed to start authentication" });
    }
  });

  app.post("/api/whatsapp-personal/start-auth-phone", requireAuth, requirePermission("MANAGE_CHANNELS"), requireActiveSubscription, requireActiveTenant, async (req: Request, res: Response) => {
    try {
      const phoneNumber = req.body.phoneNumber;
      
      const user = await storage.getUserByOidcId(req.userId!) || await storage.getUser(req.userId!);
      const userTenantId = user?.tenantId;

      if (!phoneNumber) {
        return res.status(400).json({ success: false, error: "Phone number is required" });
      }
      
      if (!userTenantId) {
        return res.status(403).json({ error: "User not associated with a tenant" });
      }

      const fraudCheck = await fraudDetectionService.validateChannelConnection(
        userTenantId,
        "whatsapp_personal",
        { whatsapp_personal: { phoneNumber } }
      );

      if (!fraudCheck.allowed) {
        return res.status(403).json({ 
          error: fraudCheck.message,
          code: "FRAUD_DETECTED"
        });
      }

      const { WhatsAppPersonalAdapter } = await import("./services/whatsapp-personal-adapter");
      const result = await WhatsAppPersonalAdapter.startAuthWithPhone(userTenantId, phoneNumber);

      if (result.success) {
        if (result.pairingCode) {
          res.json({
            success: true,
            status: "pairing_code_ready",
            pairingCode: result.pairingCode,
          });
        } else {
          channelConnectionCache.set("whatsapp_personal", {
            connected: true,
            lastError: undefined,
            lastChecked: new Date().toISOString(),
          });
          res.json({ success: true, status: "connected" });
        }
      } else {
        res.status(400).json({ success: false, error: result.error });
      }
    } catch (error: any) {
      console.error("Error starting WhatsApp Personal phone auth:", error);
      res.status(500).json({ error: error.message || "Failed to start phone authentication" });
    }
  });

  app.post("/api/whatsapp-personal/check-auth", requireAuth, requirePermission("MANAGE_CHANNELS"), async (req: Request, res: Response) => {
    try {
      // Get user's actual tenantId for proper tenant isolation
      const user = await storage.getUserByOidcId(req.userId!) || await storage.getUser(req.userId!);
      const tenantId = user?.tenantId;
      
      if (!tenantId) {
        return res.status(403).json({ error: "User not associated with a tenant" });
      }

      const { WhatsAppPersonalAdapter } = await import("./services/whatsapp-personal-adapter");
      const result = await WhatsAppPersonalAdapter.checkAuth(tenantId);

      if (result.status === "connected" && result.user) {
        channelConnectionCache.set("whatsapp_personal", {
          connected: true,
          botInfo: {
            user_id: parseInt(result.user.id.split(":")[0], 10) || 0,
            first_name: result.user.name,
            username: result.user.phone,
          },
          lastError: undefined,
          lastChecked: new Date().toISOString(),
        });
      }

      res.json({
        success: result.success,
        status: result.status,
        qrCode: result.qrCode,
        qrDataUrl: result.qrDataUrl,
        pairingCode: result.pairingCode,
        user: result.user,
        error: result.error,
      });
    } catch (error: any) {
      console.error("Error checking WhatsApp Personal auth:", error);
      res.status(500).json({ error: error.message || "Failed to check authentication" });
    }
  });

  app.post("/api/whatsapp-personal/logout", requireAuth, requirePermission("MANAGE_CHANNELS"), async (req: Request, res: Response) => {
    try {
      // Get user's actual tenantId for proper tenant isolation
      const user = await storage.getUserByOidcId(req.userId!) || await storage.getUser(req.userId!);
      const tenantId = user?.tenantId;
      
      if (!tenantId) {
        return res.status(403).json({ error: "User not associated with a tenant" });
      }

      const { WhatsAppPersonalAdapter } = await import("./services/whatsapp-personal-adapter");
      const result = await WhatsAppPersonalAdapter.logout(tenantId);

      channelConnectionCache.set("whatsapp_personal", {
        connected: false,
        lastError: undefined,
        lastChecked: new Date().toISOString(),
      });

      res.json(result);
    } catch (error: any) {
      console.error("Error logging out WhatsApp Personal:", error);
      res.status(500).json({ error: error.message || "Failed to logout" });
    }
  });

  app.get("/api/whatsapp-personal/status", requireAuth, requirePermission("MANAGE_CHANNELS"), async (req: Request, res: Response) => {
    try {
      // Get user's actual tenantId for proper tenant isolation
      const user = await storage.getUserByOidcId(req.userId!) || await storage.getUser(req.userId!);
      const tenantId = user?.tenantId;
      
      if (!tenantId) {
        return res.status(403).json({ error: "User not associated with a tenant" });
      }

      const { WhatsAppPersonalAdapter } = await import("./services/whatsapp-personal-adapter");
      const isConnected = WhatsAppPersonalAdapter.isConnected(tenantId);
      const authCheck = await WhatsAppPersonalAdapter.checkAuth(tenantId);

      res.json({
        connected: isConnected,
        status: authCheck.status,
        user: authCheck.user,
      });
    } catch (error: any) {
      console.error("Error checking WhatsApp Personal status:", error);
      res.status(500).json({ error: error.message || "Failed to check status" });
    }
  });

  // ============ MAX PERSONAL ROUTES ============

  app.post("/api/max-personal/start-auth", requireAuth, requirePermission("MANAGE_CHANNELS"), requireActiveSubscription, async (req: Request, res: Response) => {
    try {
      const user = await storage.getUserByOidcId(req.userId!) || await storage.getUser(req.userId!);
      const tenantId = user?.tenantId;
      
      if (!tenantId) {
        return res.status(403).json({ error: "User not associated with a tenant" });
      }

      const { MaxPersonalAdapter } = await import("./services/max-personal-adapter");
      
      const isAvailable = await MaxPersonalAdapter.isServiceAvailable();
      if (!isAvailable) {
        return res.status(503).json({ 
          error: "Max Personal service is not running. Please contact administrator.",
          code: "SERVICE_UNAVAILABLE"
        });
      }

      const result = await MaxPersonalAdapter.startAuth(tenantId);

      if (result.success) {
        if (result.status === "qr_ready") {
          res.json({
            success: true,
            status: "qr_ready",
            qrCode: result.qrCode,
            qrDataUrl: result.qrDataUrl,
          });
        } else if (result.status === "connected") {
          channelConnectionCache.set("max_personal", {
            connected: true,
            lastError: undefined,
            lastChecked: new Date().toISOString(),
          });
          res.json({ success: true, status: "connected", user: result.user });
        } else {
          res.json({ success: true, status: result.status });
        }
      } else {
        res.status(400).json({ success: false, error: result.error });
      }
    } catch (error: any) {
      console.error("Error starting Max Personal auth:", error);
      res.status(500).json({ error: error.message || "Failed to start authentication" });
    }
  });

  app.post("/api/max-personal/check-auth", requireAuth, requirePermission("MANAGE_CHANNELS"), async (req: Request, res: Response) => {
    try {
      const user = await storage.getUserByOidcId(req.userId!) || await storage.getUser(req.userId!);
      const tenantId = user?.tenantId;
      
      if (!tenantId) {
        return res.status(403).json({ error: "User not associated with a tenant" });
      }

      const { MaxPersonalAdapter } = await import("./services/max-personal-adapter");
      const result = await MaxPersonalAdapter.checkAuth(tenantId);

      if (result.status === "connected" && result.user) {
        channelConnectionCache.set("max_personal", {
          connected: true,
          botInfo: {
            user_id: parseInt(result.user.id, 10) || 0,
            first_name: result.user.name,
            username: result.user.phone,
          },
          lastError: undefined,
          lastChecked: new Date().toISOString(),
        });
      }

      res.json({
        success: result.success,
        status: result.status,
        qrCode: result.qrCode,
        qrDataUrl: result.qrDataUrl,
        user: result.user,
        error: result.error,
      });
    } catch (error: any) {
      console.error("Error checking Max Personal auth:", error);
      res.status(500).json({ error: error.message || "Failed to check authentication" });
    }
  });

  app.post("/api/max-personal/logout", requireAuth, requirePermission("MANAGE_CHANNELS"), async (req: Request, res: Response) => {
    try {
      const user = await storage.getUserByOidcId(req.userId!) || await storage.getUser(req.userId!);
      const tenantId = user?.tenantId;
      
      if (!tenantId) {
        return res.status(403).json({ error: "User not associated with a tenant" });
      }

      const { MaxPersonalAdapter } = await import("./services/max-personal-adapter");
      const result = await MaxPersonalAdapter.logout(tenantId);

      channelConnectionCache.set("max_personal", {
        connected: false,
        lastError: undefined,
        lastChecked: new Date().toISOString(),
      });

      res.json(result);
    } catch (error: any) {
      console.error("Error logging out Max Personal:", error);
      res.status(500).json({ error: error.message || "Failed to logout" });
    }
  });

  app.get("/api/max-personal/status", requireAuth, requirePermission("MANAGE_CHANNELS"), async (req: Request, res: Response) => {
    try {
      const user = await storage.getUserByOidcId(req.userId!) || await storage.getUser(req.userId!);
      const tenantId = user?.tenantId;
      
      if (!tenantId) {
        return res.status(403).json({ error: "User not associated with a tenant" });
      }

      const { MaxPersonalAdapter } = await import("./services/max-personal-adapter");
      const isConnected = await MaxPersonalAdapter.isConnected(tenantId);
      const authCheck = await MaxPersonalAdapter.checkAuth(tenantId);

      res.json({
        connected: isConnected,
        status: authCheck.status,
        user: authCheck.user,
      });
    } catch (error: any) {
      console.error("Error checking Max Personal status:", error);
      res.status(500).json({ error: error.message || "Failed to check status" });
    }
  });

  app.get("/api/max-personal/service-status", requireAuth, requirePermission("MANAGE_CHANNELS"), async (req: Request, res: Response) => {
    try {
      const { MaxPersonalAdapter } = await import("./services/max-personal-adapter");
      const isAvailable = await MaxPersonalAdapter.isServiceAvailable();
      res.json({ available: isAvailable });
    } catch (error: any) {
      res.json({ available: false, error: error.message });
    }
  });

  // Incoming message handler from Python service (internal endpoint with shared secret)
  app.post("/api/max-personal/incoming", async (req: Request, res: Response) => {
    try {
      // Validate internal service secret for security (only Python service should call this)
      const internalSecret = req.headers["x-internal-secret"];
      const expectedSecret = process.env.MAX_INTERNAL_SECRET || process.env.SESSION_SECRET;
      
      // Reject if no secret configured (security: require explicit secret)
      if (!expectedSecret || expectedSecret.length < 8) {
        console.warn("[MaxPersonal] Incoming request rejected - internal secret not properly configured");
        return res.status(403).json({ error: "Forbidden" });
      }
      
      if (!internalSecret || internalSecret !== expectedSecret) {
        console.warn("[MaxPersonal] Incoming request rejected - invalid internal secret");
        return res.status(403).json({ error: "Forbidden" });
      }
      
      const { tenant_id, message } = req.body;
      
      if (!tenant_id || !message) {
        return res.status(400).json({ error: "Missing tenant_id or message" });
      }

      // Validate tenant exists
      const tenant = await storage.getTenant(tenant_id);
      if (!tenant) {
        return res.status(400).json({ error: "Invalid tenant" });
      }

      const { MaxPersonalAdapter } = await import("./services/max-personal-adapter");
      const { processIncomingMessageFull } = await import("./services/inbound-message-handler");
      
      // Validate tenant has an active Max Personal session (additional tenant isolation)
      const isConnected = await MaxPersonalAdapter.isConnected(tenant_id);
      if (!isConnected) {
        console.warn(`[MaxPersonal] Incoming message rejected - tenant ${tenant_id} not connected`);
        return res.status(400).json({ error: "Tenant not connected" });
      }
      
      const adapter = new MaxPersonalAdapter(tenant_id);
      const parsed = adapter.parseIncomingMessage(message);
      
      if (parsed) {
        await processIncomingMessageFull(tenant_id, parsed);
        console.log(`[MaxPersonal] Incoming message processed for tenant ${tenant_id}`);
      }

      res.json({ success: true });
    } catch (error: any) {
      console.error("Error processing Max Personal incoming message:", error);
      res.status(500).json({ error: error.message || "Failed to process message" });
    }
  });

  // ============ ADMIN SECURITY ROUTES ============

  app.get("/api/admin/security/readiness", requireAuth, requirePermission("VIEW_AUDIT_LOGS"), async (req: Request, res: Response) => {
    try {
      const { generateSecurityReadinessReport } = await import("./services/security-readiness");
      const report = generateSecurityReadinessReport();
      res.json(report);
    } catch (error) {
      console.error("Error generating security readiness report:", error);
      res.status(500).json({ error: "Failed to generate security readiness report" });
    }
  });

  // System metrics endpoint for monitoring hardware load (platform owner only)
  app.get("/api/admin/system/metrics", requireAuth, async (req: Request, res: Response) => {
    // Check platform owner access
    const user = await storage.getUser(req.userId || "");
    if (!user?.isPlatformOwner) {
      return res.status(403).json({ error: "Platform owner access required" });
    }
    try {
      const os = await import("os");
      
      // CPU usage calculation
      const cpus = os.cpus();
      const cpuCount = cpus.length;
      let totalIdle = 0;
      let totalTick = 0;
      cpus.forEach(cpu => {
        for (const type in cpu.times) {
          totalTick += cpu.times[type as keyof typeof cpu.times];
        }
        totalIdle += cpu.times.idle;
      });
      const cpuUsagePercent = Math.round(((totalTick - totalIdle) / totalTick) * 100);
      
      // Memory usage
      const totalMemory = os.totalmem();
      const freeMemory = os.freemem();
      const usedMemory = totalMemory - freeMemory;
      const memoryUsagePercent = Math.round((usedMemory / totalMemory) * 100);
      
      // System uptime
      const uptimeSeconds = os.uptime();
      const uptimeDays = Math.floor(uptimeSeconds / 86400);
      const uptimeHours = Math.floor((uptimeSeconds % 86400) / 3600);
      const uptimeMinutes = Math.floor((uptimeSeconds % 3600) / 60);
      
      // Load average (1, 5, 15 minutes)
      const loadAverage = os.loadavg();
      
      // Database connection pool stats (if available)
      let dbStats = null;
      try {
        const result = await db.execute(sql`SELECT count(*) as connections FROM pg_stat_activity WHERE datname = current_database()`);
        dbStats = {
          activeConnections: Number(result.rows[0]?.connections || 0)
        };
      } catch (e) {
        // Ignore DB stats errors
      }
      
      // Active user stats from database
      const now = new Date();
      const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      
      let userStats = { totalUsers: 0, activeLast24h: 0, activeLast7d: 0, totalTenants: 0 };
      try {
        const [totalUsersResult, activeLast24hResult, activeLast7dResult, tenantsResult] = await Promise.all([
          db.select({ count: count() }).from(users),
          db.select({ count: count() }).from(users).where(gte(users.lastLoginAt, last24h)),
          db.select({ count: count() }).from(users).where(gte(users.lastLoginAt, last7d)),
          db.select({ count: count() }).from(tenants)
        ]);
        userStats = {
          totalUsers: Number(totalUsersResult[0]?.count || 0),
          activeLast24h: Number(activeLast24hResult[0]?.count || 0),
          activeLast7d: Number(activeLast7dResult[0]?.count || 0),
          totalTenants: Number(tenantsResult[0]?.count || 0)
        };
      } catch (e) {
        // Ignore user stats errors
      }
      
      // Thresholds for recommendations
      const recommendations = [];
      if (cpuUsagePercent > 80) {
        recommendations.push({ type: "cpu", message: "Высокая нагрузка на CPU. Рекомендуется апгрейд." });
      }
      if (memoryUsagePercent > 85) {
        recommendations.push({ type: "memory", message: "Высокое использование памяти. Рекомендуется увеличить RAM." });
      }
      if (loadAverage[0] > cpuCount) {
        recommendations.push({ type: "load", message: "Load average превышает число ядер. Система перегружена." });
      }
      
      res.json({
        cpu: {
          cores: cpuCount,
          usagePercent: cpuUsagePercent,
          model: cpus[0]?.model || "Unknown"
        },
        memory: {
          total: totalMemory,
          used: usedMemory,
          free: freeMemory,
          usagePercent: memoryUsagePercent
        },
        system: {
          platform: os.platform(),
          arch: os.arch(),
          hostname: os.hostname(),
          uptime: {
            seconds: uptimeSeconds,
            formatted: `${uptimeDays}д ${uptimeHours}ч ${uptimeMinutes}м`
          },
          loadAverage: {
            "1min": Math.round(loadAverage[0] * 100) / 100,
            "5min": Math.round(loadAverage[1] * 100) / 100,
            "15min": Math.round(loadAverage[2] * 100) / 100
          }
        },
        database: dbStats,
        users: userStats,
        recommendations,
        generatedAt: new Date().toISOString()
      });
    } catch (error) {
      console.error("Error getting system metrics:", error);
      res.status(500).json({ error: "Failed to get system metrics" });
    }
  });

  // ============ BILLING ROUTES ============

  app.get("/api/billing/me", requireAuth, async (req: Request, res: Response) => {
    try {
      if (!req.userId || req.userId === "system") {
        return res.status(403).json({ error: "User authentication required" });
      }
      const user = await getUserForConversations(req.userId);
      if (!user?.tenantId) {
        return res.status(403).json({ error: "User not associated with a tenant" });
      }

      const { getBillingStatus } = await import("./services/cryptobot-billing");
      const billingStatus = await getBillingStatus(user.tenantId);
      res.json(billingStatus);
    } catch (error: any) {
      console.error("Error fetching billing status:", error);
      res.status(500).json({ error: "Failed to fetch billing status" });
    }
  });

  app.post("/api/billing/checkout", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      if (!req.userId || req.userId === "system") {
        return res.status(403).json({ error: "User authentication required" });
      }
      const user = await getUserForConversations(req.userId);
      if (!user?.tenantId) {
        return res.status(403).json({ error: "User not associated with a tenant" });
      }

      const { createInvoice } = await import("./services/cryptobot-billing");
      
      const baseUrl = `${req.protocol}://${req.get("host")}`;
      const successUrl = `${baseUrl}/settings?billing=success`;

      const result = await createInvoice(user.tenantId, successUrl);

      res.json({ url: result.payUrl, invoiceId: result.invoiceId });
    } catch (error: any) {
      console.error("Error creating crypto invoice:", error);
      res.status(500).json({ error: error.message || "Failed to create payment invoice" });
    }
  });

  app.get("/api/billing/check-invoice/:invoiceId", requireAuth, async (req: Request, res: Response) => {
    try {
      const { invoiceId } = req.params;
      
      if (!req.userId || req.userId === "system") {
        return res.status(403).json({ error: "User authentication required" });
      }
      const user = await getUserForConversations(req.userId);
      if (!user?.tenantId) {
        return res.status(403).json({ error: "User not associated with a tenant" });
      }
      
      const { checkInvoiceStatus, getBillingStatus, getSubscriptionByTenant } = await import("./services/cryptobot-billing");
      
      const subscription = await getSubscriptionByTenant(user.tenantId);
      if (!subscription || subscription.cryptoInvoiceId !== invoiceId) {
        return res.status(403).json({ error: "Invoice not found for your tenant" });
      }
      
      const status = await checkInvoiceStatus(invoiceId);
      const billingStatus = await getBillingStatus(user.tenantId);
      
      res.json({ status, billingStatus });
    } catch (error: any) {
      console.error("Error checking invoice status:", error);
      res.status(500).json({ error: error.message || "Failed to check invoice status" });
    }
  });

  app.post("/api/billing/cancel", requireAuth, requireAdmin, async (req: Request, res: Response) => {
    try {
      if (!req.userId || req.userId === "system") {
        return res.status(403).json({ error: "User authentication required" });
      }
      const user = await getUserForConversations(req.userId);
      if (!user?.tenantId) {
        return res.status(403).json({ error: "User not associated with a tenant" });
      }

      const { cancelSubscription } = await import("./services/cryptobot-billing");
      await cancelSubscription(user.tenantId);
      
      res.json({ success: true, message: "Subscription will be canceled at period end" });
    } catch (error: any) {
      console.error("Error canceling subscription:", error);
      res.status(500).json({ error: error.message || "Failed to cancel subscription" });
    }
  });

  app.post("/webhooks/cryptobot", async (req: Request, res: Response) => {
    try {
      const signature = req.headers["crypto-pay-api-signature"] as string;
      
      const rawBody = req.rawBody instanceof Buffer 
        ? req.rawBody.toString("utf8") 
        : JSON.stringify(req.body);
      
      const { verifyWebhookSignature, handleWebhookEvent } = await import("./services/cryptobot-billing");
      
      if (!signature) {
        console.error("[CryptoBot Webhook] Missing signature header");
        return res.status(400).json({ error: "Missing signature" });
      }
      
      if (!verifyWebhookSignature(rawBody, signature)) {
        console.error("[CryptoBot Webhook] Invalid signature");
        return res.status(400).json({ error: "Invalid signature" });
      }

      await handleWebhookEvent(req.body);
      res.json({ received: true });
    } catch (error: any) {
      console.error("[CryptoBot Webhook] Error:", error);
      res.status(500).json({ error: "Webhook processing failed" });
    }
  });

  // ============ WEBHOOK ROUTES ============

  app.post("/webhooks/telegram", webhookRateLimiter, telegramWebhookHandler);
  app.post("/api/webhook/telegram", webhookRateLimiter, telegramWebhookHandler);

  app.get("/webhooks/whatsapp", whatsappWebhookVerifyHandler);
  app.post("/webhooks/whatsapp", webhookRateLimiter, whatsappWebhookHandler);
  app.get("/api/webhook/whatsapp", whatsappWebhookVerifyHandler);
  app.post("/api/webhook/whatsapp", webhookRateLimiter, whatsappWebhookHandler);

  // ============ MAX WEBHOOK ROUTES ============
  app.use("/webhooks/max", maxWebhookRouter);

  // ============ AUTH ROUTES (email/password) ============
  app.use("/auth", authRouter);

  // ============ PLATFORM ADMIN ROUTES ============
  app.use("/api/admin", adminRouter);

  // ============ PHASE 0 ROUTES ============
  registerPhase0Routes(app);

  return httpServer;
}

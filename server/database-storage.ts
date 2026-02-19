import { eq, desc, and, or, ilike, inArray, sql, gte } from "drizzle-orm";
import { db } from "./db";
import {
  tenants, channels, users, userInvites, emailTokens, customers, customerNotes, customerMemory, conversations, messages,
  products, knowledgeDocs, aiSuggestions, humanActions, aiTrainingSamples, aiTrainingPolicies, learningQueue, escalationEvents,
  responseTemplates, decisionSettings, humanDelaySettings, onboardingState, readinessReports, ragDocuments, ragChunks, csatRatings, conversions, lostDeals,
  updateHistory,
  vehicleLookupCache, vehicleLookupCases,
  priceSnapshots,
} from "@shared/schema";
import {
  type Tenant, type InsertTenant,
  type Channel, type InsertChannel,
  type User, type InsertUser,
  type UserInvite, type InsertUserInvite,
  type EmailToken, type InsertEmailToken,
  type Customer, type InsertCustomer, type UpdateCustomer,
  type CustomerNote, type InsertCustomerNote,
  type CustomerMemory, type InsertCustomerMemory,
  type Conversation, type InsertConversation,
  type Message, type InsertMessage,
  type Product, type InsertProduct,
  type KnowledgeDoc, type InsertKnowledgeDoc,
  type RagDocument, type InsertRagDocument,
  type RagChunk, type InsertRagChunk,
  type AiSuggestion, type InsertAiSuggestion,
  type HumanAction, type InsertHumanAction,
  type AiTrainingSample, type InsertAiTrainingSample,
  type AiTrainingPolicy, type InsertAiTrainingPolicy,
  type LearningQueueItem, type InsertLearningQueueItem,
  type EscalationEvent, type InsertEscalationEvent,
  type ResponseTemplate, type InsertResponseTemplate,
  type DecisionSettings, type InsertDecisionSettings,
  type HumanDelaySettings, type InsertHumanDelaySettings,
  type OnboardingState, type InsertOnboardingState,
  type ReadinessReport, type InsertReadinessReport,
  type CsatRating, type InsertCsatRating,
  type Conversion, type InsertConversion,
  type LostDeal, type InsertLostDeal,
  type UpdateHistory, type InsertUpdateHistory, type UpdateStatus,
  type ConversationWithCustomer,
  type ConversationDetail,
  type DashboardMetrics,
  DEFAULT_DELAY_PROFILES,
  type VehicleLookupCache, type InsertVehicleLookupCache,
  type VehicleLookupCase, type InsertVehicleLookupCase,
  type PriceSnapshot, type InsertPriceSnapshot,
} from "@shared/schema";
import type { IStorage } from "./storage";

export class DatabaseStorage implements IStorage {
  private defaultTenantId: string | null = null;

  async getTenant(id: string): Promise<Tenant | undefined> {
    const [tenant] = await db.select().from(tenants).where(eq(tenants.id, id));
    return tenant;
  }

  async getTenantTemplates(tenantId: string): Promise<{ gearboxLookupFound: string; gearboxLookupModelOnly: string; gearboxTagRequest: string }> {
    const { getMergedGearboxTemplates } = await import("./services/gearbox-templates");
    const tenant = await this.getTenant(tenantId);
    return getMergedGearboxTemplates(tenant ?? undefined);
  }

  async getDefaultTenant(): Promise<Tenant | undefined> {
    if (this.defaultTenantId) {
      return this.getTenant(this.defaultTenantId);
    }
    const [tenant] = await db.select().from(tenants).limit(1);
    if (tenant) {
      this.defaultTenantId = tenant.id;
    }
    return tenant;
  }

  async createTenant(data: InsertTenant): Promise<Tenant> {
    const [tenant] = await db.insert(tenants).values(data).returning();
    if (!this.defaultTenantId) {
      this.defaultTenantId = tenant.id;
    }
    return tenant;
  }

  async updateTenant(id: string, data: Partial<InsertTenant>): Promise<Tenant | undefined> {
    const [tenant] = await db.update(tenants).set(data).where(eq(tenants.id, id)).returning();
    return tenant;
  }

  async getChannel(id: string): Promise<Channel | undefined> {
    const [channel] = await db.select().from(channels).where(eq(channels.id, id));
    return channel;
  }

  async getChannelsByTenant(tenantId: string): Promise<Channel[]> {
    return db.select().from(channels).where(eq(channels.tenantId, tenantId));
  }

  async getChannelsByType(channelType: string): Promise<Channel[]> {
    return db.select().from(channels).where(eq(channels.type, channelType as any));
  }

  async updateChannel(id: string, data: Partial<InsertChannel>): Promise<Channel | undefined> {
    const [channel] = await db.update(channels).set(data).where(eq(channels.id, id)).returning();
    return channel;
  }

  async createChannel(data: InsertChannel): Promise<Channel> {
    const [channel] = await db.insert(channels).values(data).returning();
    return channel;
  }

  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user;
  }

  async getUserByOidcId(oidcId: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.oidcId, oidcId));
    return user;
  }

  async createUser(data: InsertUser): Promise<User> {
    const [user] = await db.insert(users).values(data).returning();
    return user;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase()));
    return user;
  }

  async updateUserLoginAttempts(userId: string, attempts: number, lockedUntil: Date | null): Promise<void> {
    await db.update(users)
      .set({ failedLoginAttempts: attempts, lockedUntil })
      .where(eq(users.id, userId));
  }

  async updateUserLoginSuccess(userId: string): Promise<void> {
    await db.update(users)
      .set({ failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() })
      .where(eq(users.id, userId));
  }

  // User Invites
  async getUserInviteByTokenHash(tokenHash: string): Promise<UserInvite | undefined> {
    const [invite] = await db.select().from(userInvites).where(eq(userInvites.tokenHash, tokenHash));
    return invite;
  }

  async getPendingInviteForEmail(tenantId: string, email: string): Promise<UserInvite | undefined> {
    const [invite] = await db.select().from(userInvites)
      .where(and(
        eq(userInvites.tenantId, tenantId),
        eq(userInvites.email, email.toLowerCase()),
        sql`${userInvites.usedAt} IS NULL`
      ));
    return invite;
  }

  async createUserInvite(data: InsertUserInvite): Promise<UserInvite> {
    const [invite] = await db.insert(userInvites).values(data).returning();
    return invite;
  }

  async markUserInviteUsed(inviteId: string): Promise<void> {
    await db.update(userInvites)
      .set({ usedAt: new Date() })
      .where(eq(userInvites.id, inviteId));
  }

  // Email Token methods
  async createEmailToken(data: InsertEmailToken): Promise<EmailToken> {
    const [token] = await db.insert(emailTokens).values(data).returning();
    return token;
  }

  async getEmailTokenByHash(tokenHash: string): Promise<EmailToken | undefined> {
    const [token] = await db.select().from(emailTokens).where(eq(emailTokens.tokenHash, tokenHash));
    return token;
  }

  async markEmailTokenUsed(tokenId: string): Promise<void> {
    await db.update(emailTokens)
      .set({ usedAt: new Date() })
      .where(eq(emailTokens.id, tokenId));
  }

  async invalidateUserTokens(userId: string, type: string): Promise<void> {
    await db.update(emailTokens)
      .set({ usedAt: new Date() })
      .where(and(
        eq(emailTokens.userId, userId),
        eq(emailTokens.type, type),
        sql`${emailTokens.usedAt} IS NULL`
      ));
  }

  async updateUserEmailVerified(userId: string): Promise<void> {
    await db.update(users)
      .set({ emailVerifiedAt: new Date() })
      .where(eq(users.id, userId));
  }

  async updateUserPassword(userId: string, passwordHash: string): Promise<void> {
    await db.update(users)
      .set({ password: passwordHash, passwordUpdatedAt: new Date() })
      .where(eq(users.id, userId));
  }

  async linkOidcToUser(userId: string, oidcId: string): Promise<void> {
    await db.update(users)
      .set({ oidcId, authProvider: "mixed" })
      .where(eq(users.id, userId));
  }

  async getCustomer(id: string): Promise<Customer | undefined> {
    const [customer] = await db.select().from(customers).where(eq(customers.id, id));
    return customer;
  }

  async getCustomersByTenant(tenantId: string): Promise<Customer[]> {
    return db.select().from(customers).where(eq(customers.tenantId, tenantId));
  }

  async createCustomer(data: InsertCustomer): Promise<Customer> {
    const [customer] = await db.insert(customers).values(data).returning();
    return customer;
  }

  async searchCustomers(tenantId: string, query: string): Promise<Customer[]> {
    return db.select().from(customers).where(
      and(
        eq(customers.tenantId, tenantId),
        or(
          ilike(customers.name, `%${query}%`),
          ilike(customers.phone, `%${query}%`),
          ilike(customers.email, `%${query}%`),
          ilike(customers.externalId, `%${query}%`)
        )
      )
    );
  }

  async getCustomerByExternalId(tenantId: string, channel: string, externalId: string): Promise<Customer | undefined> {
    const [customer] = await db.select().from(customers).where(
      and(
        eq(customers.tenantId, tenantId),
        eq(customers.channel, channel),
        eq(customers.externalId, externalId)
      )
    );
    return customer;
  }

  async updateCustomer(id: string, data: UpdateCustomer): Promise<Customer | undefined> {
    const [customer] = await db.update(customers)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(customers.id, id))
      .returning();
    return customer;
  }

  // Customer Notes
  async getCustomerNote(id: string): Promise<CustomerNote | undefined> {
    const [note] = await db.select().from(customerNotes).where(eq(customerNotes.id, id));
    return note;
  }

  async getCustomerNotes(customerId: string): Promise<CustomerNote[]> {
    return db.select().from(customerNotes)
      .where(eq(customerNotes.customerId, customerId))
      .orderBy(desc(customerNotes.createdAt));
  }

  async createCustomerNote(note: InsertCustomerNote): Promise<CustomerNote> {
    const [created] = await db.insert(customerNotes).values(note).returning();
    return created;
  }

  async deleteCustomerNote(id: string): Promise<boolean> {
    const result = await db.delete(customerNotes).where(eq(customerNotes.id, id));
    return (result.rowCount ?? 0) > 0;
  }

  // Customer Memory
  async getCustomerMemory(tenantId: string, customerId: string): Promise<CustomerMemory | undefined> {
    const [memory] = await db.select().from(customerMemory)
      .where(and(
        eq(customerMemory.tenantId, tenantId),
        eq(customerMemory.customerId, customerId)
      ));
    return memory;
  }

  async upsertCustomerMemory(data: InsertCustomerMemory): Promise<CustomerMemory> {
    const existing = await this.getCustomerMemory(data.tenantId, data.customerId);
    
    if (existing) {
      const [updated] = await db.update(customerMemory)
        .set({
          preferences: data.preferences ?? existing.preferences,
          frequentTopics: data.frequentTopics ?? existing.frequentTopics,
          lastSummaryText: data.lastSummaryText ?? existing.lastSummaryText,
          updatedAt: new Date(),
        })
        .where(eq(customerMemory.id, existing.id))
        .returning();
      return updated;
    }

    const [created] = await db.insert(customerMemory).values({
      ...data,
      preferences: data.preferences ?? {},
      frequentTopics: data.frequentTopics ?? {},
    }).returning();
    return created;
  }

  async incrementFrequentTopic(tenantId: string, customerId: string, intent: string): Promise<CustomerMemory> {
    const existing = await this.getCustomerMemory(tenantId, customerId);
    
    const currentTopics = (existing?.frequentTopics as Record<string, number>) ?? {};
    const newTopics = { ...currentTopics, [intent]: (currentTopics[intent] || 0) + 1 };
    
    if (existing) {
      const [updated] = await db.update(customerMemory)
        .set({ frequentTopics: newTopics, updatedAt: new Date() })
        .where(eq(customerMemory.id, existing.id))
        .returning();
      return updated;
    }

    const [created] = await db.insert(customerMemory).values({
      tenantId,
      customerId,
      preferences: {},
      frequentTopics: newTopics,
    }).returning();
    return created;
  }

  async updateCustomerPreferences(tenantId: string, customerId: string, preferences: Record<string, unknown>): Promise<CustomerMemory> {
    const existing = await this.getCustomerMemory(tenantId, customerId);
    
    if (existing) {
      const merged = { ...(existing.preferences as Record<string, unknown>), ...preferences };
      const [updated] = await db.update(customerMemory)
        .set({ preferences: merged, updatedAt: new Date() })
        .where(eq(customerMemory.id, existing.id))
        .returning();
      return updated;
    }

    const [created] = await db.insert(customerMemory).values({
      tenantId,
      customerId,
      preferences,
      frequentTopics: {},
    }).returning();
    return created;
  }

  async getConversation(id: string): Promise<Conversation | undefined> {
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
    return conv;
  }

  async getConversationWithCustomer(id: string): Promise<ConversationWithCustomer | undefined> {
    const conv = await this.getConversation(id);
    if (!conv) return undefined;

    const customer = await this.getCustomer(conv.customerId);
    if (!customer) return undefined;

    const msgs = await this.getMessagesByConversation(id);
    const lastMessage = msgs.length > 0 ? msgs[msgs.length - 1] : undefined;

    return { ...conv, customer, lastMessage };
  }

  async getConversationDetail(id: string): Promise<ConversationDetail | undefined> {
    const conv = await this.getConversation(id);
    if (!conv) return undefined;

    const customer = await this.getCustomer(conv.customerId);
    if (!customer) return undefined;

    const msgs = await this.getMessagesByConversation(id);
    const suggestion = await this.getPendingSuggestionByConversation(id);

    return { ...conv, customer, messages: msgs, currentSuggestion: suggestion };
  }

  async getConversationsByTenant(tenantId: string): Promise<ConversationWithCustomer[]> {
    const convs = await db.select().from(conversations)
      .where(eq(conversations.tenantId, tenantId))
      .orderBy(desc(conversations.lastMessageAt));

    const result: ConversationWithCustomer[] = [];
    for (const conv of convs) {
      const customer = await this.getCustomer(conv.customerId);
      if (!customer) continue;

      const msgs = await this.getMessagesByConversation(conv.id);
      const lastMessage = msgs.length > 0 ? msgs[msgs.length - 1] : undefined;
      result.push({ ...conv, customer, lastMessage });
    }
    return result;
  }

  async getActiveConversations(tenantId: string): Promise<ConversationWithCustomer[]> {
    const convs = await db.select().from(conversations)
      .where(and(
        eq(conversations.tenantId, tenantId),
        eq(conversations.status, "active")
      ))
      .orderBy(desc(conversations.lastMessageAt));

    const result: ConversationWithCustomer[] = [];
    for (const conv of convs) {
      const customer = await this.getCustomer(conv.customerId);
      if (!customer) continue;

      const msgs = await this.getMessagesByConversation(conv.id);
      const lastMessage = msgs.length > 0 ? msgs[msgs.length - 1] : undefined;
      result.push({ ...conv, customer, lastMessage });
    }
    return result;
  }

  async createConversation(data: InsertConversation & { lastMessageAt?: Date; createdAt?: Date }): Promise<Conversation> {
    const [conv] = await db.insert(conversations).values({
      ...data,
      lastMessageAt: data.lastMessageAt || new Date(),
      createdAt: data.createdAt || new Date(),
    }).returning();
    return conv;
  }

  async updateConversation(id: string, data: Partial<InsertConversation>): Promise<Conversation | undefined> {
    const [conv] = await db.update(conversations).set(data).where(eq(conversations.id, id)).returning();
    return conv;
  }

  async getMessage(id: string): Promise<Message | undefined> {
    const [msg] = await db.select().from(messages).where(eq(messages.id, id));
    return msg;
  }

  async getMessagesByConversation(conversationId: string): Promise<Message[]> {
    return db.select().from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(messages.createdAt);
  }

  async createMessage(data: InsertMessage & { createdAt?: Date }): Promise<Message> {
    const messageTime = data.createdAt || new Date();
    const [msg] = await db.insert(messages).values({
      ...data,
      createdAt: messageTime,
    }).returning();
    
    // Update conversation's lastMessageAt
    await db.update(conversations)
      .set({ lastMessageAt: messageTime })
      .where(eq(conversations.id, data.conversationId));
    
    return msg;
  }

  async getMessagesBySuggestionId(suggestionId: string): Promise<Message[]> {
    const suggestion = await this.getAiSuggestion(suggestionId);
    if (!suggestion) return [];
    return this.getMessagesByConversation(suggestion.conversationId);
  }

  async getProduct(id: string): Promise<Product | undefined> {
    const [product] = await db.select().from(products).where(eq(products.id, id));
    return product;
  }

  async getProductsByTenant(tenantId: string): Promise<Product[]> {
    return db.select().from(products).where(eq(products.tenantId, tenantId));
  }

  async createProduct(data: InsertProduct): Promise<Product> {
    const [product] = await db.insert(products).values(data).returning();
    return product;
  }

  async updateProduct(id: string, data: Partial<InsertProduct>): Promise<Product | undefined> {
    const [product] = await db.update(products).set(data).where(eq(products.id, id)).returning();
    return product;
  }

  async deleteProduct(id: string): Promise<boolean> {
    const result = await db.delete(products).where(eq(products.id, id));
    return true;
  }

  async searchProducts(tenantId: string, query: string): Promise<Product[]> {
    const lowerQuery = `%${query.toLowerCase()}%`;
    return db.select().from(products).where(
      and(
        eq(products.tenantId, tenantId),
        or(
          ilike(products.name, lowerQuery),
          ilike(products.description, lowerQuery),
          ilike(products.category, lowerQuery)
        )
      )
    );
  }

  async getKnowledgeDoc(id: string): Promise<KnowledgeDoc | undefined> {
    const [doc] = await db.select().from(knowledgeDocs).where(eq(knowledgeDocs.id, id));
    return doc;
  }

  async getKnowledgeDocsByTenant(tenantId: string): Promise<KnowledgeDoc[]> {
    return db.select().from(knowledgeDocs).where(eq(knowledgeDocs.tenantId, tenantId));
  }

  async createKnowledgeDoc(data: InsertKnowledgeDoc): Promise<KnowledgeDoc> {
    const [doc] = await db.insert(knowledgeDocs).values(data).returning();
    return doc;
  }

  async updateKnowledgeDoc(id: string, data: Partial<InsertKnowledgeDoc>): Promise<KnowledgeDoc | undefined> {
    const [doc] = await db.update(knowledgeDocs).set(data).where(eq(knowledgeDocs.id, id)).returning();
    return doc;
  }

  async deleteKnowledgeDoc(id: string): Promise<boolean> {
    await db.delete(knowledgeDocs).where(eq(knowledgeDocs.id, id));
    return true;
  }

  async searchKnowledgeDocs(tenantId: string, query: string): Promise<KnowledgeDoc[]> {
    const lowerQuery = `%${query.toLowerCase()}%`;
    return db.select().from(knowledgeDocs).where(
      and(
        eq(knowledgeDocs.tenantId, tenantId),
        eq(knowledgeDocs.isActive, true),
        or(
          ilike(knowledgeDocs.title, lowerQuery),
          ilike(knowledgeDocs.content, lowerQuery)
        )
      )
    );
  }

  async getAiSuggestion(id: string): Promise<AiSuggestion | undefined> {
    const [suggestion] = await db.select().from(aiSuggestions).where(eq(aiSuggestions.id, id));
    return suggestion;
  }

  async getPendingSuggestionByConversation(conversationId: string): Promise<AiSuggestion | undefined> {
    const [suggestion] = await db.select().from(aiSuggestions).where(
      and(
        eq(aiSuggestions.conversationId, conversationId),
        eq(aiSuggestions.status, "pending")
      )
    ).orderBy(desc(aiSuggestions.createdAt)).limit(1);
    return suggestion;
  }

  async getSuggestionsByConversation(conversationId: string): Promise<AiSuggestion[]> {
    return db.select().from(aiSuggestions)
      .where(eq(aiSuggestions.conversationId, conversationId))
      .orderBy(desc(aiSuggestions.createdAt));
  }

  async getSuggestionsByTenant(tenantId: string): Promise<AiSuggestion[]> {
    return db.select({
      id: aiSuggestions.id,
      conversationId: aiSuggestions.conversationId,
      messageId: aiSuggestions.messageId,
      suggestedReply: aiSuggestions.suggestedReply,
      intent: aiSuggestions.intent,
      confidence: aiSuggestions.confidence,
      needsApproval: aiSuggestions.needsApproval,
      needsHandoff: aiSuggestions.needsHandoff,
      questionsToAsk: aiSuggestions.questionsToAsk,
      usedSources: aiSuggestions.usedSources,
      status: aiSuggestions.status,
      createdAt: aiSuggestions.createdAt,
      similarityScore: aiSuggestions.similarityScore,
      intentScore: aiSuggestions.intentScore,
      selfCheckScore: aiSuggestions.selfCheckScore,
      decision: aiSuggestions.decision,
      explanations: aiSuggestions.explanations,
      penalties: aiSuggestions.penalties,
      sourceConflicts: aiSuggestions.sourceConflicts,
      missingFields: aiSuggestions.missingFields,
      autosendEligible: aiSuggestions.autosendEligible,
      autosendBlockReason: aiSuggestions.autosendBlockReason,
      selfCheckNeedHandoff: aiSuggestions.selfCheckNeedHandoff,
      selfCheckReasons: aiSuggestions.selfCheckReasons,
    }).from(aiSuggestions)
      .innerJoin(conversations, eq(aiSuggestions.conversationId, conversations.id))
      .where(eq(conversations.tenantId, tenantId))
      .orderBy(desc(aiSuggestions.createdAt));
  }

  async createAiSuggestion(data: InsertAiSuggestion): Promise<AiSuggestion> {
    const [suggestion] = await db.insert(aiSuggestions).values(data).returning();
    return suggestion;
  }

  async updateAiSuggestion(id: string, data: Partial<InsertAiSuggestion>): Promise<AiSuggestion | undefined> {
    const [suggestion] = await db.update(aiSuggestions).set(data).where(eq(aiSuggestions.id, id)).returning();
    return suggestion;
  }

  async createHumanAction(data: InsertHumanAction): Promise<HumanAction> {
    const [action] = await db.insert(humanActions).values(data).returning();
    return action;
  }

  async createAiTrainingSample(data: InsertAiTrainingSample): Promise<AiTrainingSample> {
    const [sample] = await db.insert(aiTrainingSamples).values(data).returning();
    return sample;
  }

  async getAiTrainingSamplesByTenant(tenantId: string, outcome?: string): Promise<AiTrainingSample[]> {
    if (outcome) {
      return db.select().from(aiTrainingSamples)
        .where(and(
          eq(aiTrainingSamples.tenantId, tenantId),
          eq(aiTrainingSamples.outcome, outcome)
        ))
        .orderBy(desc(aiTrainingSamples.createdAt));
    }
    return db.select().from(aiTrainingSamples)
      .where(eq(aiTrainingSamples.tenantId, tenantId))
      .orderBy(desc(aiTrainingSamples.createdAt));
  }

  async getAiTrainingSamplesCount(tenantId: string): Promise<number> {
    const result = await db.select({ count: sql<number>`count(*)` })
      .from(aiTrainingSamples)
      .where(eq(aiTrainingSamples.tenantId, tenantId));
    return Number(result[0]?.count || 0);
  }

  async getAiTrainingPolicy(tenantId: string): Promise<AiTrainingPolicy | undefined> {
    const [policy] = await db.select().from(aiTrainingPolicies).where(eq(aiTrainingPolicies.tenantId, tenantId));
    return policy;
  }

  async upsertAiTrainingPolicy(data: InsertAiTrainingPolicy): Promise<AiTrainingPolicy> {
    const [policy] = await db.insert(aiTrainingPolicies)
      .values({
        ...data,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: aiTrainingPolicies.tenantId,
        set: {
          alwaysEscalateIntents: data.alwaysEscalateIntents,
          forbiddenTopics: data.forbiddenTopics,
          disabledLearningIntents: data.disabledLearningIntents,
          updatedAt: new Date(),
        },
      })
      .returning();
    return policy;
  }

  async createLearningQueueItem(data: InsertLearningQueueItem): Promise<LearningQueueItem> {
    const [item] = await db.insert(learningQueue).values(data).returning();
    return item;
  }

  async getLearningQueueByTenant(tenantId: string, minScore?: number): Promise<LearningQueueItem[]> {
    if (minScore !== undefined) {
      return db.select().from(learningQueue)
        .where(and(
          eq(learningQueue.tenantId, tenantId),
          eq(learningQueue.status, "pending"),
          sql`${learningQueue.learningScore} >= ${minScore}`
        ))
        .orderBy(desc(learningQueue.learningScore));
    }
    return db.select().from(learningQueue)
      .where(and(
        eq(learningQueue.tenantId, tenantId),
        eq(learningQueue.status, "pending")
      ))
      .orderBy(desc(learningQueue.learningScore));
  }

  async getLearningQueueItem(conversationId: string): Promise<LearningQueueItem | undefined> {
    const [item] = await db.select().from(learningQueue)
      .where(eq(learningQueue.conversationId, conversationId));
    return item;
  }

  async updateLearningQueueItem(id: string, data: Partial<InsertLearningQueueItem>): Promise<LearningQueueItem | undefined> {
    const updateData: Record<string, unknown> = { ...data };
    if (data.status === "reviewed") {
      updateData.reviewedAt = new Date();
    }
    const [item] = await db.update(learningQueue).set(updateData).where(eq(learningQueue.id, id)).returning();
    return item;
  }

  async upsertLearningQueueItem(data: InsertLearningQueueItem): Promise<LearningQueueItem> {
    const existing = await this.getLearningQueueItem(data.conversationId);
    if (existing) {
      const newScore = Math.max(existing.learningScore, data.learningScore ?? 0);
      const newReasons = [...new Set([...(existing.reasons ?? []), ...(data.reasons ?? [])])];
      const updated = await this.updateLearningQueueItem(existing.id, {
        learningScore: newScore,
        reasons: newReasons,
      });
      return updated!;
    }
    return this.createLearningQueueItem(data);
  }

  async getEscalationEvent(id: string): Promise<EscalationEvent | undefined> {
    const [event] = await db.select().from(escalationEvents).where(eq(escalationEvents.id, id));
    return event;
  }

  async getEscalationsByTenant(tenantId: string): Promise<EscalationEvent[]> {
    const convs = await db.select().from(conversations).where(eq(conversations.tenantId, tenantId));
    const convIds = convs.map(c => c.id);
    if (convIds.length === 0) return [];
    
    return db.select().from(escalationEvents).where(
      inArray(escalationEvents.conversationId, convIds)
    ).orderBy(desc(escalationEvents.createdAt));
  }

  async getRecentEscalations(tenantId: string, limit: number): Promise<EscalationEvent[]> {
    const all = await this.getEscalationsByTenant(tenantId);
    return all.slice(0, limit);
  }

  async createEscalationEvent(data: InsertEscalationEvent): Promise<EscalationEvent> {
    const [event] = await db.insert(escalationEvents).values(data).returning();
    return event;
  }

  async updateEscalationEvent(id: string, data: Partial<InsertEscalationEvent>): Promise<EscalationEvent | undefined> {
    const [event] = await db.update(escalationEvents).set(data).where(eq(escalationEvents.id, id)).returning();
    return event;
  }

  async getTemplatesByTenant(tenantId: string): Promise<ResponseTemplate[]> {
    return db.select().from(responseTemplates).where(eq(responseTemplates.tenantId, tenantId));
  }

  async createTemplate(data: InsertResponseTemplate): Promise<ResponseTemplate> {
    const [template] = await db.insert(responseTemplates).values(data).returning();
    return template;
  }

  async getDashboardMetrics(tenantId: string): Promise<DashboardMetrics> {
    const convs = await db.select().from(conversations).where(eq(conversations.tenantId, tenantId));
    const prods = await db.select().from(products).where(eq(products.tenantId, tenantId));
    const docs = await db.select().from(knowledgeDocs).where(eq(knowledgeDocs.tenantId, tenantId));

    const convIds = convs.map(c => c.id);
    let pendingSuggestions = 0;
    if (convIds.length > 0) {
      const suggestions = await db.select().from(aiSuggestions).where(
        and(
          inArray(aiSuggestions.conversationId, convIds),
          eq(aiSuggestions.status, "pending")
        )
      );
      pendingSuggestions = suggestions.length;
    }

    return {
      totalConversations: convs.length,
      activeConversations: convs.filter(c => c.status === "active").length,
      escalatedConversations: convs.filter(c => c.status === "escalated").length,
      resolvedToday: 0,
      avgResponseTime: 12,
      aiAccuracy: 0,
      pendingSuggestions,
      productsCount: prods.length,
      knowledgeDocsCount: docs.length,
    };
  }

  async getDecisionSettings(tenantId: string): Promise<DecisionSettings | undefined> {
    const [settings] = await db.select().from(decisionSettings).where(eq(decisionSettings.tenantId, tenantId));
    return settings;
  }

  async upsertDecisionSettings(data: InsertDecisionSettings): Promise<DecisionSettings> {
    const existing = await this.getDecisionSettings(data.tenantId);
    if (existing) {
      const [updated] = await db.update(decisionSettings)
        .set(data)
        .where(eq(decisionSettings.tenantId, data.tenantId))
        .returning();
      return updated;
    } else {
      const [created] = await db.insert(decisionSettings).values(data).returning();
      return created;
    }
  }

  async getHumanDelaySettings(tenantId: string): Promise<HumanDelaySettings | undefined> {
    const [settings] = await db.select().from(humanDelaySettings).where(eq(humanDelaySettings.tenantId, tenantId));
    if (settings) return settings;
    
    return {
      tenantId,
      enabled: false,
      delayProfiles: DEFAULT_DELAY_PROFILES,
      nightMode: "DELAY",
      nightDelayMultiplier: 3.0,
      nightAutoReplyText: "Спасибо за сообщение! Мы ответим в рабочее время.",
      minDelayMs: 3000,
      maxDelayMs: 120000,
      typingIndicatorEnabled: true,
      updatedAt: new Date(),
    };
  }

  async upsertHumanDelaySettings(data: InsertHumanDelaySettings): Promise<HumanDelaySettings> {
    const existing = await db.select().from(humanDelaySettings).where(eq(humanDelaySettings.tenantId, data.tenantId));
    if (existing.length > 0) {
      const [updated] = await db.update(humanDelaySettings)
        .set(data)
        .where(eq(humanDelaySettings.tenantId, data.tenantId))
        .returning();
      return updated;
    } else {
      const [created] = await db.insert(humanDelaySettings).values(data).returning();
      return created;
    }
  }

  async getOnboardingState(tenantId: string): Promise<OnboardingState | undefined> {
    const [state] = await db.select().from(onboardingState).where(eq(onboardingState.tenantId, tenantId));
    return state;
  }

  async upsertOnboardingState(data: InsertOnboardingState): Promise<OnboardingState> {
    const existing = await this.getOnboardingState(data.tenantId);
    if (existing) {
      const [updated] = await db.update(onboardingState)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(onboardingState.tenantId, data.tenantId))
        .returning();
      return updated;
    } else {
      const [created] = await db.insert(onboardingState).values(data).returning();
      return created;
    }
  }

  async createReadinessReport(data: InsertReadinessReport): Promise<ReadinessReport> {
    const [report] = await db.insert(readinessReports).values(data).returning();
    return report;
  }

  async getLatestReadinessReport(tenantId: string): Promise<ReadinessReport | undefined> {
    const [report] = await db.select()
      .from(readinessReports)
      .where(eq(readinessReports.tenantId, tenantId))
      .orderBy(desc(readinessReports.createdAt))
      .limit(1);
    return report;
  }

  // Phase 8: CSAT Ratings
  async createCsatRating(data: InsertCsatRating): Promise<CsatRating> {
    const [rating] = await db.insert(csatRatings).values(data).returning();
    return rating;
  }

  async getCsatRatingByConversation(conversationId: string): Promise<CsatRating | undefined> {
    const [rating] = await db.select()
      .from(csatRatings)
      .where(eq(csatRatings.conversationId, conversationId));
    return rating;
  }

  async getCsatRatingsByTenant(tenantId: string): Promise<CsatRating[]> {
    return db.select()
      .from(csatRatings)
      .where(eq(csatRatings.tenantId, tenantId))
      .orderBy(desc(csatRatings.createdAt));
  }

  // Conversion methods
  async createConversion(data: InsertConversion): Promise<Conversion> {
    const [conversion] = await db.insert(conversions).values({
      ...data,
      currency: data.currency ?? "RUB",
    }).returning();
    return conversion;
  }

  async getConversionByConversation(conversationId: string): Promise<Conversion | undefined> {
    const [conversion] = await db.select()
      .from(conversions)
      .where(eq(conversions.conversationId, conversationId));
    return conversion;
  }

  async getConversionsByTenant(tenantId: string): Promise<Conversion[]> {
    return db.select()
      .from(conversions)
      .where(eq(conversions.tenantId, tenantId))
      .orderBy(desc(conversions.createdAt));
  }

  // Lost Deals methods
  async createLostDeal(data: InsertLostDeal): Promise<LostDeal> {
    const [lostDeal] = await db.insert(lostDeals).values(data).returning();
    return lostDeal;
  }

  async getLostDealByConversation(conversationId: string): Promise<LostDeal | undefined> {
    const [lostDeal] = await db.select()
      .from(lostDeals)
      .where(eq(lostDeals.conversationId, conversationId));
    return lostDeal;
  }

  async getLostDealsByTenant(tenantId: string): Promise<LostDeal[]> {
    return db.select()
      .from(lostDeals)
      .where(eq(lostDeals.tenantId, tenantId))
      .orderBy(desc(lostDeals.createdAt));
  }

  async ensureDefaultTenant(): Promise<Tenant> {
    let tenant = await this.getDefaultTenant();
    if (!tenant) {
      tenant = await this.createTenant({
        name: "Demo Store",
        language: "ru",
        tone: "formal",
        addressStyle: "vy",
        currency: "RUB",
        timezone: "Europe/Moscow",
        workingHoursStart: "09:00",
        workingHoursEnd: "18:00",
        workingDays: ["mon", "tue", "wed", "thu", "fri"],
        autoReplyOutsideHours: true,
        escalationEmail: "owner@example.com",
        allowDiscounts: true,
        maxDiscountPercent: 10,
      });
    }
    return tenant;
  }

  // Metrics methods
  async getCustomersCount(tenantId: string): Promise<number> {
    const result = await db.select({ count: sql<number>`count(*)::int` })
      .from(customers)
      .where(eq(customers.tenantId, tenantId));
    return result[0]?.count ?? 0;
  }

  async getCustomerNotesCount(tenantId: string): Promise<number> {
    const result = await db.select({ count: sql<number>`count(*)::int` })
      .from(customerNotes)
      .innerJoin(customers, eq(customerNotes.customerId, customers.id))
      .where(eq(customers.tenantId, tenantId));
    return result[0]?.count ?? 0;
  }

  async getCustomerMemoryCount(tenantId: string): Promise<number> {
    const result = await db.select({ count: sql<number>`count(*)::int` })
      .from(customerMemory)
      .where(eq(customerMemory.tenantId, tenantId));
    return result[0]?.count ?? 0;
  }

  async createRagDocument(doc: InsertRagDocument): Promise<RagDocument> {
    const [created] = await db.insert(ragDocuments).values(doc).returning();
    return created;
  }

  async createRagChunk(chunk: InsertRagChunk): Promise<RagChunk> {
    const [created] = await db.insert(ragChunks).values(chunk).returning();
    return created;
  }

  async deleteRagBySource(tenantId: string, sourceType: "PRODUCT" | "DOC", sourceId: string): Promise<{ deletedDocs: number }> {
    const deleted = await db.delete(ragDocuments)
      .where(and(
        eq(ragDocuments.tenantId, tenantId),
        eq(ragDocuments.type, sourceType),
        eq(ragDocuments.sourceId, sourceId)
      ))
      .returning({ id: ragDocuments.id });
    return { deletedDocs: deleted.length };
  }

  async updateRagChunkEmbedding(chunkId: string, embedding: number[]): Promise<boolean> {
    const embeddingJson = JSON.stringify(embedding);
    const result = await db.update(ragChunks)
      .set({ embedding: embeddingJson, updatedAt: new Date() })
      .where(eq(ragChunks.id, chunkId))
      .returning({ id: ragChunks.id });
    return result.length > 0;
  }

  async getRagChunksBySource(tenantId: string, sourceType: "PRODUCT" | "DOC", sourceId: string): Promise<{ id: string; chunkText: string; embedding: number[] | null }[]> {
    const docs = await db.select({ id: ragDocuments.id })
      .from(ragDocuments)
      .where(and(
        eq(ragDocuments.tenantId, tenantId),
        eq(ragDocuments.type, sourceType),
        eq(ragDocuments.sourceId, sourceId)
      ));
    
    if (docs.length === 0) return [];
    
    const docIds = docs.map(d => d.id);
    const rows = await db.select({
      id: ragChunks.id,
      chunkText: ragChunks.chunkText,
      embedding: ragChunks.embedding,
    })
      .from(ragChunks)
      .where(inArray(ragChunks.ragDocumentId, docIds));
    
    return rows.map(row => ({
      id: row.id,
      chunkText: row.chunkText,
      embedding: row.embedding ? JSON.parse(row.embedding) as number[] : null,
    }));
  }

  async getRagChunksWithoutEmbedding(tenantId: string, limit = 100): Promise<{ id: string; chunkText: string }[]> {
    const docs = await db.select({ id: ragDocuments.id })
      .from(ragDocuments)
      .where(eq(ragDocuments.tenantId, tenantId));
    
    if (docs.length === 0) return [];
    
    const docIds = docs.map(d => d.id);
    const chunks = await db.select({
      id: ragChunks.id,
      chunkText: ragChunks.chunkText,
    })
      .from(ragChunks)
      .where(and(
        inArray(ragChunks.ragDocumentId, docIds),
        sql`${ragChunks.embedding} IS NULL`
      ))
      .limit(limit);
    
    return chunks;
  }

  async getRagChunksWithStaleHash(tenantId: string, limit = 100): Promise<{ id: string; chunkText: string; storedHash: string | null; currentHash: string }[]> {
    const { computeContentHash } = await import("./services/rag-indexer");
    
    const docs = await db.select({ id: ragDocuments.id })
      .from(ragDocuments)
      .where(eq(ragDocuments.tenantId, tenantId));
    
    if (docs.length === 0) return [];
    
    const docIds = docs.map(d => d.id);
    const chunks = await db.select({
      id: ragChunks.id,
      chunkText: ragChunks.chunkText,
      metadata: ragChunks.metadata,
      embedding: ragChunks.embedding,
    })
      .from(ragChunks)
      .where(and(
        inArray(ragChunks.ragDocumentId, docIds),
        sql`${ragChunks.embedding} IS NOT NULL`
      ))
      .limit(limit * 10);
    
    const staleChunks: { id: string; chunkText: string; storedHash: string | null; currentHash: string }[] = [];
    
    for (const chunk of chunks) {
      const storedHash = (chunk.metadata as Record<string, unknown>)?.contentHash as string | null;
      const currentHash = computeContentHash(chunk.chunkText);
      
      if (storedHash !== currentHash) {
        staleChunks.push({
          id: chunk.id,
          chunkText: chunk.chunkText,
          storedHash,
          currentHash,
        });
        if (staleChunks.length >= limit) break;
      }
    }
    
    return staleChunks;
  }

  async invalidateStaleEmbeddings(tenantId: string): Promise<{ invalidated: number }> {
    const staleChunks = await this.getRagChunksWithStaleHash(tenantId, 1000);
    
    if (staleChunks.length === 0) return { invalidated: 0 };
    
    const staleIds = staleChunks.map(c => c.id);
    await db.update(ragChunks)
      .set({ embedding: null, updatedAt: new Date() })
      .where(inArray(ragChunks.id, staleIds));
    
    return { invalidated: staleChunks.length };
  }

  async getAllRagChunksWithEmbedding(tenantId: string): Promise<{ id: string; chunkText: string; chunkIndex: number; embedding: string | null; metadata: unknown }[]> {
    const docs = await db.select({ id: ragDocuments.id })
      .from(ragDocuments)
      .where(eq(ragDocuments.tenantId, tenantId));
    
    if (docs.length === 0) return [];
    
    const docIds = docs.map(d => d.id);
    const chunks = await db.select({
      id: ragChunks.id,
      chunkText: ragChunks.chunkText,
      chunkIndex: ragChunks.chunkIndex,
      embedding: ragChunks.embedding,
      metadata: ragChunks.metadata,
    })
      .from(ragChunks)
      .where(and(
        inArray(ragChunks.ragDocumentId, docIds),
        sql`${ragChunks.embedding} IS NOT NULL`
      ));
    
    return chunks;
  }

  // Update History methods
  async getUpdateHistory(): Promise<UpdateHistory[]> {
    return db.select().from(updateHistory).orderBy(desc(updateHistory.createdAt));
  }

  async getUpdateById(id: string): Promise<UpdateHistory | undefined> {
    const [update] = await db.select().from(updateHistory).where(eq(updateHistory.id, id));
    return update;
  }

  async createUpdate(update: InsertUpdateHistory): Promise<UpdateHistory> {
    const [created] = await db.insert(updateHistory).values(update).returning();
    return created;
  }

  async updateUpdateStatus(id: string, status: UpdateStatus, errorMessage?: string): Promise<UpdateHistory | undefined> {
    const updateData: Partial<UpdateHistory> = { status };
    if (status === "applied") {
      updateData.appliedAt = new Date();
    }
    if (errorMessage) {
      updateData.errorMessage = errorMessage;
    }
    const [updated] = await db.update(updateHistory)
      .set(updateData)
      .where(eq(updateHistory.id, id))
      .returning();
    return updated;
  }

  async setUpdateBackupPath(id: string, backupPath: string): Promise<UpdateHistory | undefined> {
    const [updated] = await db.update(updateHistory)
      .set({ backupPath })
      .where(eq(updateHistory.id, id))
      .returning();
    return updated;
  }

  async getCurrentVersion(): Promise<string> {
    const [lastApplied] = await db.select()
      .from(updateHistory)
      .where(eq(updateHistory.status, "applied"))
      .orderBy(desc(updateHistory.appliedAt))
      .limit(1);
    return lastApplied?.version || "1.0.0";
  }

  // Vehicle Lookup Cache
  async getVehicleLookupCacheByKey(lookupKey: string): Promise<VehicleLookupCache | undefined> {
    const [row] = await db.select().from(vehicleLookupCache).where(eq(vehicleLookupCache.lookupKey, lookupKey));
    return row;
  }

  async upsertVehicleLookupCache(data: InsertVehicleLookupCache): Promise<VehicleLookupCache> {
    const [row] = await db.insert(vehicleLookupCache)
      .values(data)
      .onConflictDoUpdate({
        target: vehicleLookupCache.lookupKey,
        set: {
          idType: data.idType,
          rawValue: data.rawValue,
          normalizedValue: data.normalizedValue,
          result: data.result,
          source: data.source,
          updatedAt: new Date(),
          expiresAt: data.expiresAt ?? null,
        },
      })
      .returning();
    return row;
  }

  async linkCaseToCache(caseId: string, cacheId: string): Promise<void> {
    await db.update(vehicleLookupCases)
      .set({ cacheId, updatedAt: new Date() })
      .where(eq(vehicleLookupCases.id, caseId));
  }

  // Vehicle Lookup Cases
  async createVehicleLookupCase(data: InsertVehicleLookupCase): Promise<VehicleLookupCase> {
    const [row] = await db.insert(vehicleLookupCases).values(data).returning();
    return row;
  }

  async getVehicleLookupCaseById(caseId: string): Promise<VehicleLookupCase | undefined> {
    const [row] = await db.select().from(vehicleLookupCases).where(eq(vehicleLookupCases.id, caseId));
    return row;
  }

  async getLatestVehicleLookupCaseByConversation(tenantId: string, conversationId: string): Promise<VehicleLookupCase | undefined> {
    const [row] = await db.select()
      .from(vehicleLookupCases)
      .where(and(
        eq(vehicleLookupCases.tenantId, tenantId),
        eq(vehicleLookupCases.conversationId, conversationId)
      ))
      .orderBy(desc(vehicleLookupCases.createdAt))
      .limit(1);
    return row;
  }

  async findActiveVehicleLookupCase(tenantId: string, conversationId: string, normalizedValue: string): Promise<VehicleLookupCase | undefined> {
    const cutoff = new Date(Date.now() - 5 * 60 * 1000); // 5 minutes ago
    const [row] = await db.select()
      .from(vehicleLookupCases)
      .where(and(
        eq(vehicleLookupCases.tenantId, tenantId),
        eq(vehicleLookupCases.conversationId, conversationId),
        eq(vehicleLookupCases.normalizedValue, normalizedValue),
        inArray(vehicleLookupCases.status, ["PENDING", "RUNNING"]),
        gte(vehicleLookupCases.createdAt, cutoff)
      ))
      .orderBy(desc(vehicleLookupCases.createdAt))
      .limit(1);
    return row;
  }

  async updateVehicleLookupCaseStatus(
    caseId: string,
    patch: { status?: VehicleLookupCase["status"]; verificationStatus?: VehicleLookupCase["verificationStatus"]; error?: string | null; cacheId?: string | null }
  ): Promise<VehicleLookupCase | undefined> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.verificationStatus !== undefined) set.verificationStatus = patch.verificationStatus;
    if (patch.error !== undefined) set.error = patch.error;
    if (patch.cacheId !== undefined) set.cacheId = patch.cacheId;
    const [row] = await db.update(vehicleLookupCases)
      .set(set as Partial<VehicleLookupCase>)
      .where(eq(vehicleLookupCases.id, caseId))
      .returning();
    return row;
  }

  // Price Snapshots

  async createPriceSnapshot(data: InsertPriceSnapshot): Promise<PriceSnapshot> {
    const [row] = await db.insert(priceSnapshots).values(data).returning();
    return row;
  }

  async getLatestPriceSnapshot(tenantId: string, oem: string, maxAgeMinutes: number): Promise<PriceSnapshot | undefined> {
    const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000);
    const [row] = await db.select()
      .from(priceSnapshots)
      .where(and(
        eq(priceSnapshots.tenantId, tenantId),
        eq(priceSnapshots.oem, oem),
        gte(priceSnapshots.createdAt, cutoff)
      ))
      .orderBy(desc(priceSnapshots.createdAt))
      .limit(1);
    return row;
  }
}

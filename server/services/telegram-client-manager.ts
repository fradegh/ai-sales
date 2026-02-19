import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions";
import { NewMessage, NewMessageEvent } from "telegram/events";
import { storage } from "../storage";
import { getSecret } from "./secret-resolver";
import { processIncomingMessageFull } from "./inbound-message-handler";
import { featureFlagService } from "./feature-flags";

interface ActiveConnection {
  tenantId: string;
  channelId: string;
  client: TelegramClient;
  sessionString: string;
  connected: boolean;
  lastActivity: Date;
  handlersAttached: boolean;
}

class TelegramClientManager {
  private connections = new Map<string, ActiveConnection>();
  private reconnectTimers = new Map<string, NodeJS.Timeout>();
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private isInitialized = false;

  private async getCredentials(): Promise<{ apiId: number; apiHash: string } | null> {
    const [dbApiId, dbApiHash] = await Promise.all([
      getSecret({ scope: "global", keyName: "TELEGRAM_API_ID" }),
      getSecret({ scope: "global", keyName: "TELEGRAM_API_HASH" }),
    ]);

    if (dbApiId && dbApiHash) {
      const apiId = parseInt(dbApiId, 10);
      if (!isNaN(apiId) && apiId > 0) {
        return { apiId, apiHash: dbApiHash };
      }
    }

    const envApiId = process.env.TELEGRAM_API_ID;
    const envApiHash = process.env.TELEGRAM_API_HASH;

    if (envApiId && envApiHash) {
      const apiId = parseInt(envApiId, 10);
      if (!isNaN(apiId) && apiId > 0) {
        return { apiId, apiHash: envApiHash };
      }
    }

    return null;
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      console.log("[TelegramClientManager] Already initialized");
      return;
    }

    const isEnabled = await featureFlagService.isEnabled("TELEGRAM_PERSONAL_CHANNEL_ENABLED");
    if (!isEnabled) {
      console.log("[TelegramClientManager] Feature flag disabled, skipping initialization");
      return;
    }

    console.log("[TelegramClientManager] Initializing...");

    try {
      const channels = await storage.getChannelsByType("telegram_personal");
      console.log(`[TelegramClientManager] Found ${channels.length} Telegram Personal channels`);

      for (const channel of channels) {
        const config = channel.config as { sessionData?: string } | null;
        console.log(`[TelegramClientManager] Channel ${channel.id}: isActive=${channel.isActive}, hasSession=${!!config?.sessionData}, sessionLen=${config?.sessionData?.length || 0}`);
        
        if (channel.isActive && config?.sessionData) {
          try {
            const connected = await this.connect(channel.tenantId, channel.id, config.sessionData);
            console.log(`[TelegramClientManager] Channel ${channel.id} connect result: ${connected}`);
          } catch (error: any) {
            console.error(`[TelegramClientManager] Failed to connect channel ${channel.id}:`, error.message);
          }
        } else {
          console.log(`[TelegramClientManager] Skipping channel ${channel.id}: inactive or no session`);
        }
      }

      this.isInitialized = true;
      console.log(`[TelegramClientManager] Initialized with ${this.connections.size} active connections`);
      
      this.startHealthCheck();
    } catch (error: any) {
      console.error("[TelegramClientManager] Initialization error:", error.message);
    }
  }
  
  private startHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }
    
    this.healthCheckTimer = setInterval(async () => {
      await this.cleanupInactiveChannels();
    }, 60000);

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    this.heartbeatTimer = setInterval(async () => {
      await this.heartbeatCheck();
    }, 15000);
  }

  private async heartbeatCheck(): Promise<void> {
    const activeCount = this.connections.size;
    if (activeCount === 0) return;

    console.log(`[TelegramClientManager] Heartbeat: ${activeCount} active connections`);
    
    for (const [key, connection] of Array.from(this.connections.entries())) {
      try {
        await connection.client.getMe();
        console.log(`[TelegramClientManager] Heartbeat OK: ${key}`);
      } catch (error: any) {
        console.error(`[TelegramClientManager] Heartbeat FAILED: ${key} - ${error.message}`);
        connection.connected = false;
        this.scheduleReconnect(connection.tenantId, connection.channelId, connection.sessionString);
      }
    }
  }
  
  private async cleanupInactiveChannels(): Promise<void> {
    try {
      for (const [key, connection] of Array.from(this.connections.entries())) {
        const channel = await storage.getChannel(connection.channelId);
        
        if (!channel || !channel.isActive) {
          console.log(`[TelegramClientManager] Cleaning up inactive channel: ${key}`);
          await this.disconnect(connection.tenantId, connection.channelId);
        }
      }
    } catch (error: any) {
      console.error("[TelegramClientManager] Health check error:", error.message);
    }
  }

  async connect(tenantId: string, channelId: string, sessionString: string): Promise<boolean> {
    const connectionKey = `${tenantId}:${channelId}`;

    const existing = this.connections.get(connectionKey);
    if (existing?.connected && existing.handlersAttached) {
      console.log(`[TelegramClientManager] Already connected and running: ${connectionKey}`);
      return true;
    }

    if (existing) {
      console.log(`[TelegramClientManager] Cleaning up stale connection: ${connectionKey}`);
      try {
        await existing.client.disconnect();
      } catch {}
      this.connections.delete(connectionKey);
    }

    const existingTimer = this.reconnectTimers.get(connectionKey);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.reconnectTimers.delete(connectionKey);
    }

    const credentials = await this.getCredentials();
    if (!credentials) {
      console.error("[TelegramClientManager] No credentials available");
      return false;
    }

    try {
      const { apiId, apiHash } = credentials;
      const session = new StringSession(sessionString);
      const client = new TelegramClient(session, apiId, apiHash, {
        connectionRetries: 5,
      });

      console.log(`[TelegramClientManager] Connecting client for ${connectionKey}...`);
      await client.connect();
      console.log(`[TelegramClientManager] Client connected for ${connectionKey}, checking auth...`);

      const isAuthorized = await client.isUserAuthorized();
      console.log(`[TelegramClientManager] isUserAuthorized for ${connectionKey}: ${isAuthorized}`);
      
      if (!isAuthorized) {
        console.error(`[TelegramClientManager] Session invalid for ${connectionKey}`);
        return false;
      }

      const me = await client.getMe();
      console.log(`[TelegramClientManager] Warmup getMe() for ${connectionKey}: ${(me as any)?.firstName || 'OK'}`);

      const connection: ActiveConnection = {
        tenantId,
        channelId,
        client,
        sessionString,
        connected: true,
        lastActivity: new Date(),
        handlersAttached: false,
      };
      
      this.connections.set(connectionKey, connection);

      this.ensureHandlers(connection);
      
      // Preload dialogs to populate entity cache for sending messages
      try {
        const dialogs = await client.getDialogs({ limit: 100 });
        console.log(`[TelegramClientManager] Preloaded ${dialogs.length} dialogs for entity cache`);
      } catch (dialogError: any) {
        console.log(`[TelegramClientManager] Could not preload dialogs: ${dialogError.message}`);
      }

      console.log(`[TelegramClientManager] Connected: ${connectionKey}, total connections: ${this.connections.size}`);
      return true;
    } catch (error: any) {
      console.error(`[TelegramClientManager] Connection error for ${connectionKey}:`, error.message);
      this.scheduleReconnect(tenantId, channelId, sessionString);
      return false;
    }
  }

  private ensureHandlers(connection: ActiveConnection): void {
    if (connection.handlersAttached) {
      console.log(`[TelegramClientManager] Handlers already attached for ${connection.tenantId}:${connection.channelId}`);
      return;
    }

    const connectionKey = `${connection.tenantId}:${connection.channelId}`;
    console.log(`[TelegramClientManager] Attaching NewMessage handler for ${connectionKey}`);

    connection.client.addEventHandler(
      (event: NewMessageEvent) => {
        const msg = event.message;
        console.log(`[TG EVENT] ${connectionKey} | out=${msg.out} | chatId=${msg.chatId} | senderId=${msg.senderId} | text=${(msg.text || '').substring(0, 50)}`);
        
        if (!msg.out) {
          this.handleNewMessage(connection.tenantId, connection.channelId, event);
        }
      },
      new NewMessage({})
    );

    connection.handlersAttached = true;
    console.log(`[TelegramClientManager] Handlers attached for ${connectionKey}`);
  }

  private async handleNewMessage(tenantId: string, channelId: string, event: NewMessageEvent): Promise<void> {
    try {
      const isEnabled = await featureFlagService.isEnabled("TELEGRAM_PERSONAL_CHANNEL_ENABLED");
      if (!isEnabled) {
        return;
      }

      const channel = await storage.getChannel(channelId);
      if (!channel?.isActive) {
        console.log(`[TelegramClientManager] Channel ${channelId} is inactive, skipping message`);
        return;
      }

      const message = event.message;

      if (message.out) {
        return;
      }

      const senderId = message.senderId?.toString() || "";
      const chatId = message.chatId?.toString() || "";
      const text = message.text || "";

      if (!text.trim()) {
        console.log("[TelegramClientManager] Skipping empty message");
        return;
      }

      console.log(`[TelegramClientManager] New message from ${senderId} in chat ${chatId}: ${text.substring(0, 50)}...`);

      const connectionKey = `${tenantId}:${channelId}`;
      const connection = this.connections.get(connectionKey);
      if (connection) {
        connection.lastActivity = new Date();
      }

      let senderName = "Unknown";
      try {
        const sender = await message.getSender();
        if (sender && "firstName" in sender) {
          senderName = [sender.firstName, sender.lastName].filter(Boolean).join(" ") || "Unknown";
        }
      } catch {
      }

      await processIncomingMessageFull(tenantId, {
        channel: "telegram_personal",
        externalConversationId: chatId,
        externalUserId: senderId,
        externalMessageId: message.id.toString(),
        text,
        timestamp: new Date((message.date || 0) * 1000),
        metadata: {
          channelId,
          senderName,
          isPrivate: message.isPrivate,
          isGroup: message.isGroup,
          isChannel: message.isChannel,
        },
      });
    } catch (error: any) {
      console.error("[TelegramClientManager] Error handling message:", error.message);
    }
  }

  private scheduleReconnect(tenantId: string, channelId: string, sessionString: string): void {
    const connectionKey = `${tenantId}:${channelId}`;

    const existingTimer = this.reconnectTimers.get(connectionKey);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(async () => {
      console.log(`[TelegramClientManager] Attempting reconnect: ${connectionKey}`);
      this.reconnectTimers.delete(connectionKey);
      await this.connect(tenantId, channelId, sessionString);
    }, 30000);

    this.reconnectTimers.set(connectionKey, timer);
  }

  async disconnect(tenantId: string, channelId: string): Promise<void> {
    const connectionKey = `${tenantId}:${channelId}`;
    const connection = this.connections.get(connectionKey);

    if (connection) {
      try {
        await connection.client.disconnect();
      } catch (error: any) {
        console.warn(`[TelegramClientManager] Disconnect error: ${error.message}`);
      }
      this.connections.delete(connectionKey);
      console.log(`[TelegramClientManager] Disconnected: ${connectionKey}`);
    }

    const timer = this.reconnectTimers.get(connectionKey);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(connectionKey);
    }
  }

  async sendMessage(
    tenantId: string,
    channelId: string,
    externalConversationId: string,
    text: string,
    options?: { replyToMessageId?: string }
  ): Promise<{ success: boolean; externalMessageId?: string; error?: string }> {
    const connectionKey = `${tenantId}:${channelId}`;
    const connection = this.connections.get(connectionKey);

    if (!connection?.connected) {
      return { success: false, error: "Not connected" };
    }

    try {
      // Convert string ID to BigInt for gramjs
      const peerId = BigInt(externalConversationId);
      
      // First try to get the entity to ensure it's in cache
      let entity;
      try {
        entity = await connection.client.getEntity(peerId);
        console.log(`[TelegramClientManager] Resolved entity for ${externalConversationId}: ${entity.className}`);
      } catch (entityError: any) {
        console.log(`[TelegramClientManager] Could not resolve entity, trying direct send: ${entityError.message}`);
        // If we can't get entity, try sending directly with the ID
        entity = peerId;
      }
      
      const result = await connection.client.sendMessage(entity, {
        message: text,
        replyTo: options?.replyToMessageId ? parseInt(options.replyToMessageId, 10) : undefined,
      });

      connection.lastActivity = new Date();
      console.log(`[TelegramClientManager] Message sent to ${externalConversationId}`);

      return {
        success: true,
        externalMessageId: result.id.toString(),
      };
    } catch (error: any) {
      console.error(`[TelegramClientManager] Send error: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async sendTypingIndicator(tenantId: string, channelId: string, externalConversationId: string): Promise<void> {
    const connectionKey = `${tenantId}:${channelId}`;
    const connection = this.connections.get(connectionKey);

    if (!connection?.connected) return;

    try {
      await connection.client.invoke(
        new Api.messages.SetTyping({
          peer: externalConversationId,
          action: new Api.SendMessageTypingAction(),
        })
      );
    } catch {
    }
  }

  getClient(tenantId: string, channelId: string): TelegramClient | null {
    const connectionKey = `${tenantId}:${channelId}`;
    const connection = this.connections.get(connectionKey);
    return connection?.connected ? connection.client : null;
  }

  isConnected(tenantId: string, channelId: string): boolean {
    const connectionKey = `${tenantId}:${channelId}`;
    const connection = this.connections.get(connectionKey);
    return connection?.connected || false;
  }

  async syncDialogs(tenantId: string, channelId: string, options?: { limit?: number; messageLimit?: number }): Promise<{ 
    success: boolean; 
    dialogsImported: number; 
    messagesImported: number; 
    error?: string 
  }> {
    const connectionKey = `${tenantId}:${channelId}`;
    const connection = this.connections.get(connectionKey);
    
    if (!connection?.connected) {
      return { success: false, dialogsImported: 0, messagesImported: 0, error: "Not connected" };
    }

    const dialogLimit = options?.limit ?? 50;
    const messageLimit = options?.messageLimit ?? 20;
    
    console.log(`[TelegramClientManager] Starting dialog sync for ${connectionKey}, limit=${dialogLimit}, msgLimit=${messageLimit}`);

    try {
      const dialogs = await connection.client.getDialogs({ limit: dialogLimit });
      console.log(`[TelegramClientManager] Fetched ${dialogs.length} dialogs`);

      let dialogsImported = 0;
      let messagesImported = 0;

      for (const dialog of dialogs) {
        try {
          if (!dialog.entity || !dialog.id) continue;
          
          const isUser = dialog.isUser;
          
          // Skip channels/groups for now - only sync private chats
          if (!isUser) {
            console.log(`[TelegramClientManager] Skipping non-user dialog: ${dialog.title}`);
            continue;
          }

          const chatId = dialog.id.toString();
          const entity = dialog.entity as any;
          
          const customerName = [entity.firstName, entity.lastName].filter(Boolean).join(" ") || dialog.title || "Unknown";
          const username = entity.username;

          // Get or create customer by externalId (chatId is the telegram user ID)
          let customer = await storage.getCustomerByExternalId(tenantId, "telegram_personal", chatId);
          
          if (!customer) {
            customer = await storage.createCustomer({
              tenantId,
              externalId: chatId,
              channel: "telegram_personal",
              name: customerName,
              metadata: { username, telegramId: chatId },
            });
            console.log(`[TelegramClientManager] Created customer: ${customer.id} - ${customerName}`);
          }

          // Check if conversation already exists for this customer on this channel
          const existingConversations = await storage.getConversationsByTenant(tenantId);
          let existingConv = existingConversations.find(c => 
            c.customerId === customer!.id && c.channelId === channelId
          );
          
          let conversationId: string;
          
          if (existingConv) {
            conversationId = existingConv.id;
            console.log(`[TelegramClientManager] Conversation exists: ${conversationId} for chat ${chatId}`);
          } else {
            // Create conversation
            const newConv = await storage.createConversation({
              tenantId,
              customerId: customer.id,
              channelId: channelId,
              status: "active",
              lastMessageAt: new Date(),
            });
            conversationId = newConv.id;
            dialogsImported++;
            console.log(`[TelegramClientManager] Created conversation: ${conversationId} for chat ${chatId}`);
          }

          // Fetch message history
          const tgMessages = await connection.client.getMessages(dialog.id, { limit: messageLimit });
          console.log(`[TelegramClientManager] Fetched ${tgMessages.length} messages for dialog ${dialog.title}`);

          // Get existing messages to avoid duplicates
          const existingMessages = await storage.getMessagesByConversation(conversationId);
          const existingMsgIds = new Set(
            existingMessages
              .filter(m => m.metadata && typeof m.metadata === 'object' && 'telegramMsgId' in (m.metadata as object))
              .map(m => (m.metadata as { telegramMsgId: string }).telegramMsgId)
          );

          for (const msg of tgMessages.reverse()) {
            if (!msg.text?.trim()) continue;

            const telegramMsgId = msg.id.toString();
            
            // Skip if message already exists
            if (existingMsgIds.has(telegramMsgId)) continue;

            const isOutgoing = msg.out || false;
            const senderId = msg.senderId?.toString() || "";

            await storage.createMessage({
              conversationId,
              role: isOutgoing ? "owner" : "customer",
              content: msg.text,
              metadata: {
                channel: "telegram_personal",
                synced: true,
                syncedAt: new Date().toISOString(),
                telegramMsgId,
                senderId,
                senderName: isOutgoing ? "Operator" : customerName,
              },
              createdAt: new Date((msg.date || 0) * 1000),
            });
            messagesImported++;
          }

          // Update conversation lastMessageAt
          if (tgMessages.length > 0) {
            const lastMsg = tgMessages[0];
            await storage.updateConversation(conversationId, {
              lastMessageAt: new Date((lastMsg.date || 0) * 1000),
            });
          }

        } catch (dialogError: any) {
          console.error(`[TelegramClientManager] Error processing dialog ${dialog.title}:`, dialogError.message);
        }
      }

      console.log(`[TelegramClientManager] Sync complete: ${dialogsImported} dialogs, ${messagesImported} messages imported`);
      return { success: true, dialogsImported, messagesImported };

    } catch (error: any) {
      console.error(`[TelegramClientManager] Sync error:`, error.message);
      return { success: false, dialogsImported: 0, messagesImported: 0, error: error.message };
    }
  }

  async verifyConnection(tenantId: string, channelId: string): Promise<{ connected: boolean; user?: { id: number; firstName: string; username?: string } }> {
    const connectionKey = `${tenantId}:${channelId}`;
    const connection = this.connections.get(connectionKey);
    
    if (!connection) {
      return { connected: false };
    }

    try {
      const me = await connection.client.getMe() as Api.User;
      connection.connected = true;
      connection.lastActivity = new Date();
      
      return {
        connected: true,
        user: {
          id: Number(me.id),
          firstName: me.firstName || "",
          username: me.username,
        },
      };
    } catch (error: any) {
      console.log(`[TelegramClientManager] Verify failed for ${connectionKey}: ${error.message}`);
      connection.connected = false;
      
      // Clean up invalid session
      await this.disconnect(tenantId, channelId);
      
      // Mark channel as inactive in database
      try {
        await storage.updateChannel(channelId, { isActive: false });
        console.log(`[TelegramClientManager] Marked channel ${channelId} as inactive`);
      } catch {}
      
      return { connected: false };
    }
  }

  getActiveConnections(): { tenantId: string; channelId: string; lastActivity: Date }[] {
    return Array.from(this.connections.values()).map((c) => ({
      tenantId: c.tenantId,
      channelId: c.channelId,
      lastActivity: c.lastActivity,
    }));
  }

  async resolvePhoneNumber(
    tenantId: string,
    channelId: string,
    phoneNumber: string
  ): Promise<{ success: boolean; userId?: string; firstName?: string; lastName?: string; error?: string }> {
    const connectionKey = `${tenantId}:${channelId}`;
    const connection = this.connections.get(connectionKey);

    if (!connection?.connected) {
      return { success: false, error: "Not connected to Telegram" };
    }

    try {
      const cleanPhone = phoneNumber.replace(/[^\d+]/g, "");
      console.log(`[TelegramClientManager] Resolving phone: ${cleanPhone}`);

      const contact = new Api.InputPhoneContact({
        clientId: BigInt(Date.now()),
        phone: cleanPhone,
        firstName: "Lead",
        lastName: cleanPhone.slice(-4),
      });

      const result = await connection.client.invoke(
        new Api.contacts.ImportContacts({
          contacts: [contact],
        })
      );

      if (result.users && result.users.length > 0) {
        const user = result.users[0] as Api.User;
        const userId = user.id.toString();
        console.log(`[TelegramClientManager] Resolved ${cleanPhone} to user ${userId}: ${user.firstName} ${user.lastName || ""}`);
        
        return {
          success: true,
          userId,
          firstName: user.firstName || "User",
          lastName: user.lastName || "",
        };
      }

      return { success: false, error: "Phone number not registered in Telegram" };
    } catch (error: any) {
      console.error(`[TelegramClientManager] Phone resolve error: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async startConversationByPhone(
    tenantId: string,
    channelId: string,
    phoneNumber: string,
    initialMessage?: string
  ): Promise<{ success: boolean; conversationId?: string; userId?: string; error?: string }> {
    const resolveResult = await this.resolvePhoneNumber(tenantId, channelId, phoneNumber);
    
    if (!resolveResult.success || !resolveResult.userId) {
      return { success: false, error: resolveResult.error || "Could not resolve phone number" };
    }

    if (initialMessage) {
      const sendResult = await this.sendMessage(tenantId, channelId, resolveResult.userId, initialMessage);
      if (!sendResult.success) {
        return { success: false, error: sendResult.error };
      }
    }

    return {
      success: true,
      conversationId: resolveResult.userId,
      userId: resolveResult.userId,
    };
  }

  async shutdown(): Promise<void> {
    console.log("[TelegramClientManager] Shutting down...");

    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    Array.from(this.reconnectTimers.values()).forEach((timer) => {
      clearTimeout(timer);
    });
    this.reconnectTimers.clear();

    for (const [key, connection] of Array.from(this.connections.entries())) {
      try {
        await connection.client.disconnect();
        console.log(`[TelegramClientManager] Disconnected: ${key}`);
      } catch {
      }
    }
    this.connections.clear();
    this.isInitialized = false;

    console.log("[TelegramClientManager] Shutdown complete");
  }
}

export const telegramClientManager = new TelegramClientManager();

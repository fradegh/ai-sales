import type { ChannelType, FeatureFlagName } from "@shared/schema";
import type {
  ChannelAdapter,
  ChannelSendResult,
  ParsedIncomingMessage,
  WebhookVerifyResult,
} from "./channel-adapter";
import { featureFlagService } from "./feature-flags";
import { auditLog } from "./audit-log";

const TELEGRAM_API_BASE_URL = "https://api.telegram.org";
const TELEGRAM_RATE_LIMIT_RPS = 30;

export interface TelegramBotInfo {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  can_join_groups?: boolean;
  can_read_all_group_messages?: boolean;
  supports_inline_queries?: boolean;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  reply_to_message?: TelegramMessage;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
}

export interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: {
    retry_after?: number;
    migrate_to_chat_id?: number;
  };
}

export type TelegramApiError = {
  code: string;
  message: string;
  status: number;
  retryAfter?: number;
};

function isRetryableError(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TelegramAdapter implements ChannelAdapter {
  readonly name: ChannelType = "telegram";
  private token: string;
  private baseUrl: string;
  private processedMessageIds: Set<string> = new Set();
  private maxProcessedIds = 10000;

  constructor(token?: string) {
    this.token = token || process.env.TELEGRAM_BOT_TOKEN || "";
    this.baseUrl = TELEGRAM_API_BASE_URL;

    if (!this.token) {
      console.warn("[TelegramAdapter] TELEGRAM_BOT_TOKEN not configured");
    }
  }

  private getApiUrl(method: string): string {
    return `${this.baseUrl}/bot${this.token}/${method}`;
  }

  private async makeRequest<T>(
    method: string,
    body?: Record<string, unknown>,
    retries = 3
  ): Promise<{ data?: T; error?: TelegramApiError }> {
    const url = this.getApiUrl(method);

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: body ? JSON.stringify(body) : undefined,
        });

        const json = (await response.json()) as TelegramApiResponse<T>;

        if (json.ok && json.result !== undefined) {
          return { data: json.result };
        }

        if (response.status === 401 || response.status === 403 || json.error_code === 401) {
          console.error(`[TelegramAdapter] Auth error: ${json.description}`);
          return {
            error: {
              code: "AUTH_ERROR",
              message: json.description || `Authentication failed: ${response.status}`,
              status: response.status,
            },
          };
        }

        if (json.error_code === 429 || response.status === 429) {
          const retryAfter = json.parameters?.retry_after || Math.pow(2, attempt);
          const delay = retryAfter * 1000;

          console.warn(
            `[TelegramAdapter] Rate limited, attempt ${attempt}/${retries}, waiting ${delay}ms`
          );

          if (attempt < retries) {
            await sleep(delay);
            continue;
          }

          return {
            error: {
              code: "RATE_LIMIT",
              message: json.description || "Rate limit exceeded",
              status: 429,
              retryAfter,
            },
          };
        }

        if (isRetryableError(response.status)) {
          const delay = Math.pow(2, attempt) * 1000;

          console.warn(
            `[TelegramAdapter] Retryable error ${response.status}, attempt ${attempt}/${retries}, waiting ${delay}ms`
          );

          if (attempt < retries) {
            await sleep(delay);
            continue;
          }

          return {
            error: {
              code: "SERVER_ERROR",
              message: json.description || `Server error: ${response.status}`,
              status: response.status,
            },
          };
        }

        console.error(`[TelegramAdapter] Request failed: ${json.description}`);
        return {
          error: {
            code: "REQUEST_FAILED",
            message: json.description || `HTTP ${response.status}`,
            status: response.status,
          },
        };
      } catch (error) {
        console.error(`[TelegramAdapter] Network error attempt ${attempt}/${retries}:`, error);

        if (attempt < retries) {
          await sleep(Math.pow(2, attempt) * 1000);
          continue;
        }

        return {
          error: {
            code: "NETWORK_ERROR",
            message: error instanceof Error ? error.message : "Network error",
            status: 0,
          },
        };
      }
    }

    return {
      error: {
        code: "MAX_RETRIES",
        message: "Max retries exceeded",
        status: 0,
      },
    };
  }

  async verifyAuth(): Promise<{ success: boolean; botInfo?: TelegramBotInfo; error?: string }> {
    if (!this.token) {
      return { success: false, error: "TELEGRAM_BOT_TOKEN not configured" };
    }

    const result = await this.makeRequest<TelegramBotInfo>("getMe");

    if (result.error) {
      return { success: false, error: result.error.message };
    }

    if (result.data && result.data.is_bot) {
      console.log(
        `[TelegramAdapter] Authenticated as bot: ${result.data.first_name} (@${result.data.username})`
      );
      return { success: true, botInfo: result.data };
    }

    return { success: false, error: "Invalid bot info received" };
  }

  async sendMessage(
    externalConversationId: string,
    text: string,
    options?: { replyToMessageId?: string }
  ): Promise<ChannelSendResult> {
    const isEnabled = await featureFlagService.isEnabled("TELEGRAM_CHANNEL_ENABLED");
    if (!isEnabled) {
      console.log("[TelegramAdapter] Channel disabled, message not sent");
      await auditLog.log(
        "message_sent" as any,
        "message",
        "blocked",
        "system",
        "system",
        {
          channel: "telegram",
          blocked: true,
          reason: "TELEGRAM_CHANNEL_ENABLED is false",
          targetId: externalConversationId,
        }
      );
      return {
        success: false,
        error: "Telegram channel is disabled",
      };
    }

    if (!this.token) {
      return {
        success: false,
        error: "TELEGRAM_BOT_TOKEN not configured",
      };
    }

    const chatId = parseInt(externalConversationId, 10);
    if (isNaN(chatId)) {
      return {
        success: false,
        error: "Invalid chat ID",
      };
    }

    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: text.substring(0, 4096),
      parse_mode: "HTML",
    };

    if (options?.replyToMessageId) {
      const replyToId = parseInt(options.replyToMessageId, 10);
      if (!isNaN(replyToId)) {
        body.reply_to_message_id = replyToId;
      }
    }

    const result = await this.makeRequest<TelegramMessage>("sendMessage", body);

    if (result.error) {
      console.error(`[TelegramAdapter] Send failed: ${result.error.message}`);
      return {
        success: false,
        error: result.error.message,
      };
    }

    const messageId = result.data?.message_id
      ? String(result.data.message_id)
      : `tg_${Date.now()}`;
    console.log(`[TelegramAdapter] Message sent: ${messageId}`);

    return {
      success: true,
      externalMessageId: messageId,
      timestamp: result.data?.date ? new Date(result.data.date * 1000) : new Date(),
    };
  }

  async sendTypingStart(externalConversationId: string): Promise<void> {
    if (!this.token) {
      return;
    }

    const chatId = parseInt(externalConversationId, 10);
    if (isNaN(chatId)) {
      return;
    }

    try {
      await this.makeRequest("sendChatAction", {
        chat_id: chatId,
        action: "typing",
      });
      console.log(`[TelegramAdapter] Sent typing action to ${externalConversationId}`);
    } catch (error) {
      console.warn(`[TelegramAdapter] Failed to send typing action:`, error);
    }
  }

  parseIncomingMessage(rawPayload: unknown): ParsedIncomingMessage | null {
    if (!rawPayload || typeof rawPayload !== "object") {
      return null;
    }

    const update = rawPayload as TelegramUpdate;

    const message = update.message || update.edited_message;

    if (!message) {
      console.log("[TelegramAdapter] No message in update, ignoring");
      return null;
    }

    if (!message.text) {
      console.log("[TelegramAdapter] No text in message, ignoring");
      return null;
    }

    const messageId = String(message.message_id);
    const idempotencyKey = `${message.chat.id}_${messageId}`;

    if (this.processedMessageIds.has(idempotencyKey)) {
      console.log(`[TelegramAdapter] Duplicate message ignored: ${idempotencyKey}`);
      return null;
    }

    this.processedMessageIds.add(idempotencyKey);
    if (this.processedMessageIds.size > this.maxProcessedIds) {
      const iterator = this.processedMessageIds.values();
      const firstValue = iterator.next().value;
      if (firstValue) {
        this.processedMessageIds.delete(firstValue);
      }
    }

    return {
      externalMessageId: messageId,
      externalConversationId: String(message.chat.id),
      externalUserId: message.from ? String(message.from.id) : "unknown",
      text: message.text,
      timestamp: new Date(message.date * 1000),
      channel: "telegram",
      metadata: {
        updateId: update.update_id,
        chatType: message.chat.type,
        firstName: message.from?.first_name,
        lastName: message.from?.last_name,
        username: message.from?.username,
        languageCode: message.from?.language_code,
        chatTitle: message.chat.title,
        chatUsername: message.chat.username,
      },
    };
  }

  verifyWebhook(
    headers: Record<string, string>,
    body: unknown,
    secret?: string
  ): WebhookVerifyResult {
    if (!secret) {
      return { valid: true };
    }

    const receivedToken =
      headers["x-telegram-bot-api-secret-token"] ||
      headers["X-Telegram-Bot-Api-Secret-Token"];

    if (!receivedToken) {
      console.warn("[TelegramAdapter] Missing X-Telegram-Bot-Api-Secret-Token header");
      return { valid: false, error: "Missing secret header" };
    }

    if (receivedToken !== secret) {
      console.warn("[TelegramAdapter] Invalid webhook secret");
      return { valid: false, error: "Invalid secret" };
    }

    return { valid: true };
  }

  async setWebhook(
    webhookUrl: string,
    secret?: string
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.token) {
      return { success: false, error: "TELEGRAM_BOT_TOKEN not configured" };
    }

    const body: Record<string, unknown> = {
      url: webhookUrl,
      allowed_updates: ["message", "edited_message"],
      drop_pending_updates: false,
    };

    if (secret) {
      body.secret_token = secret;
    }

    const result = await this.makeRequest<boolean>("setWebhook", body);

    if (result.error) {
      return { success: false, error: result.error.message };
    }

    console.log(`[TelegramAdapter] Webhook set: ${webhookUrl}`);
    return { success: true };
  }

  async deleteWebhook(): Promise<{ success: boolean; error?: string }> {
    if (!this.token) {
      return { success: false, error: "TELEGRAM_BOT_TOKEN not configured" };
    }

    const result = await this.makeRequest<boolean>("deleteWebhook");

    if (result.error) {
      return { success: false, error: result.error.message };
    }

    console.log("[TelegramAdapter] Webhook deleted");
    return { success: true };
  }

  async getWebhookInfo(): Promise<{
    success: boolean;
    info?: {
      url: string;
      has_custom_certificate: boolean;
      pending_update_count: number;
      last_error_date?: number;
      last_error_message?: string;
    };
    error?: string;
  }> {
    if (!this.token) {
      return { success: false, error: "TELEGRAM_BOT_TOKEN not configured" };
    }

    const result = await this.makeRequest<{
      url: string;
      has_custom_certificate: boolean;
      pending_update_count: number;
      last_error_date?: number;
      last_error_message?: string;
    }>("getWebhookInfo");

    if (result.error) {
      return { success: false, error: result.error.message };
    }

    return { success: true, info: result.data };
  }

  async checkChannelEnabled(tenantId?: string): Promise<boolean> {
    return featureFlagService.isEnabled("TELEGRAM_CHANNEL_ENABLED", tenantId);
  }

  clearProcessedMessages(): void {
    this.processedMessageIds.clear();
  }
}

export function createTelegramAdapter(token?: string): TelegramAdapter {
  return new TelegramAdapter(token);
}

export const telegramAdapter = new TelegramAdapter();

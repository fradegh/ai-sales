import { Router } from "express";
import { db } from "../db";
import { maxPersonalAccounts } from "@shared/schema";
import { eq } from "drizzle-orm";
import type { ParsedIncomingMessage, ParsedAttachment } from "../services/channel-adapter";
import { processIncomingMessageFull } from "../services/inbound-message-handler";

const router = Router();

interface GreenApiSenderData {
  chatId: string;
  chatName?: string;
  senderName?: string;
  sender?: string;
}

interface GreenApiFileData {
  downloadUrl: string;
  fileName?: string;
  mimeType?: string;
  caption?: string;
}

interface GreenApiMessageData {
  typeMessage:
    | "textMessage"
    | "imageMessage"
    | "videoMessage"
    | "audioMessage"
    | "voiceMessage"
    | "documentMessage"
    | "stickerMessage"
    | string;
  textMessageData?: { textMessage: string };
  fileMessageData?: GreenApiFileData;
}

interface GreenApiWebhook {
  typeWebhook: string;
  idMessage?: string;
  timestamp?: number;
  senderData?: GreenApiSenderData;
  messageData?: GreenApiMessageData;
}

function buildAttachment(msgData: GreenApiMessageData): ParsedAttachment | null {
  const fileData = msgData.fileMessageData;
  if (!fileData) return null;

  const typeMap: Record<string, ParsedAttachment["type"]> = {
    imageMessage: "image",
    videoMessage: "video",
    audioMessage: "audio",
    voiceMessage: "voice",
    documentMessage: "document",
    stickerMessage: "sticker",
  };

  const type: ParsedAttachment["type"] = typeMap[msgData.typeMessage] ?? "document";

  return {
    type,
    url: fileData.downloadUrl,
    mimeType: fileData.mimeType,
    fileName: fileData.fileName,
  };
}

// Public endpoint — no auth, GREEN-API posts here
router.post("/:tenantId", async (req, res) => {
  const { tenantId } = req.params;

  try {
    // Verify the tenant has a configured MAX Personal account
    const account = await db.query.maxPersonalAccounts.findFirst({
      where: eq(maxPersonalAccounts.tenantId, tenantId),
    });

    if (!account) {
      console.warn(`[MaxPersonalWebhook] Unknown tenant: ${tenantId}`);
      return res.status(404).json({ error: "Tenant not found" });
    }

    const payload = req.body as GreenApiWebhook;

    // Only process incoming messages
    if (payload.typeWebhook !== "incomingMessageReceived") {
      return res.json({ ok: true });
    }

    const sender = payload.senderData;
    const msgData = payload.messageData;

    if (!sender?.chatId || !msgData) {
      return res.json({ ok: true });
    }

    const msgType = msgData.typeMessage;
    let text = "";
    const attachments: ParsedAttachment[] = [];

    if (msgType === "textMessage" && msgData.textMessageData) {
      text = msgData.textMessageData.textMessage || "";
    } else {
      const att = buildAttachment(msgData);
      if (att) {
        attachments.push(att);
        if (msgData.fileMessageData?.caption) {
          text = msgData.fileMessageData.caption;
        }
      }
    }

    const parsed: ParsedIncomingMessage = {
      externalMessageId: payload.idMessage || `mp_${Date.now()}`,
      externalConversationId: sender.chatId,
      externalUserId: sender.sender || sender.chatId,
      text,
      timestamp: payload.timestamp ? new Date(payload.timestamp * 1000) : new Date(),
      channel: "max_personal",
      metadata: {
        senderName: sender.senderName || sender.chatName,
        chatId: sender.chatId,
      },
      attachments: attachments.length > 0 ? attachments : undefined,
    };

    await processIncomingMessageFull(tenantId, parsed);

    console.log(`[MaxPersonalWebhook] Processed ${msgType} from ${sender.chatId} for tenant ${tenantId}`);
    return res.json({ ok: true });
  } catch (error: any) {
    console.error("[MaxPersonalWebhook] Error:", error.message);
    return res.status(500).json({ error: "Internal error" });
  }
});

export default router;

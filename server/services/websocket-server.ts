import { WebSocketServer, WebSocket } from "ws";
import type { Server, IncomingMessage } from "http";
import type { Message, Conversation } from "@shared/schema";
import { parse as parseUrl } from "url";

interface ConnectedClient {
  ws: WebSocket;
  tenantId: string;
  conversationId?: string;
}

class RealtimeService {
  private wss: WebSocketServer | null = null;
  private clients: Set<ConnectedClient> = new Set();

  initialize(server: Server) {
    this.wss = new WebSocketServer({ noServer: true });

    this.wss.on("connection", (ws: WebSocket) => {
      const client: ConnectedClient = {
        ws,
        tenantId: "default",
      };
      this.clients.add(client);
      console.log("[WebSocket] Client connected");

      ws.on("message", (data) => {
        try {
          const message = JSON.parse(data.toString());
          if (message.type === "subscribe" && message.conversationId) {
            client.conversationId = message.conversationId;
            console.log(`[WebSocket] Client subscribed to conversation: ${message.conversationId}`);
          }
          if (message.type === "set_tenant" && message.tenantId) {
            client.tenantId = message.tenantId;
            console.log(`[WebSocket] Client set tenant: ${message.tenantId}`);
          }
          if (message.type === "ping") {
            ws.send(JSON.stringify({ type: "pong" }));
          }
        } catch {
        }
      });

      ws.on("close", () => {
        this.clients.delete(client);
        console.log("[WebSocket] Client disconnected");
      });

      ws.on("error", (error) => {
        console.error("[WebSocket] Error:", error.message);
        this.clients.delete(client);
      });

      ws.send(JSON.stringify({ type: "connected" }));
    });

    server.on("upgrade", (request: IncomingMessage, socket, head) => {
      const { pathname } = parseUrl(request.url || "");
      
      if (pathname === "/ws") {
        this.wss!.handleUpgrade(request, socket as any, head, (ws) => {
          this.wss!.emit("connection", ws, request);
        });
      }
    });

    console.log("[WebSocket] Server initialized on /ws");
  }

  broadcastNewMessage(tenantId: string, message: Message, conversationId: string) {
    const payload = JSON.stringify({
      type: "new_message",
      conversationId,
      message,
    });

    Array.from(this.clients).forEach(client => {
      if (client.ws.readyState === WebSocket.OPEN && client.tenantId === tenantId) {
        if (!client.conversationId || client.conversationId === conversationId) {
          client.ws.send(payload);
        }
      }
    });
  }

  broadcastConversationUpdate(tenantId: string, conversation: Partial<Conversation> & { id: string }) {
    const payload = JSON.stringify({
      type: "conversation_update",
      conversation,
    });

    Array.from(this.clients).forEach(client => {
      if (client.ws.readyState === WebSocket.OPEN && client.tenantId === tenantId) {
        client.ws.send(payload);
      }
    });
  }

  broadcastNewConversation(tenantId: string, conversation: any) {
    const payload = JSON.stringify({
      type: "new_conversation",
      conversation,
    });

    Array.from(this.clients).forEach(client => {
      if (client.ws.readyState === WebSocket.OPEN && client.tenantId === tenantId) {
        client.ws.send(payload);
      }
    });
  }

  broadcastNewSuggestion(tenantId: string, conversationId: string, suggestionId: string) {
    const payload = JSON.stringify({
      type: "new_suggestion",
      conversationId,
      suggestionId,
    });

    Array.from(this.clients).forEach(client => {
      if (client.ws.readyState === WebSocket.OPEN && client.tenantId === tenantId) {
        client.ws.send(payload);
      }
    });
  }
}

export const realtimeService = new RealtimeService();

import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { ConversationList } from "@/components/conversation-list";
import { ChatInterface } from "@/components/chat-interface";
import { CustomerCard } from "@/components/customer-card";
import { ChannelTabs } from "@/components/channel-tabs";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { User, ArrowLeft } from "lucide-react";
import type { ConversationWithCustomer, ConversationDetail } from "@shared/schema";
import type { ChannelFilter } from "@/components/channel-tabs";

const CHANNEL_FAMILY_TYPES: Record<Exclude<ChannelFilter, "all">, string[]> = {
  telegram: ["telegram", "telegram_personal"],
  max: ["max", "max_personal"],
  whatsapp: ["whatsapp", "whatsapp_personal"],
};

export default function Conversations() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileShowChat, setMobileShowChat] = useState(false);
  const [testDialogOpen, setTestDialogOpen] = useState(false);
  const [testName, setTestName] = useState("");
  const [testPhone, setTestPhone] = useState("");
  const [testMessage, setTestMessage] = useState("");
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>("all");

  // "Новый диалог" modal state
  const [newDialogOpen, setNewDialogOpen] = useState(false);
  const [newDialogChannel, setNewDialogChannel] = useState<"telegram_personal" | "max_personal" | "">("");
  const [newDialogPhone, setNewDialogPhone] = useState("");
  const [newDialogMessage, setNewDialogMessage] = useState("");
  const [newDialogPhoneError, setNewDialogPhoneError] = useState("");

  const { toast } = useToast();

  const handleSelectConversation = async (id: string) => {
    setSelectedId(id);
    setMobileShowChat(true);
    
    // Mark conversation as read to reset unread counter
    try {
      await apiRequest("POST", `/api/conversations/${id}/read`);
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/conversations/channel-counts"] });
    } catch (error) {
      console.error("Failed to mark conversation as read:", error);
    }
  };

  const handleBackToList = () => {
    setMobileShowChat(false);
  };

  const { data: conversations, isLoading: conversationsLoading } = useQuery<ConversationWithCustomer[]>({
    queryKey: ["/api/conversations"],
  });

  const { data: channelCounts } = useQuery<{ all: number; telegram?: number; max?: number; whatsapp?: number }>({
    queryKey: ["/api/conversations/channel-counts"],
  });

  const { data: personalChannelStatus } = useQuery<{ telegram_personal: boolean; max_personal: boolean }>({
    queryKey: ["/api/channels/personal-status"],
    staleTime: 60_000,
  });

  const filteredConversations = useMemo(() => {
    if (!conversations) return [];
    if (channelFilter === "all") return conversations;
    const types = CHANNEL_FAMILY_TYPES[channelFilter];
    return conversations.filter((c) => {
      const channelType = c.channel?.type ?? "";
      return types.includes(channelType);
    });
  }, [conversations, channelFilter]);

  const { data: conversationDetail, isLoading: detailLoading } = useQuery<ConversationDetail>({
    queryKey: ["/api/conversations", selectedId],
    enabled: !!selectedId,
  });

  const approveMutation = useMutation({
    mutationFn: async (suggestionId: string) => {
      return apiRequest("POST", `/api/suggestions/${suggestionId}/approve`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/conversations", selectedId] });
      toast({ title: "Response approved and sent" });
    },
    onError: () => {
      toast({ title: "Failed to approve", variant: "destructive" });
    },
  });

  const editMutation = useMutation({
    mutationFn: async ({ suggestionId, editedText }: { suggestionId: string; editedText: string }) => {
      return apiRequest("POST", `/api/suggestions/${suggestionId}/edit`, { editedText });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/conversations", selectedId] });
      toast({ title: "Edited response sent" });
    },
    onError: () => {
      toast({ title: "Failed to send edited response", variant: "destructive" });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: async (suggestionId: string) => {
      return apiRequest("POST", `/api/suggestions/${suggestionId}/reject`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/conversations", selectedId] });
      toast({ title: "Suggestion rejected" });
    },
    onError: () => {
      toast({ title: "Failed to reject", variant: "destructive" });
    },
  });

  const escalateMutation = useMutation({
    mutationFn: async (suggestionId: string) => {
      return apiRequest("POST", `/api/suggestions/${suggestionId}/escalate`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/conversations", selectedId] });
      queryClient.invalidateQueries({ queryKey: ["/api/escalations"] });
      toast({ title: "Conversation escalated" });
    },
    onError: () => {
      toast({ title: "Failed to escalate", variant: "destructive" });
    },
  });

  const sendManualMutation = useMutation({
    mutationFn: async ({ content, file }: { content: string; file?: File }) => {
      if (file) {
        const formData = new FormData();
        formData.append("content", content);
        formData.append("file", file);
        return apiRequest("POST", `/api/conversations/${selectedId}/messages`, formData);
      }
      return apiRequest("POST", `/api/conversations/${selectedId}/messages`, { content });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/conversations", selectedId] });
    },
    onError: () => {
      toast({ title: "Failed to send message", variant: "destructive" });
    },
  });

  const startPhoneConversationMutation = useMutation({
    mutationFn: async (phoneNumber: string) => {
      const response = await apiRequest("POST", `/api/telegram-personal/start-conversation`, { phoneNumber });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to start conversation");
      }
      return data;
    },
    onSuccess: (data: { conversationId: string }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      if (data.conversationId) {
        setSelectedId(data.conversationId);
        setMobileShowChat(true);
        toast({ title: "Открыт чат с номером телефона" });
      }
    },
    onError: (error: Error) => {
      toast({ 
        title: "Не удалось начать чат", 
        description: error.message || "Номер не зарегистрирован в Telegram",
        variant: "destructive" 
      });
    },
  });

  const handlePhoneClick = (phoneNumber: string) => {
    startPhoneConversationMutation.mutate(phoneNumber);
  };

  const startMaxPersonalConversationMutation = useMutation({
    mutationFn: async (data: { phoneNumber: string; initialMessage?: string }) => {
      const response = await apiRequest("POST", "/api/max-personal/start-conversation", data);
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "Не удалось начать диалог");
      return json as { conversationId: string };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      setNewDialogOpen(false);
      setNewDialogPhone("");
      setNewDialogMessage("");
      setNewDialogChannel("");
      setNewDialogPhoneError("");
      if (data.conversationId) {
        setSelectedId(data.conversationId);
        setMobileShowChat(true);
        toast({ title: "Диалог открыт" });
      }
    },
    onError: (error: Error) => {
      toast({ title: "Не удалось начать диалог", description: error.message, variant: "destructive" });
    },
  });

  const startTelegramPersonalConversationMutation = useMutation({
    mutationFn: async (data: { phoneNumber: string; initialMessage?: string }) => {
      const response = await apiRequest("POST", "/api/telegram-personal/start-conversation", data);
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "Не удалось начать диалог");
      return json as { conversationId: string };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      setNewDialogOpen(false);
      setNewDialogPhone("");
      setNewDialogMessage("");
      setNewDialogChannel("");
      setNewDialogPhoneError("");
      if (data.conversationId) {
        setSelectedId(data.conversationId);
        setMobileShowChat(true);
        toast({ title: "Диалог открыт" });
      }
    },
    onError: (error: Error) => {
      toast({ title: "Не удалось начать диалог", description: error.message, variant: "destructive" });
    },
  });

  const validatePhone = (value: string): boolean => {
    const digits = value.replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 15) {
      setNewDialogPhoneError("Введите номер телефона в формате +79991234567");
      return false;
    }
    setNewDialogPhoneError("");
    return true;
  };

  const handleNewDialogSubmit = () => {
    if (!validatePhone(newDialogPhone)) return;
    const payload = {
      phoneNumber: newDialogPhone.trim(),
      initialMessage: newDialogMessage.trim() || undefined,
    };
    if (newDialogChannel === "max_personal") {
      startMaxPersonalConversationMutation.mutate(payload);
    } else if (newDialogChannel === "telegram_personal") {
      startTelegramPersonalConversationMutation.mutate(payload);
    }
  };

  const newDialogPending =
    startMaxPersonalConversationMutation.isPending ||
    startTelegramPersonalConversationMutation.isPending;

  const connectedPersonalChannels = [
    personalChannelStatus?.telegram_personal && "telegram_personal",
    personalChannelStatus?.max_personal && "max_personal",
  ].filter(Boolean) as Array<"telegram_personal" | "max_personal">;

  const handleNewDialogOpen = () => {
    setNewDialogPhone("");
    setNewDialogMessage("");
    setNewDialogPhoneError("");
    // Pre-select channel if only one is connected
    if (connectedPersonalChannels.length === 1) {
      setNewDialogChannel(connectedPersonalChannels[0]);
    } else {
      setNewDialogChannel("");
    }
    setNewDialogOpen(true);
  };

  const deleteConversationMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/conversations/${id}`);
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.error || "Ошибка удаления");
      }
      return id;
    },
    onSuccess: (deletedId) => {
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      if (selectedId === deletedId) {
        setSelectedId(null);
        setMobileShowChat(false);
      }
      toast({ title: "Диалог удалён" });
    },
    onError: (error: Error) => {
      toast({ title: "Не удалось удалить диалог", description: error.message, variant: "destructive" });
    },
  });

  const simulateMessageMutation = useMutation({
    mutationFn: async (data: { customerName: string; customerPhone: string; message: string }) => {
      const res = await apiRequest("POST", "/api/test/simulate-message", data);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Ошибка создания диалога");
      return json;
    },
    onSuccess: (data: { conversation?: { id?: string } }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
      setTestDialogOpen(false);
      setTestName("");
      setTestPhone("");
      setTestMessage("");
      toast({ title: "Тестовый диалог создан" });
      if (data.conversation?.id) {
        setSelectedId(data.conversation.id);
        setMobileShowChat(true);
      }
    },
    onError: (error: Error) => {
      toast({ title: "Не удалось создать диалог", description: error.message, variant: "destructive" });
    },
  });

  const handleSimulateSubmit = () => {
    if (!testName.trim() || !testPhone.trim() || !testMessage.trim()) {
      toast({ title: "Заполните все поля", variant: "destructive" });
      return;
    }
    simulateMessageMutation.mutate({
      customerName: testName.trim(),
      customerPhone: testPhone.trim(),
      message: testMessage.trim(),
    });
  };

  return (
    <div className="flex h-full overflow-hidden">
      {/* Conversation List - hidden on mobile when chat is open */}
      <div className={`w-80 shrink-0 border-r flex flex-col overflow-hidden ${mobileShowChat ? 'hidden md:flex' : 'flex'}`}>
        <ChannelTabs
          activeFilter={channelFilter}
          onFilterChange={setChannelFilter}
          counts={channelCounts ?? { all: 0 }}
        />
        <ConversationList
          conversations={filteredConversations}
          selectedId={selectedId || undefined}
          onSelect={handleSelectConversation}
          onDelete={(id) => deleteConversationMutation.mutate(id)}
          onNewDialog={handleNewDialogOpen}
          onCreateTestDialog={() => setTestDialogOpen(true)}
          isLoading={conversationsLoading}
        />
      </div>

      {/* Test Dialog */}
      <Dialog open={testDialogOpen} onOpenChange={setTestDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Создать тестовый диалог</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="test-name">Имя клиента</Label>
              <Input
                id="test-name"
                placeholder="Тест Иванов"
                value={testName}
                onChange={(e) => setTestName(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="test-phone">Телефон</Label>
              <Input
                id="test-phone"
                placeholder="+79001234567"
                value={testPhone}
                onChange={(e) => setTestPhone(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="test-message">Сообщение</Label>
              <Input
                id="test-message"
                placeholder="WVWZZZ7MZ6V025007"
                value={testMessage}
                onChange={(e) => setTestMessage(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTestDialogOpen(false)}>
              Отмена
            </Button>
            <Button onClick={handleSimulateSubmit} disabled={simulateMessageMutation.isPending}>
              {simulateMessageMutation.isPending ? "Создание..." : "Создать"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      
      {/* Новый диалог */}
      <Dialog open={newDialogOpen} onOpenChange={(open) => {
        if (!newDialogPending) setNewDialogOpen(open);
      }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Новый диалог</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-2">
            {connectedPersonalChannels.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Нет подключённых каналов. Подключите Telegram Personal или MAX Personal в настройках.
              </p>
            ) : (
              <>
                {connectedPersonalChannels.length > 1 && (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="new-dialog-channel">Канал</Label>
                    <Select
                      value={newDialogChannel}
                      onValueChange={(v) => setNewDialogChannel(v as "telegram_personal" | "max_personal")}
                    >
                      <SelectTrigger id="new-dialog-channel">
                        <SelectValue placeholder="Выберите канал" />
                      </SelectTrigger>
                      <SelectContent>
                        {connectedPersonalChannels.includes("telegram_personal") && (
                          <SelectItem value="telegram_personal">Telegram Personal</SelectItem>
                        )}
                        {connectedPersonalChannels.includes("max_personal") && (
                          <SelectItem value="max_personal">MAX Personal</SelectItem>
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="new-dialog-phone">Номер телефона</Label>
                  <Input
                    id="new-dialog-phone"
                    placeholder="+79991234567"
                    value={newDialogPhone}
                    onChange={(e) => {
                      setNewDialogPhone(e.target.value);
                      if (newDialogPhoneError) setNewDialogPhoneError("");
                    }}
                    onBlur={() => {
                      if (newDialogPhone) validatePhone(newDialogPhone);
                    }}
                  />
                  {newDialogPhoneError && (
                    <p className="text-xs text-destructive">{newDialogPhoneError}</p>
                  )}
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="new-dialog-message">Первое сообщение <span className="text-muted-foreground">(необязательно)</span></Label>
                  <Textarea
                    id="new-dialog-message"
                    placeholder="Введите сообщение..."
                    rows={3}
                    value={newDialogMessage}
                    onChange={(e) => setNewDialogMessage(e.target.value)}
                  />
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewDialogOpen(false)} disabled={newDialogPending}>
              Отмена
            </Button>
            <Button
              onClick={handleNewDialogSubmit}
              disabled={newDialogPending || connectedPersonalChannels.length === 0 || !newDialogChannel}
            >
              {newDialogPending ? "Создание..." : "Начать диалог"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Chat Area - hidden on mobile when list is shown */}
      <div className={`flex flex-1 min-w-0 overflow-hidden ${mobileShowChat ? 'flex' : 'hidden md:flex'}`}>
        <div className="flex-1 overflow-hidden relative flex flex-col">
          {/* Mobile back button */}
          <div className="md:hidden flex items-center gap-2 p-2 border-b shrink-0">
            <Button 
              size="icon" 
              variant="ghost" 
              onClick={handleBackToList}
              data-testid="button-back-to-list"
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm font-medium truncate">
              {conversationDetail?.customer?.name || "Чат"}
            </span>
            {conversationDetail?.customerId && (
              <div className="ml-auto">
                <Sheet>
                  <SheetTrigger asChild>
                    <Button size="icon" variant="ghost" data-testid="button-open-customer-panel-mobile">
                      <User className="h-4 w-4" />
                    </Button>
                  </SheetTrigger>
                  <SheetContent side="right" className="w-80 overflow-y-auto">
                    <SheetHeader>
                      <SheetTitle>Карточка клиента</SheetTitle>
                    </SheetHeader>
                    <div className="mt-4">
                      <CustomerCard customerId={conversationDetail.customerId} />
                    </div>
                  </SheetContent>
                </Sheet>
              </div>
            )}
          </div>
          
          <div className="flex-1 overflow-hidden relative">
            <ChatInterface
              conversation={conversationDetail || null}
              onApprove={(id) => approveMutation.mutate(id)}
              onEdit={(id, text) => editMutation.mutate({ suggestionId: id, editedText: text })}
              onReject={(id) => rejectMutation.mutate(id)}
              onEscalate={(id) => escalateMutation.mutate(id)}
              onSendManual={(content, file) => sendManualMutation.mutate({ content, file })}
              onPhoneClick={handlePhoneClick}
              isLoading={detailLoading}
            />
            {/* Desktop customer panel button */}
            {conversationDetail?.customerId && (
              <div className="absolute top-2 right-2 hidden md:block xl:hidden">
                <Sheet>
                  <SheetTrigger asChild>
                    <Button size="icon" variant="outline" data-testid="button-open-customer-panel">
                      <User className="h-4 w-4" />
                    </Button>
                  </SheetTrigger>
                  <SheetContent side="right" className="w-80 overflow-y-auto">
                    <SheetHeader>
                      <SheetTitle>Карточка клиента</SheetTitle>
                    </SheetHeader>
                    <div className="mt-4">
                      <CustomerCard customerId={conversationDetail.customerId} />
                    </div>
                  </SheetContent>
                </Sheet>
              </div>
            )}
          </div>
        </div>
        
        {/* Desktop customer card sidebar */}
        {conversationDetail?.customerId && (
          <div className="hidden shrink-0 border-l p-4 xl:block">
            <CustomerCard customerId={conversationDetail.customerId} />
          </div>
        )}
      </div>
    </div>
  );
}

import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { ConversationList } from "@/components/conversation-list";
import { ChatInterface } from "@/components/chat-interface";
import { CustomerCard } from "@/components/customer-card";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { User, ArrowLeft } from "lucide-react";
import type { ConversationWithCustomer, ConversationDetail } from "@shared/schema";

export default function Conversations() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileShowChat, setMobileShowChat] = useState(false);
  const { toast } = useToast();

  const handleSelectConversation = async (id: string) => {
    setSelectedId(id);
    setMobileShowChat(true);
    
    // Mark conversation as read to reset unread counter
    try {
      await apiRequest("POST", `/api/conversations/${id}/read`);
      queryClient.invalidateQueries({ queryKey: ["/api/conversations"] });
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
    mutationFn: async (content: string) => {
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

  return (
    <div className="flex h-full">
      {/* Conversation List - hidden on mobile when chat is open */}
      <div className={`w-full md:w-80 shrink-0 border-r ${mobileShowChat ? 'hidden md:block' : 'block'}`}>
        <ConversationList
          conversations={conversations || []}
          selectedId={selectedId || undefined}
          onSelect={handleSelectConversation}
          isLoading={conversationsLoading}
        />
      </div>
      
      {/* Chat Area - hidden on mobile when list is shown */}
      <div className={`flex flex-1 overflow-hidden ${mobileShowChat ? 'flex' : 'hidden md:flex'}`}>
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
              onSendManual={(content) => sendManualMutation.mutate(content)}
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

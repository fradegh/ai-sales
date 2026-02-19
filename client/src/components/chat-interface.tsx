import { useState, useRef, useEffect, useCallback } from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Send,
  Check,
  X,
  Edit2,
  AlertTriangle,
  Bot,
  User,
  ChevronDown,
  ChevronUp,
  FileText,
  Package,
  Zap,
  Eye,
  UserCheck,
  Info,
  Star,
  ArrowDown,
} from "lucide-react";
import { CsatDialog } from "@/components/csat-dialog";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ConversationDetail, AiSuggestion, Penalty } from "@shared/schema";
import { formatDistanceToNow } from "date-fns";
import { ru } from "date-fns/locale";

interface ChatInterfaceProps {
  conversation: ConversationDetail | null;
  onApprove: (suggestionId: string) => void;
  onEdit: (suggestionId: string, editedText: string) => void;
  onReject: (suggestionId: string) => void;
  onEscalate: (suggestionId: string) => void;
  onSendManual: (content: string) => void;
  onPhoneClick?: (phoneNumber: string) => void;
  isLoading?: boolean;
}

interface UsedSource {
  type: "product" | "doc";
  id: string;
  title?: string;
  quote: string;
  similarity?: number;
}

const decisionLabels: Record<string, { label: string; icon: typeof Zap; color: string; bgColor: string }> = {
  AUTO_SEND: { 
    label: "Автоотправка", 
    icon: Zap, 
    color: "text-green-600 dark:text-green-400",
    bgColor: "bg-green-500/10"
  },
  NEED_APPROVAL: { 
    label: "Требует проверки", 
    icon: Eye, 
    color: "text-amber-600 dark:text-amber-400",
    bgColor: "bg-amber-500/10"
  },
  ESCALATE: { 
    label: "Эскалация", 
    icon: UserCheck, 
    color: "text-red-600 dark:text-red-400",
    bgColor: "bg-red-500/10"
  },
};

const intentLabels: Record<string, { label: string; color: string }> = {
  price: { label: "Цена", color: "bg-blue-500/10 text-blue-600 dark:text-blue-400" },
  availability: { label: "Наличие", color: "bg-green-500/10 text-green-600 dark:text-green-400" },
  shipping: { label: "Доставка", color: "bg-purple-500/10 text-purple-600 dark:text-purple-400" },
  return: { label: "Возврат", color: "bg-orange-500/10 text-orange-600 dark:text-orange-400" },
  discount: { label: "Скидка", color: "bg-pink-500/10 text-pink-600 dark:text-pink-400" },
  complaint: { label: "Жалоба", color: "bg-red-500/10 text-red-600 dark:text-red-400" },
  other: { label: "Другое", color: "bg-gray-500/10 text-gray-600 dark:text-gray-400" },
};

const statusLabels: Record<string, string> = {
  active: "Активен",
  waiting: "Ожидает",
  escalated: "Эскалирован",
  resolved: "Решен",
};

const phoneRegex = /(\+?[0-9][\s\-()0-9]{8,}[0-9])/g;

function parseMessageWithPhones(
  content: string,
  onPhoneClick?: (phone: string) => void
): React.ReactNode[] {
  if (!onPhoneClick) {
    return [content];
  }

  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match;
  let keyIndex = 0;

  const regex = new RegExp(phoneRegex.source, 'g');
  
  while ((match = regex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push(content.slice(lastIndex, match.index));
    }
    
    const phoneNumber = match[1];
    const cleanPhone = phoneNumber.replace(/[\s\-()]/g, '');
    
    if (cleanPhone.length >= 10) {
      parts.push(
        <span
          key={`phone-${keyIndex++}`}
          onClick={(e) => {
            e.stopPropagation();
            onPhoneClick(cleanPhone);
          }}
          className="text-primary underline font-medium cursor-pointer"
          role="button"
          tabIndex={0}
          data-testid={`link-phone-${cleanPhone}`}
        >
          {phoneNumber}
        </span>
      );
    } else {
      parts.push(phoneNumber);
    }
    
    lastIndex = regex.lastIndex;
  }
  
  if (lastIndex < content.length) {
    parts.push(content.slice(lastIndex));
  }
  
  return parts.length > 0 ? parts : [content];
}

export function ChatInterface({
  conversation,
  onApprove,
  onEdit,
  onReject,
  onEscalate,
  onSendManual,
  onPhoneClick,
  isLoading,
}: ChatInterfaceProps) {
  const [manualMessage, setManualMessage] = useState("");
  const [editedSuggestion, setEditedSuggestion] = useState("");
  const [isEditing, setIsEditing] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [showCsatDialog, setShowCsatDialog] = useState(false);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const prevConversationId = useRef<string | null>(null);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior, block: "end" });
    }
  }, []);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const target = e.target as HTMLDivElement;
    const isNearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 100;
    setShowScrollButton(!isNearBottom);
  }, []);

  useEffect(() => {
    if (conversation?.id !== prevConversationId.current) {
      prevConversationId.current = conversation?.id || null;
      setTimeout(() => scrollToBottom("instant"), 50);
    }
  }, [conversation?.id, scrollToBottom]);

  useEffect(() => {
    if (conversation?.messages?.length) {
      const scrollArea = scrollAreaRef.current;
      if (scrollArea) {
        const viewport = scrollArea.querySelector("[data-radix-scroll-area-viewport]") as HTMLDivElement;
        if (viewport) {
          const isNearBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 150;
          if (isNearBottom) {
            setTimeout(() => scrollToBottom("smooth"), 50);
          }
        }
      }
    }
  }, [conversation?.messages?.length, scrollToBottom]);

  useEffect(() => {
    if (conversation?.currentSuggestion) {
      setEditedSuggestion(conversation.currentSuggestion.suggestedReply);
    }
  }, [conversation?.currentSuggestion]);

  if (!conversation) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-muted-foreground">
        <Bot className="h-16 w-16 opacity-20" />
        <p className="mt-4 text-sm">Выберите разговор для просмотра сообщений</p>
      </div>
    );
  }

  const suggestion = conversation.currentSuggestion;
  const usedSources = (suggestion?.usedSources || []) as UsedSource[];
  const explanations = (Array.isArray(suggestion?.explanations) ? suggestion.explanations : []) as string[];

  const handleSendManual = () => {
    if (manualMessage.trim()) {
      onSendManual(manualMessage);
      setManualMessage("");
    }
  };

  const handleApproveEdit = () => {
    if (suggestion) {
      onEdit(suggestion.id, editedSuggestion);
      setIsEditing(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 border-b p-4">
        <div className="flex items-center gap-3">
          <Avatar>
            <AvatarFallback>
              {conversation.customer?.name?.slice(0, 2).toUpperCase() || "КЛ"}
            </AvatarFallback>
          </Avatar>
          <div>
            <div className="font-medium">
              {conversation.customer?.name || "Неизвестный клиент"}
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{conversation.customer?.phone || "Нет телефона"}</span>
              <Badge variant="outline" className="text-xs">
                {conversation.mode === "learning" ? "Обучение" : conversation.mode === "semi_auto" ? "Полуавто" : "Авто"}
              </Badge>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {conversation.status === "resolved" && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowCsatDialog(true)}
              data-testid="button-csat-open"
            >
              <Star className="mr-1 h-4 w-4" />
              Оценить
            </Button>
          )}
          <Badge
            variant="secondary"
            className={cn(
              conversation.status === "escalated" && "bg-destructive/10 text-destructive"
            )}
          >
            {statusLabels[conversation.status] || conversation.status}
          </Badge>
        </div>
      </div>

      <CsatDialog
        conversationId={conversation.id}
        open={showCsatDialog}
        onOpenChange={setShowCsatDialog}
      />

      {/* Messages */}
      <div className="relative flex-1 min-h-0 overflow-hidden">
        <ScrollArea 
          className="h-full p-4" 
          ref={scrollAreaRef}
          onScrollCapture={handleScroll}
        >
          <div className="space-y-4">
            {conversation.messages.map((message) => (
              <div
                key={message.id}
                className={cn(
                  "flex gap-3",
                  message.role !== "customer" && "flex-row-reverse"
                )}
              >
                <Avatar className="h-8 w-8 shrink-0">
                  <AvatarFallback className="text-xs">
                    {message.role === "customer" ? (
                      <User className="h-4 w-4" />
                    ) : message.role === "assistant" ? (
                      <Bot className="h-4 w-4" />
                    ) : (
                      "ОП"
                    )}
                  </AvatarFallback>
                </Avatar>
                <div
                  className={cn(
                    "max-w-[70%] rounded-2xl px-4 py-2.5",
                    message.role === "customer"
                      ? "bg-muted"
                      : message.role === "assistant"
                      ? "bg-primary text-primary-foreground"
                      : "bg-accent"
                  )}
                >
                  <p className="text-sm whitespace-pre-wrap">
                    {parseMessageWithPhones(message.content, onPhoneClick)}
                  </p>
                  <span
                    className={cn(
                      "mt-1 block text-xs opacity-70",
                      message.role !== "customer" && "text-right"
                    )}
                  >
                    {formatDistanceToNow(new Date(message.createdAt), {
                      addSuffix: true,
                      locale: ru,
                    })}
                  </span>
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        </ScrollArea>
        
        {showScrollButton && (
          <div className="absolute bottom-4 right-6 z-10">
            <Button
              size="icon"
              variant="secondary"
              className="h-10 w-10 rounded-full shadow-md"
              onClick={() => scrollToBottom("smooth")}
              data-testid="button-scroll-to-bottom"
            >
              <ArrowDown className="h-5 w-5" />
            </Button>
          </div>
        )}
      </div>

      {/* AI Suggestion Panel */}
      {suggestion && suggestion.status === "pending" && (
        <Card className="mx-4 mb-4 overflow-hidden border-primary/20">
          <div className="bg-primary/5 px-4 py-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                <Bot className="h-4 w-4 text-primary" />
                <span className="text-sm font-medium">Предложение AI</span>
                {/* Phase 1: Decision Badge */}
                {suggestion.decision && decisionLabels[suggestion.decision] && (
                  <Badge
                    variant="secondary"
                    className={cn(
                      "text-xs",
                      decisionLabels[suggestion.decision].color,
                      decisionLabels[suggestion.decision].bgColor
                    )}
                    data-testid={`badge-decision-${suggestion.decision}`}
                  >
                    {(() => {
                      const DecisionIcon = decisionLabels[suggestion.decision].icon;
                      return <DecisionIcon className="h-3 w-3 mr-1" />;
                    })()}
                    {decisionLabels[suggestion.decision].label}
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {suggestion.intent && intentLabels[suggestion.intent] && (
                  <Badge
                    variant="secondary"
                    className={cn("text-xs", intentLabels[suggestion.intent].color)}
                  >
                    {intentLabels[suggestion.intent].label}
                  </Badge>
                )}
                {/* Phase 1: Confidence with breakdown tooltip */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge variant="outline" className="text-xs font-mono cursor-help" data-testid="badge-confidence">
                      {Math.round((suggestion.confidence || 0) * 100)}% уверенность
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent className="text-xs">
                    <div className="space-y-1">
                      <div className="flex justify-between gap-4">
                        <span>Схожесть:</span>
                        <span className="font-mono">{Math.round((suggestion.similarityScore || 0) * 100)}%</span>
                      </div>
                      <div className="flex justify-between gap-4">
                        <span>Интент:</span>
                        <span className="font-mono">{Math.round((suggestion.intentScore || 0) * 100)}%</span>
                      </div>
                      <div className="flex justify-between gap-4">
                        <span>Самопроверка:</span>
                        <span className="font-mono">{Math.round((suggestion.selfCheckScore || 0) * 100)}%</span>
                      </div>
                    </div>
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>
          </div>
          
          {/* Phase 1.1: Autosend blocked warning */}
          {suggestion.decision === "AUTO_SEND" && suggestion.autosendEligible === false && (
            <div className="px-4 py-2 bg-amber-500/10 border-t border-amber-500/20">
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
                <div className="text-xs text-amber-700 dark:text-amber-300">
                  {suggestion.autosendBlockReason === "FLAG_OFF" && "Рекомендуется автоответ, но автоотправка отключена глобально"}
                  {suggestion.autosendBlockReason === "SETTING_OFF" && "Рекомендуется автоответ, но автоотправка отключена в настройках"}
                  {suggestion.autosendBlockReason === "INTENT_NOT_ALLOWED" && `Рекомендуется автоответ, но интент "${suggestion.intent}" не разрешён для автоотправки`}
                  {!suggestion.autosendBlockReason && "Рекомендуется автоответ, но автоотправка заблокирована"}
                </div>
              </div>
            </div>
          )}
          
          {/* Phase 1: Explanations */}
          {explanations.length > 0 && (
            <div className="px-4 py-2 bg-muted/50 border-t border-border/50">
              <div className="flex items-start gap-2">
                <Info className="h-3.5 w-3.5 shrink-0 mt-0.5 text-muted-foreground" />
                <div className="text-xs text-muted-foreground space-y-0.5">
                  {explanations.slice(0, 3).map((exp, i) => (
                    <div key={i}>{exp}</div>
                  ))}
                </div>
              </div>
            </div>
          )}
          
          <div className="p-4">
            {isEditing ? (
              <Textarea
                value={editedSuggestion}
                onChange={(e) => setEditedSuggestion(e.target.value)}
                className="min-h-[100px] resize-none"
                data-testid="textarea-edit-suggestion"
              />
            ) : (
              <p className="text-sm whitespace-pre-wrap">{suggestion.suggestedReply}</p>
            )}

            {/* Used Sources */}
            {usedSources.length > 0 && (
              <div className="mt-3">
                <button
                  onClick={() => setShowSources(!showSources)}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                  data-testid="button-toggle-sources"
                >
                  {showSources ? (
                    <ChevronUp className="h-3 w-3" />
                  ) : (
                    <ChevronDown className="h-3 w-3" />
                  )}
                  Использовано источников: {usedSources.length}
                </button>
                {showSources && (
                  <div className="mt-2 space-y-2">
                    {usedSources.map((source, i) => (
                      <div
                        key={i}
                        className="flex items-start gap-2 rounded-md bg-muted p-2 text-xs"
                      >
                        {source.type === "product" ? (
                          <Package className="h-3 w-3 shrink-0 text-muted-foreground" />
                        ) : (
                          <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
                        )}
                        <span className="text-muted-foreground">{source.quote}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Actions */}
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {isEditing ? (
                <>
                  <Button
                    size="sm"
                    onClick={handleApproveEdit}
                    data-testid="button-save-edit"
                  >
                    <Check className="h-4 w-4 sm:mr-1" />
                    <span className="hidden sm:inline">Сохранить</span>
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setIsEditing(false);
                      setEditedSuggestion(suggestion.suggestedReply);
                    }}
                    data-testid="button-cancel-edit"
                  >
                    <X className="h-4 w-4 sm:mr-1" />
                    <span className="hidden sm:inline">Отмена</span>
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    size="sm"
                    onClick={() => onApprove(suggestion.id)}
                    data-testid="button-approve-suggestion"
                  >
                    <Check className="h-4 w-4 sm:mr-1" />
                    <span className="hidden sm:inline">Одобрить</span>
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setIsEditing(true)}
                    data-testid="button-edit-suggestion"
                  >
                    <Edit2 className="h-4 w-4 sm:mr-1" />
                    <span className="hidden sm:inline">Редактировать</span>
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onReject(suggestion.id)}
                    data-testid="button-reject-suggestion"
                  >
                    <X className="h-4 w-4 sm:mr-1" />
                    <span className="hidden sm:inline">Отклонить</span>
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => onEscalate(suggestion.id)}
                    data-testid="button-escalate"
                  >
                    <AlertTriangle className="h-4 w-4 sm:mr-1" />
                    <span className="hidden sm:inline">Эскалировать</span>
                  </Button>
                </>
              )}
            </div>
          </div>
        </Card>
      )}

      {/* Manual Message Input */}
      <div className="border-t p-4">
        <div className="flex gap-2">
          <Textarea
            placeholder="Введите сообщение вручную..."
            value={manualMessage}
            onChange={(e) => setManualMessage(e.target.value)}
            className="min-h-[44px] max-h-[120px] resize-none"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSendManual();
              }
            }}
            data-testid="textarea-manual-message"
          />
          <Button
            size="icon"
            onClick={handleSendManual}
            disabled={!manualMessage.trim()}
            data-testid="button-send-manual"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

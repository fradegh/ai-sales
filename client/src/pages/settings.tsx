import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Building2,
  MessageSquare,
  Clock,
  Bell,
  Bot,
  Save,
  Link2,
  CheckCircle2,
  XCircle,
  Loader2,
  AlertCircle,
  Smartphone,
  Lock,
  Zap,
} from "lucide-react";
import { useBillingStatus, isSubscriptionRequired } from "@/hooks/use-billing";
import { SubscriptionPaywall, ChannelPaywallOverlay, SubscriptionBadge } from "@/components/subscription-paywall";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  FormDescription,
} from "@/components/ui/form";
import type { Tenant, DecisionSettings } from "@shared/schema";
import { VALID_INTENTS } from "@shared/schema";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";

const INTENT_LABELS: Record<string, string> = {
  price: "Цена",
  availability: "Наличие",
  shipping: "Доставка",
  return: "Возврат",
  discount: "Скидка",
  complaint: "Жалоба",
  other: "Другое",
};

const INTENT_OPTIONS = VALID_INTENTS.map(value => ({
  value,
  label: INTENT_LABELS[value] || value,
}));

function DecisionEngineSettings() {
  const { toast } = useToast();
  
  const { data: settings, isLoading } = useQuery<DecisionSettings>({
    queryKey: ["/api/settings/decision"],
  });

  const [tAuto, setTAuto] = useState(0.80);
  const [tEscalate, setTEscalate] = useState(0.40);
  const [autosendAllowed, setAutosendAllowed] = useState(false);
  const [intentsAutosendAllowed, setIntentsAutosendAllowed] = useState<string[]>([
    "price", "availability", "shipping", "other"
  ]);
  const [intentsForceHandoff, setIntentsForceHandoff] = useState<string[]>([
    "discount", "complaint"
  ]);

  useEffect(() => {
    if (settings) {
      setTAuto(settings.tAuto ?? 0.80);
      setTEscalate(settings.tEscalate ?? 0.40);
      setAutosendAllowed(settings.autosendAllowed ?? false);
      setIntentsAutosendAllowed((settings.intentsAutosendAllowed as string[]) ?? ["price", "availability", "shipping", "other"]);
      setIntentsForceHandoff((settings.intentsForceHandoff as string[]) ?? ["discount", "complaint"]);
    }
  }, [settings]);

  const updateMutation = useMutation({
    mutationFn: async (data: Partial<DecisionSettings>) => {
      return apiRequest("PATCH", "/api/settings/decision", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/decision"] });
      toast({ title: "Настройки Decision Engine сохранены" });
    },
    onError: () => {
      toast({ title: "Не удалось сохранить настройки", variant: "destructive" });
    },
  });

  const handleSave = () => {
    updateMutation.mutate({
      tAuto,
      tEscalate,
      autosendAllowed,
      intentsAutosendAllowed,
      intentsForceHandoff,
    });
  };

  const toggleAutosendIntent = (intent: string) => {
    setIntentsAutosendAllowed(prev => 
      prev.includes(intent) 
        ? prev.filter(i => i !== intent)
        : [...prev, intent]
    );
  };

  const toggleHandoffIntent = (intent: string) => {
    setIntentsForceHandoff(prev => 
      prev.includes(intent) 
        ? prev.filter(i => i !== intent)
        : [...prev, intent]
    );
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Decision Engine</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-32 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Decision Engine
          <Badge variant="outline" className="font-normal">Phase 1</Badge>
        </CardTitle>
        <CardDescription>
          Настройка автоматического принятия решений AI
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-4">
          <div>
            <div className="flex items-center justify-between mb-2">
              <Label>Порог автоотправки (tAuto): {Math.round(tAuto * 100)}%</Label>
              <Badge variant="secondary" className="bg-green-500/10 text-green-600">
                Auto-send
              </Badge>
            </div>
            <Slider
              value={[tAuto * 100]}
              onValueChange={([value]) => setTAuto(value / 100)}
              max={100}
              min={Math.round(tEscalate * 100) + 1}
              step={1}
              data-testid="slider-t-auto"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Если уверенность выше {Math.round(tAuto * 100)}%, ответ отправляется автоматически
            </p>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <Label>Порог эскалации (tEscalate): {Math.round(tEscalate * 100)}%</Label>
              <Badge variant="secondary" className="bg-red-500/10 text-red-600">
                Escalate
              </Badge>
            </div>
            <Slider
              value={[tEscalate * 100]}
              onValueChange={([value]) => setTEscalate(value / 100)}
              max={Math.round(tAuto * 100) - 1}
              min={0}
              step={1}
              data-testid="slider-t-escalate"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Если уверенность ниже {Math.round(tEscalate * 100)}%, разговор эскалируется оператору
            </p>
          </div>
        </div>

        <Separator />

        <div className="space-y-4">
          <div className="flex items-center justify-between rounded-md border p-4">
            <div>
              <Label>Разрешить автоотправку</Label>
              <p className="text-xs text-muted-foreground mt-1">
                AI может отправлять ответы без одобрения оператора
              </p>
            </div>
            <Switch
              checked={autosendAllowed}
              onCheckedChange={setAutosendAllowed}
              data-testid="switch-autosend-allowed"
            />
          </div>

          {autosendAllowed && (
            <div className="space-y-2">
              <Label>Интенты для автоотправки</Label>
              <p className="text-xs text-muted-foreground mb-2">
                Выберите типы запросов, для которых разрешена автоотправка
              </p>
              <div className="flex flex-wrap gap-2">
                {INTENT_OPTIONS.map((intent) => (
                  <Badge
                    key={intent.value}
                    variant={intentsAutosendAllowed.includes(intent.value) ? "default" : "outline"}
                    className={cn(
                      "cursor-pointer",
                      intentsAutosendAllowed.includes(intent.value) && "bg-green-500/20 text-green-700 dark:text-green-300"
                    )}
                    onClick={() => toggleAutosendIntent(intent.value)}
                    data-testid={`badge-autosend-${intent.value}`}
                  >
                    {intent.label}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </div>

        <Separator />

        <div className="space-y-2">
          <Label>Интенты для обязательной передачи оператору</Label>
          <p className="text-xs text-muted-foreground mb-2">
            Эти типы запросов всегда требуют вмешательства оператора
          </p>
          <div className="flex flex-wrap gap-2">
            {INTENT_OPTIONS.map((intent) => (
              <Badge
                key={intent.value}
                variant={intentsForceHandoff.includes(intent.value) ? "default" : "outline"}
                className={cn(
                  "cursor-pointer",
                  intentsForceHandoff.includes(intent.value) && "bg-amber-500/20 text-amber-700 dark:text-amber-300"
                )}
                onClick={() => toggleHandoffIntent(intent.value)}
                data-testid={`badge-handoff-${intent.value}`}
              >
                {intent.label}
              </Badge>
            ))}
          </div>
        </div>

        <div className="flex justify-end pt-4">
          <Button
            onClick={handleSave}
            disabled={updateMutation.isPending}
            data-testid="button-save-decision-settings"
          >
            <Save className="mr-2 h-4 w-4" />
            Сохранить настройки Decision Engine
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

const NIGHT_MODE_OPTIONS = [
  { value: "DELAY", label: "Увеличить задержку" },
  { value: "AUTO_REPLY", label: "Автоответ" },
  { value: "DISABLE", label: "Не отправлять" },
];

function HumanDelaySettings() {
  const { toast } = useToast();
  
  interface HumanDelaySettingsData {
    tenantId: string;
    enabled: boolean;
    nightMode: string;
    nightDelayMultiplier: number;
    nightAutoReplyText: string;
    minDelayMs: number;
    maxDelayMs: number;
    typingIndicatorEnabled: boolean;
  }

  const { data: settings, isLoading } = useQuery<HumanDelaySettingsData>({
    queryKey: ["/api/settings/human-delay"],
  });

  const [enabled, setEnabled] = useState(false);
  const [nightMode, setNightMode] = useState("DELAY");
  const [nightDelayMultiplier, setNightDelayMultiplier] = useState(3.0);
  const [nightAutoReplyText, setNightAutoReplyText] = useState("");
  const [minDelayMs, setMinDelayMs] = useState(3000);
  const [maxDelayMs, setMaxDelayMs] = useState(120000);
  const [typingIndicatorEnabled, setTypingIndicatorEnabled] = useState(true);

  useEffect(() => {
    if (settings) {
      setEnabled(settings.enabled ?? false);
      setNightMode(settings.nightMode ?? "DELAY");
      setNightDelayMultiplier(settings.nightDelayMultiplier ?? 3.0);
      setNightAutoReplyText(settings.nightAutoReplyText ?? "");
      setMinDelayMs(settings.minDelayMs ?? 3000);
      setMaxDelayMs(settings.maxDelayMs ?? 120000);
      setTypingIndicatorEnabled(settings.typingIndicatorEnabled ?? true);
    }
  }, [settings]);

  const updateMutation = useMutation({
    mutationFn: async (data: Partial<HumanDelaySettingsData>) => {
      return apiRequest("PATCH", "/api/settings/human-delay", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/settings/human-delay"] });
      toast({ title: "Настройки задержки сохранены" });
    },
    onError: () => {
      toast({ title: "Не удалось сохранить настройки", variant: "destructive" });
    },
  });

  const handleSave = () => {
    updateMutation.mutate({
      enabled,
      nightMode,
      nightDelayMultiplier,
      nightAutoReplyText,
      minDelayMs,
      maxDelayMs,
      typingIndicatorEnabled,
    });
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Human-like Delay</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-32 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Human-like Delay
          <Badge variant="outline" className="font-normal">Phase 2</Badge>
        </CardTitle>
        <CardDescription>
          Имитация человеческих задержек при отправке ответов
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center justify-between rounded-md border p-4">
          <div>
            <Label>Включить задержку ответов</Label>
            <p className="text-xs text-muted-foreground mt-1">
              AI будет отправлять ответы с человекоподобной задержкой
            </p>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={setEnabled}
            data-testid="switch-human-delay-enabled"
          />
        </div>

        {enabled && (
          <>
            <Separator />

            <div className="space-y-4">
              <div>
                <Label className="mb-2 block">Поведение в нерабочее время</Label>
                <Select value={nightMode} onValueChange={setNightMode}>
                  <SelectTrigger data-testid="select-night-mode">
                    <SelectValue placeholder="Выберите режим" />
                  </SelectTrigger>
                  <SelectContent>
                    {NIGHT_MODE_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground mt-1">
                  {nightMode === "DELAY" && "Задержка увеличивается в ночное время"}
                  {nightMode === "AUTO_REPLY" && "Отправляется автоответ вместо AI-ответа"}
                  {nightMode === "DISABLE" && "Ответы не отправляются в нерабочее время"}
                </p>
              </div>

              {nightMode === "DELAY" && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <Label>Множитель ночной задержки: x{nightDelayMultiplier.toFixed(1)}</Label>
                  </div>
                  <Slider
                    value={[nightDelayMultiplier * 10]}
                    onValueChange={([value]) => setNightDelayMultiplier(value / 10)}
                    max={100}
                    min={10}
                    step={5}
                    data-testid="slider-night-multiplier"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Задержка умножается на {nightDelayMultiplier.toFixed(1)} в нерабочее время
                  </p>
                </div>
              )}

              {nightMode === "AUTO_REPLY" && (
                <div>
                  <Label className="mb-2 block">Текст автоответа</Label>
                  <Input
                    value={nightAutoReplyText}
                    onChange={(e) => setNightAutoReplyText(e.target.value)}
                    placeholder="Спасибо за сообщение! Мы ответим в рабочее время."
                    data-testid="input-night-auto-reply"
                  />
                </div>
              )}
            </div>

            <Separator />

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="mb-2 block">Мин. задержка (сек)</Label>
                <Input
                  type="number"
                  value={Math.round(minDelayMs / 1000)}
                  onChange={(e) => setMinDelayMs(Number(e.target.value) * 1000)}
                  min={0}
                  max={Math.round(maxDelayMs / 1000)}
                  data-testid="input-min-delay"
                />
              </div>
              <div>
                <Label className="mb-2 block">Макс. задержка (сек)</Label>
                <Input
                  type="number"
                  value={Math.round(maxDelayMs / 1000)}
                  onChange={(e) => setMaxDelayMs(Number(e.target.value) * 1000)}
                  min={Math.round(minDelayMs / 1000)}
                  data-testid="input-max-delay"
                />
              </div>
            </div>

            <div className="flex items-center justify-between rounded-md border p-4">
              <div>
                <Label>Показывать индикатор набора</Label>
                <p className="text-xs text-muted-foreground mt-1">
                  Показывать "печатает..." пока AI готовит ответ
                </p>
              </div>
              <Switch
                checked={typingIndicatorEnabled}
                onCheckedChange={setTypingIndicatorEnabled}
                data-testid="switch-typing-indicator"
              />
            </div>
          </>
        )}

        <div className="flex justify-end pt-4">
          <Button
            onClick={handleSave}
            disabled={updateMutation.isPending}
            data-testid="button-save-human-delay-settings"
          >
            <Save className="mr-2 h-4 w-4" />
            Сохранить настройки задержки
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

interface TrainingPolicy {
  tenantId: string;
  alwaysEscalateIntents: string[];
  forbiddenTopics: string[];
  disabledLearningIntents: string[];
  updatedAt: string;
}

function TrainingPoliciesSettings() {
  const { toast } = useToast();

  const { data: policy, isLoading } = useQuery<TrainingPolicy>({
    queryKey: ["/api/admin/training-policies"],
  });

  const [alwaysEscalateIntents, setAlwaysEscalateIntents] = useState<string[]>([]);
  const [forbiddenTopics, setForbiddenTopics] = useState<string[]>([]);
  const [disabledLearningIntents, setDisabledLearningIntents] = useState<string[]>([]);
  const [newForbiddenTopic, setNewForbiddenTopic] = useState("");

  useEffect(() => {
    if (policy) {
      setAlwaysEscalateIntents(policy.alwaysEscalateIntents ?? []);
      setForbiddenTopics(policy.forbiddenTopics ?? []);
      setDisabledLearningIntents(policy.disabledLearningIntents ?? []);
    }
  }, [policy]);

  const updateMutation = useMutation({
    mutationFn: async (data: Partial<TrainingPolicy>) => {
      return apiRequest("PUT", "/api/admin/training-policies", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/training-policies"] });
      toast({ title: "Политики обучения сохранены" });
    },
    onError: () => {
      toast({ title: "Не удалось сохранить политики", variant: "destructive" });
    },
  });

  const handleSave = () => {
    updateMutation.mutate({
      alwaysEscalateIntents,
      forbiddenTopics,
      disabledLearningIntents,
    });
  };

  const toggleAlwaysEscalateIntent = (intent: string) => {
    setAlwaysEscalateIntents(prev =>
      prev.includes(intent)
        ? prev.filter(i => i !== intent)
        : [...prev, intent]
    );
  };

  const toggleDisabledLearningIntent = (intent: string) => {
    setDisabledLearningIntents(prev =>
      prev.includes(intent)
        ? prev.filter(i => i !== intent)
        : [...prev, intent]
    );
  };

  const addForbiddenTopic = () => {
    if (newForbiddenTopic.trim() && !forbiddenTopics.includes(newForbiddenTopic.trim())) {
      setForbiddenTopics(prev => [...prev, newForbiddenTopic.trim()]);
      setNewForbiddenTopic("");
    }
  };

  const removeForbiddenTopic = (topic: string) => {
    setForbiddenTopics(prev => prev.filter(t => t !== topic));
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Политики обучения AI</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-32 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Политики обучения AI
          <Badge variant="outline" className="font-normal">Обучение</Badge>
        </CardTitle>
        <CardDescription>
          Настройка правил обучения и поведения AI
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-4">
          <div>
            <Label className="mb-2 block">Интенты всегда требующие проверки</Label>
            <p className="text-xs text-muted-foreground mb-2">
              Эти интенты никогда не будут автоматически отправлены — всегда требуется проверка оператором
            </p>
            <div className="flex flex-wrap gap-2">
              {INTENT_OPTIONS.map((intent) => (
                <Badge
                  key={intent.value}
                  variant={alwaysEscalateIntents.includes(intent.value) ? "default" : "outline"}
                  className={cn(
                    "cursor-pointer",
                    alwaysEscalateIntents.includes(intent.value) && "bg-orange-500/20 text-orange-700 dark:text-orange-300"
                  )}
                  onClick={() => toggleAlwaysEscalateIntent(intent.value)}
                  data-testid={`badge-always-escalate-${intent.value}`}
                >
                  {intent.label}
                </Badge>
              ))}
            </div>
          </div>

          <Separator />

          <div>
            <Label className="mb-2 block">Интенты исключённые из обучения</Label>
            <p className="text-xs text-muted-foreground mb-2">
              Ответы с этими интентами не будут использоваться в few-shot примерах для AI
            </p>
            <div className="flex flex-wrap gap-2">
              {INTENT_OPTIONS.map((intent) => (
                <Badge
                  key={intent.value}
                  variant={disabledLearningIntents.includes(intent.value) ? "default" : "outline"}
                  className={cn(
                    "cursor-pointer",
                    disabledLearningIntents.includes(intent.value) && "bg-purple-500/20 text-purple-700 dark:text-purple-300"
                  )}
                  onClick={() => toggleDisabledLearningIntent(intent.value)}
                  data-testid={`badge-disabled-learning-${intent.value}`}
                >
                  {intent.label}
                </Badge>
              ))}
            </div>
          </div>

          <Separator />

          <div>
            <Label className="mb-2 block">Запрещённые темы</Label>
            <p className="text-xs text-muted-foreground mb-2">
              Разговоры содержащие эти слова не будут сохраняться в обучающий датасет
            </p>
            <div className="flex gap-2 mb-2">
              <Input
                placeholder="Введите тему для исключения..."
                value={newForbiddenTopic}
                onChange={(e) => setNewForbiddenTopic(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addForbiddenTopic())}
                data-testid="input-forbidden-topic"
              />
              <Button
                variant="outline"
                onClick={addForbiddenTopic}
                disabled={!newForbiddenTopic.trim()}
                data-testid="button-add-forbidden-topic"
              >
                Добавить
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              {forbiddenTopics.map((topic) => (
                <Badge
                  key={topic}
                  variant="secondary"
                  className="cursor-pointer bg-red-500/10 text-red-700 dark:text-red-300"
                  onClick={() => removeForbiddenTopic(topic)}
                  data-testid={`badge-forbidden-${topic}`}
                >
                  {topic}
                  <XCircle className="ml-1 h-3 w-3" />
                </Badge>
              ))}
              {forbiddenTopics.length === 0 && (
                <span className="text-xs text-muted-foreground">Нет запрещённых тем</span>
              )}
            </div>
          </div>
        </div>

        <div className="flex justify-end pt-4">
          <Button
            onClick={handleSave}
            disabled={updateMutation.isPending}
            data-testid="button-save-training-policies"
          >
            <Save className="mr-2 h-4 w-4" />
            Сохранить политики
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

interface ChannelStatus {
  channel: string;
  enabled: boolean;
  connected: boolean;
  lastError?: string;
  botInfo?: {
    user_id?: number;
    first_name?: string;
    username?: string;
  };
}

type AuthStep = "idle" | "qr" | "2fa" | "success";

interface TelegramBotCardProps {
  channelStatuses?: ChannelStatus[];
  featureFlags?: Record<string, boolean>;
  toggleChannelMutation: ReturnType<typeof useMutation<any, any, { channel: string; enabled: boolean }>>;
  testConnection: (channel: string, token?: string) => Promise<void>;
  saveConfigMutation: ReturnType<typeof useMutation<any, any, { channel: string; token?: string; webhookSecret?: string }>>;
  testingConnection: boolean;
}

function TelegramBotCard({ 
  channelStatuses, 
  featureFlags, 
  toggleChannelMutation, 
  testConnection,
  saveConfigMutation,
  testingConnection 
}: TelegramBotCardProps) {
  const [botToken, setBotToken] = useState("");

  const telegramStatus = channelStatuses?.find(c => c.channel === "telegram");
  const telegramEnabled = featureFlags?.TELEGRAM_CHANNEL_ENABLED ?? false;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bot className="h-5 w-5" />
          Telegram Bot
          {telegramStatus?.connected ? (
            <Badge variant="outline" className="bg-green-500/10 text-green-600">
              <CheckCircle2 className="mr-1 h-3 w-3" />
              Подключен
            </Badge>
          ) : telegramEnabled ? (
            <Badge variant="outline" className="bg-yellow-500/10 text-yellow-600">
              <AlertCircle className="mr-1 h-3 w-3" />
              Не настроен
            </Badge>
          ) : (
            <Badge variant="outline" className="bg-muted text-muted-foreground">
              <XCircle className="mr-1 h-3 w-3" />
              Отключен
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          Подключите Telegram бота для автоматических ответов клиентам
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between rounded-md border p-4">
          <div>
            <Label>Включить Telegram Bot</Label>
            <p className="text-xs text-muted-foreground mt-1">
              Использовать бота для автоматических ответов
            </p>
          </div>
          <Switch
            checked={telegramEnabled}
            onCheckedChange={(checked) => toggleChannelMutation.mutate({ channel: "telegram", enabled: checked })}
            disabled={toggleChannelMutation.isPending}
            data-testid="switch-telegram-bot-enabled"
          />
        </div>

        {telegramEnabled && (
          <>
            <Separator />

            {telegramStatus?.connected && telegramStatus.botInfo && (
              <div className="rounded-md bg-green-500/10 p-4">
                <div className="flex items-center gap-2 text-green-700 dark:text-green-400">
                  <CheckCircle2 className="h-5 w-5" />
                  <span className="font-medium">Бот подключен</span>
                </div>
                <p className="text-sm text-muted-foreground mt-1">
                  Имя: {telegramStatus.botInfo.first_name || "N/A"} 
                  {telegramStatus.botInfo.username && ` (@${telegramStatus.botInfo.username})`}
                </p>
              </div>
            )}

            {telegramStatus?.lastError && (
              <div className="rounded-md bg-red-500/10 p-4">
                <div className="flex items-center gap-2 text-red-700 dark:text-red-400">
                  <XCircle className="h-5 w-5" />
                  <span className="font-medium">Ошибка подключения</span>
                </div>
                <p className="text-sm text-muted-foreground mt-1">{telegramStatus.lastError}</p>
              </div>
            )}

            <div className="space-y-4">
              <div>
                <Label htmlFor="telegram-bot-token">Токен бота</Label>
                <p className="text-xs text-muted-foreground mb-2">
                  Получите токен у @BotFather в Telegram
                </p>
                <Input
                  id="telegram-bot-token"
                  type="password"
                  placeholder={telegramStatus?.connected ? "••••••••" : "Введите токен бота"}
                  value={botToken}
                  onChange={(e) => setBotToken(e.target.value)}
                  data-testid="input-telegram-bot-token"
                />
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => testConnection("telegram", botToken)}
                disabled={testingConnection || (!botToken && !telegramStatus?.connected)}
                data-testid="button-test-telegram-connection"
              >
                {testingConnection ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="mr-2 h-4 w-4" />
                )}
                Проверить подключение
              </Button>
              <Button
                onClick={() => saveConfigMutation.mutate({ 
                  channel: "telegram", 
                  token: botToken || undefined
                })}
                disabled={saveConfigMutation.isPending || !botToken}
                data-testid="button-save-telegram-config"
              >
                <Save className="mr-2 h-4 w-4" />
                Сохранить
              </Button>
            </div>

            <Separator />

            <div>
              <Label>Webhook URL</Label>
              <p className="text-xs text-muted-foreground mb-2">
                Установите этот URL как webhook для бота через @BotFather или Bot API
              </p>
              <code className="block rounded-md bg-muted px-3 py-2 text-sm font-mono break-all">
                {window.location.origin}/webhooks/telegram
              </code>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

interface TelegramPersonalCardProps {
  channelStatuses?: ChannelStatus[];
  featureFlags?: Record<string, boolean>;
  toggleChannelMutation: ReturnType<typeof useMutation<any, any, { channel: string; enabled: boolean }>>;
  refetch: () => void;
}

function TelegramPersonalCard({ channelStatuses, featureFlags, toggleChannelMutation, refetch }: TelegramPersonalCardProps) {
  const { toast } = useToast();
  const [authStep, setAuthStep] = useState<AuthStep>("idle");
  const [password, setPassword] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [qrImageDataUrl, setQrImageDataUrl] = useState<string | null>(null);
  const [qrExpiresAt, setQrExpiresAt] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [connectedUser, setConnectedUser] = useState<{ firstName?: string; username?: string } | null>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const telegramPersonalStatus = channelStatuses?.find(c => c.channel === "telegram_personal");
  const telegramPersonalEnabled = featureFlags?.TELEGRAM_PERSONAL_CHANNEL_ENABLED ?? false;

  const stopPolling = () => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  };

  const startQrAuth = async () => {
    setIsLoading(true);
    try {
      const response = await apiRequest("POST", "/api/telegram-personal/start-qr-auth", {});
      const result = await response.json();
      
      if (result.success) {
        setSessionId(result.sessionId);
        setQrImageDataUrl(result.qrImageDataUrl);
        setQrExpiresAt(result.expiresAt);
        setAuthStep("qr");
        
        pollIntervalRef.current = setInterval(() => checkQrAuth(result.sessionId), 2000);
      } else {
        toast({ title: "Ошибка", description: result.error, variant: "destructive" });
      }
    } catch (error: any) {
      toast({ title: "Ошибка", description: error.message || "Не удалось получить QR-код", variant: "destructive" });
    } finally {
      setIsLoading(false);
    }
  };

  const checkQrAuth = async (sid: string) => {
    try {
      const response = await apiRequest("POST", "/api/telegram-personal/check-qr-auth", { sessionId: sid });
      const result = await response.json();
      
      if (result.status === "authorized") {
        stopPolling();
        setConnectedUser(result.user);
        setAuthStep("success");
        toast({ title: "Авторизация успешна", description: `Аккаунт: ${result.user?.firstName || "подключен"}` });
        refetch();
      } else if (result.status === "needs_2fa") {
        stopPolling();
        setAuthStep("2fa");
        toast({ title: "Требуется 2FA", description: "Введите пароль двухфакторной аутентификации" });
      } else if (result.status === "expired") {
        stopPolling();
        toast({ title: "QR-код истек", description: "Нажмите кнопку для получения нового", variant: "destructive" });
        setAuthStep("idle");
        setQrImageDataUrl(null);
      } else if (result.qrImageDataUrl) {
        setQrImageDataUrl(result.qrImageDataUrl);
        setQrExpiresAt(result.expiresAt);
      }
    } catch {
      // Ignore polling errors
    }
  };

  const verify2FA = async () => {
    if (!password.trim()) {
      toast({ title: "Введите пароль", variant: "destructive" });
      return;
    }

    setIsLoading(true);
    try {
      const response = await apiRequest("POST", "/api/telegram-personal/verify-qr-2fa", {
        sessionId,
        password,
      });
      const result = await response.json();
      
      if (result.success) {
        setConnectedUser(result.user);
        setAuthStep("success");
        toast({ title: "Авторизация успешна", description: `Аккаунт: ${result.user?.firstName || "подключен"}` });
        refetch();
      } else {
        toast({ title: "Ошибка", description: result.error, variant: "destructive" });
      }
    } catch (error: any) {
      toast({ title: "Ошибка", description: error.message || "Не удалось проверить пароль", variant: "destructive" });
    } finally {
      setIsLoading(false);
    }
  };

  const cancelAuth = async () => {
    stopPolling();
    if (sessionId) {
      try {
        await apiRequest("POST", "/api/telegram-personal/cancel-auth", { sessionId });
      } catch {
        // ignore
      }
    }
    setAuthStep("idle");
    setSessionId(null);
    setQrImageDataUrl(null);
    setPassword("");
  };

  useEffect(() => {
    return () => stopPolling();
  }, []);

  const isConnected = telegramPersonalStatus?.connected || authStep === "success";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Link2 className="h-5 w-5" />
          Telegram Personal
          {isConnected ? (
            <Badge variant="outline" className="bg-green-500/10 text-green-600">
              <CheckCircle2 className="mr-1 h-3 w-3" />
              Подключен
            </Badge>
          ) : telegramPersonalEnabled ? (
            <Badge variant="outline" className="bg-yellow-500/10 text-yellow-600">
              <AlertCircle className="mr-1 h-3 w-3" />
              Не настроен
            </Badge>
          ) : (
            <Badge variant="outline" className="bg-muted text-muted-foreground">
              <XCircle className="mr-1 h-3 w-3" />
              Отключен
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          Подключите личный аккаунт Telegram для отправки сообщений клиентам
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between rounded-md border p-4">
          <div>
            <Label>Включить Telegram Personal</Label>
            <p className="text-xs text-muted-foreground mt-1">
              Использовать личный аккаунт для переписки
            </p>
          </div>
          <Switch
            checked={telegramPersonalEnabled}
            onCheckedChange={(checked) => toggleChannelMutation.mutate({ channel: "telegram_personal", enabled: checked })}
            disabled={toggleChannelMutation.isPending}
            data-testid="switch-telegram-personal-enabled"
          />
        </div>

        {telegramPersonalEnabled && (
          <>
            {isConnected && connectedUser ? (
              <div className="rounded-md border p-4 bg-green-500/5">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-5 w-5 text-green-600" />
                  <div>
                    <p className="font-medium">Аккаунт подключен</p>
                    <p className="text-sm text-muted-foreground">
                      {connectedUser.firstName} {connectedUser.username ? `(@${connectedUser.username})` : ""}
                    </p>
                  </div>
                </div>
              </div>
            ) : telegramPersonalStatus?.connected && telegramPersonalStatus.botInfo ? (
              <div className="rounded-md border p-4 bg-green-500/5">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-5 w-5 text-green-600" />
                  <div>
                    <p className="font-medium">Аккаунт подключен</p>
                    <p className="text-sm text-muted-foreground">
                      {telegramPersonalStatus.botInfo.first_name} {telegramPersonalStatus.botInfo.username ? `(@${telegramPersonalStatus.botInfo.username})` : ""}
                    </p>
                  </div>
                </div>
              </div>
            ) : authStep === "idle" ? (
              <div className="space-y-4">
                <div className="rounded-md border p-4 bg-muted/30">
                  <p className="text-sm mb-3">
                    Для подключения аккаунта отсканируйте QR-код в приложении Telegram на телефоне
                  </p>
                  <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside">
                    <li>Откройте Telegram на телефоне</li>
                    <li>Перейдите в Настройки - Устройства</li>
                    <li>Нажмите "Подключить устройство"</li>
                    <li>Отсканируйте QR-код ниже</li>
                  </ol>
                </div>
                <Button onClick={startQrAuth} disabled={isLoading} data-testid="button-telegram-start-qr">
                  {isLoading ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Link2 className="mr-2 h-4 w-4" />
                  )}
                  Получить QR-код
                </Button>
              </div>
            ) : authStep === "qr" ? (
              <div className="space-y-4">
                <div className="flex flex-col items-center">
                  {qrImageDataUrl ? (
                    <div className="p-4 bg-white rounded-lg">
                      <img 
                        src={qrImageDataUrl} 
                        alt="QR код для авторизации" 
                        className="w-64 h-64"
                        data-testid="img-telegram-qr"
                      />
                    </div>
                  ) : (
                    <div className="w-64 h-64 flex items-center justify-center">
                      <Loader2 className="h-8 w-8 animate-spin" />
                    </div>
                  )}
                  <p className="text-sm text-muted-foreground mt-4 text-center">
                    Отсканируйте QR-код в приложении Telegram
                  </p>
                  {qrExpiresAt && (
                    <p className="text-xs text-muted-foreground">
                      Код обновляется автоматически
                    </p>
                  )}
                </div>
                <div className="flex justify-center">
                  <Button variant="outline" onClick={cancelAuth}>
                    Отмена
                  </Button>
                </div>
              </div>
            ) : authStep === "2fa" ? (
              <div className="space-y-4">
                <div>
                  <Label className="mb-2 block">Пароль 2FA</Label>
                  <Input
                    type="password"
                    placeholder="Пароль двухфакторной аутентификации"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    data-testid="input-telegram-2fa"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Введите пароль, установленный в настройках безопасности Telegram
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={verify2FA} disabled={isLoading} data-testid="button-telegram-verify-2fa">
                    {isLoading ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <CheckCircle2 className="mr-2 h-4 w-4" />
                    )}
                    Подтвердить
                  </Button>
                  <Button variant="outline" onClick={cancelAuth} disabled={isLoading}>
                    Отмена
                  </Button>
                </div>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

interface WhatsAppCardProps {
  channelStatuses?: ChannelStatus[];
  featureFlags?: Record<string, boolean>;
  toggleChannelMutation: ReturnType<typeof useMutation<any, any, { channel: string; enabled: boolean }>>;
  testConnection: (channel: string, token?: string) => Promise<void>;
  saveWhatsAppConfigMutation: ReturnType<typeof useMutation<any, any, { accessToken?: string; phoneNumberId?: string; verifyToken?: string; appSecret?: string }>>;
  testingConnection: boolean;
}

function WhatsAppCard({ 
  channelStatuses, 
  featureFlags, 
  toggleChannelMutation, 
  testConnection,
  saveWhatsAppConfigMutation,
  testingConnection 
}: WhatsAppCardProps) {
  const [accessToken, setAccessToken] = useState("");
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [verifyToken, setVerifyToken] = useState("");
  const [appSecret, setAppSecret] = useState("");

  const whatsappStatus = channelStatuses?.find(c => c.channel === "whatsapp");
  const whatsappEnabled = featureFlags?.WHATSAPP_CHANNEL_ENABLED ?? false;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageSquare className="h-5 w-5" />
          WhatsApp Business
          {whatsappStatus?.connected ? (
            <Badge variant="outline" className="bg-green-500/10 text-green-600">
              <CheckCircle2 className="mr-1 h-3 w-3" />
              Подключен
            </Badge>
          ) : whatsappEnabled ? (
            <Badge variant="outline" className="bg-yellow-500/10 text-yellow-600">
              <AlertCircle className="mr-1 h-3 w-3" />
              Не настроен
            </Badge>
          ) : (
            <Badge variant="outline" className="bg-muted text-muted-foreground">
              <XCircle className="mr-1 h-3 w-3" />
              Отключен
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          Интеграция с WhatsApp Business API для приема и отправки сообщений
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between rounded-md border p-4">
          <div>
            <Label>Включить WhatsApp Business</Label>
            <p className="text-xs text-muted-foreground mt-1">
              Разрешить прием сообщений через WhatsApp
            </p>
          </div>
          <Switch
            checked={whatsappEnabled}
            onCheckedChange={(checked) => toggleChannelMutation.mutate({ channel: "whatsapp", enabled: checked })}
            disabled={toggleChannelMutation.isPending}
            data-testid="switch-whatsapp-enabled"
          />
        </div>

        {whatsappEnabled && (
          <>
            <Separator />

            {whatsappStatus?.connected && (
              <div className="rounded-md bg-green-500/10 p-4">
                <div className="flex items-center gap-2 text-green-700 dark:text-green-400">
                  <CheckCircle2 className="h-5 w-5" />
                  <span className="font-medium">WhatsApp подключен</span>
                </div>
                <p className="text-sm text-muted-foreground mt-1">
                  Готов к приему и отправке сообщений
                </p>
              </div>
            )}

            {whatsappStatus?.lastError && (
              <div className="rounded-md bg-red-500/10 p-4">
                <div className="flex items-center gap-2 text-red-700 dark:text-red-400">
                  <XCircle className="h-5 w-5" />
                  <span className="font-medium">Ошибка подключения</span>
                </div>
                <p className="text-sm text-muted-foreground mt-1">{whatsappStatus.lastError}</p>
              </div>
            )}

            <div className="space-y-4">
              <div>
                <Label htmlFor="whatsapp-access-token">Access Token</Label>
                <p className="text-xs text-muted-foreground mb-2">
                  Токен доступа из Meta Business Suite (developers.facebook.com)
                </p>
                <Input
                  id="whatsapp-access-token"
                  type="password"
                  placeholder={whatsappStatus?.connected ? "••••••••" : "Введите access token"}
                  value={accessToken}
                  onChange={(e) => setAccessToken(e.target.value)}
                  data-testid="input-whatsapp-access-token"
                />
              </div>

              <div>
                <Label htmlFor="whatsapp-phone-number-id">Phone Number ID</Label>
                <p className="text-xs text-muted-foreground mb-2">
                  ID номера телефона из WhatsApp Business API
                </p>
                <Input
                  id="whatsapp-phone-number-id"
                  type="text"
                  placeholder={whatsappStatus?.connected ? "••••••••" : "Введите Phone Number ID"}
                  value={phoneNumberId}
                  onChange={(e) => setPhoneNumberId(e.target.value)}
                  data-testid="input-whatsapp-phone-number-id"
                />
              </div>

              <div>
                <Label htmlFor="whatsapp-verify-token">Verify Token</Label>
                <p className="text-xs text-muted-foreground mb-2">
                  Токен для верификации webhook (произвольная строка)
                </p>
                <Input
                  id="whatsapp-verify-token"
                  type="password"
                  placeholder="Токен верификации webhook"
                  value={verifyToken}
                  onChange={(e) => setVerifyToken(e.target.value)}
                  data-testid="input-whatsapp-verify-token"
                />
              </div>

              <div>
                <Label htmlFor="whatsapp-app-secret">App Secret (опционально)</Label>
                <p className="text-xs text-muted-foreground mb-2">
                  Секрет приложения для проверки подписи webhook (HMAC-SHA256)
                </p>
                <Input
                  id="whatsapp-app-secret"
                  type="password"
                  placeholder="Опциональный секрет приложения"
                  value={appSecret}
                  onChange={(e) => setAppSecret(e.target.value)}
                  data-testid="input-whatsapp-app-secret"
                />
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={() => testConnection("whatsapp", accessToken)}
                disabled={testingConnection || (!accessToken && !whatsappStatus?.connected)}
                data-testid="button-test-whatsapp-connection"
              >
                {testingConnection ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="mr-2 h-4 w-4" />
                )}
                Проверить подключение
              </Button>
              <Button
                onClick={() => saveWhatsAppConfigMutation.mutate({ 
                  accessToken: accessToken || undefined,
                  phoneNumberId: phoneNumberId || undefined,
                  verifyToken: verifyToken || undefined,
                  appSecret: appSecret || undefined
                })}
                disabled={saveWhatsAppConfigMutation.isPending || (!accessToken && !phoneNumberId)}
                data-testid="button-save-whatsapp-config"
              >
                <Save className="mr-2 h-4 w-4" />
                Сохранить конфигурацию
              </Button>
            </div>

            <Separator />

            <div>
              <Label>Webhook URL</Label>
              <p className="text-xs text-muted-foreground mb-2">
                Укажите этот URL в настройках WhatsApp Business API на Meta for Developers
              </p>
              <code className="block rounded-md bg-muted px-3 py-2 text-sm font-mono break-all">
                {window.location.origin}/webhooks/whatsapp
              </code>
            </div>

            <div className="rounded-md bg-muted/50 p-4">
              <p className="text-sm text-muted-foreground">
                <strong>Важно:</strong> WhatsApp Business API позволяет отправлять произвольные сообщения только в течение 24 часов после последнего сообщения от клиента. 
                После этого периода можно отправлять только шаблонные сообщения (Template Messages).
              </p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

interface WhatsAppPersonalCardProps {
  channelStatuses?: ChannelStatus[];
  featureFlags?: Record<string, boolean>;
  toggleChannelMutation: ReturnType<typeof useMutation<any, any, { channel: string; enabled: boolean }>>;
  refetch: () => void;
}

type WhatsAppAuthStatus = "disconnected" | "connecting" | "qr_ready" | "pairing_code_ready" | "connected" | "error" | "reconnecting";
type WhatsAppAuthMethod = "qr" | "phone";

function MaxPersonalCard({ channelStatuses, featureFlags, toggleChannelMutation, refetch }: WhatsAppPersonalCardProps) {
  const { toast } = useToast();
  const [authStatus, setAuthStatus] = useState<WhatsAppAuthStatus>("disconnected");
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [serviceAvailable, setServiceAvailable] = useState<boolean | null>(null);
  const [connectedUser, setConnectedUser] = useState<{ id: string; name: string; phone: string } | null>(null);
  const [fallbackMessage, setFallbackMessage] = useState<string | null>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const maxPersonalStatus = channelStatuses?.find(c => c.channel === "max_personal");
  const maxPersonalEnabled = featureFlags?.MAX_PERSONAL_CHANNEL_ENABLED ?? false;

  const stopPolling = () => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  };

  const checkServiceStatus = async () => {
    try {
      const response = await apiRequest("GET", "/api/max-personal/service-status", undefined);
      const result = await response.json();
      setServiceAvailable(result.available);
    } catch {
      setServiceAvailable(false);
    }
  };

  const startAuth = async () => {
    setIsLoading(true);
    setFallbackMessage(null);
    try {
      const response = await apiRequest("POST", "/api/max-personal/start-auth", {});
      const result = await response.json();
      
      if (result.success) {
        if (result.status === "connected" || result.status === "already_connected") {
          setAuthStatus("connected");
          setConnectedUser(result.user);
          toast({ title: "Подключение успешно", description: "Max аккаунт уже авторизован" });
          refetch();
        } else if (result.qr_data_url || result.qrDataUrl) {
          setQrDataUrl(result.qr_data_url || result.qrDataUrl);
          setAuthStatus("qr_ready");
          if (result.fallback && result.message) {
            setFallbackMessage(result.message);
          }
          pollIntervalRef.current = setInterval(checkAuth, 2000);
        }
      } else {
        toast({ title: "Ошибка", description: result.error, variant: "destructive" });
      }
    } catch (error: any) {
      toast({ title: "Ошибка", description: error.message || "Не удалось начать авторизацию", variant: "destructive" });
    } finally {
      setIsLoading(false);
    }
  };

  const checkAuth = async () => {
    try {
      const response = await apiRequest("POST", "/api/max-personal/check-auth", {});
      const result = await response.json();
      
      if (result.status === "connected") {
        stopPolling();
        setConnectedUser(result.user);
        setAuthStatus("connected");
        toast({ title: "Авторизация успешна", description: `Аккаунт: ${result.user?.name || result.user?.phone || "подключен"}` });
        refetch();
      } else if (result.status === "qr_ready" && result.qrDataUrl) {
        setQrDataUrl(result.qrDataUrl);
        setAuthStatus("qr_ready");
      } else if (result.status === "connecting") {
        setAuthStatus("connecting");
      } else if (result.status === "error" || result.status === "disconnected") {
        stopPolling();
        setAuthStatus("disconnected");
        if (result.error) {
          toast({ title: "Ошибка", description: result.error, variant: "destructive" });
        }
      }
    } catch {
    }
  };

  const logout = async () => {
    setIsLoading(true);
    try {
      await apiRequest("POST", "/api/max-personal/logout", {});
      setAuthStatus("disconnected");
      setConnectedUser(null);
      setQrDataUrl(null);
      toast({ title: "Выход выполнен" });
      refetch();
    } catch (error: any) {
      toast({ title: "Ошибка", description: error.message || "Не удалось выйти", variant: "destructive" });
    } finally {
      setIsLoading(false);
    }
  };

  const cancelAuth = () => {
    stopPolling();
    setAuthStatus("disconnected");
    setQrDataUrl(null);
  };

  useEffect(() => {
    if (maxPersonalEnabled) {
      checkServiceStatus();
    }
    return () => stopPolling();
  }, [maxPersonalEnabled]);

  const isConnected = maxPersonalStatus?.connected || authStatus === "connected";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageSquare className="h-5 w-5" />
          Max Personal
          {isConnected ? (
            <Badge variant="outline" className="bg-green-500/10 text-green-600">
              <CheckCircle2 className="mr-1 h-3 w-3" />
              Подключен
            </Badge>
          ) : maxPersonalEnabled ? (
            <Badge variant="outline" className="bg-yellow-500/10 text-yellow-600">
              <AlertCircle className="mr-1 h-3 w-3" />
              Не настроен
            </Badge>
          ) : (
            <Badge variant="outline" className="bg-muted text-muted-foreground">
              <XCircle className="mr-1 h-3 w-3" />
              Отключен
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          Подключите личный аккаунт Max через QR-код
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between rounded-md border p-4">
          <div>
            <Label>Включить Max Personal</Label>
            <p className="text-xs text-muted-foreground mt-1">
              Использовать личный аккаунт для переписки
            </p>
          </div>
          <Switch
            checked={maxPersonalEnabled}
            onCheckedChange={(checked) => toggleChannelMutation.mutate({ channel: "max_personal", enabled: checked })}
            disabled={toggleChannelMutation.isPending}
            data-testid="switch-max-personal-enabled"
          />
        </div>

        {maxPersonalEnabled && (
          <>
            <div className="rounded-md bg-yellow-500/10 border border-yellow-500/20 p-4">
              <div className="flex items-start gap-2">
                <AlertCircle className="h-5 w-5 text-yellow-600 mt-0.5" />
                <div>
                  <p className="font-medium text-yellow-700 dark:text-yellow-400">Важное предупреждение</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    Это неофициальный метод интеграции. Max может ограничить или заблокировать аккаунт при подозрительной активности. Используйте с осторожностью.
                  </p>
                </div>
              </div>
            </div>

            {serviceAvailable === false && (
              <div className="rounded-md bg-red-500/10 border border-red-500/20 p-4">
                <div className="flex items-start gap-2">
                  <XCircle className="h-5 w-5 text-red-600 mt-0.5" />
                  <div>
                    <p className="font-medium text-red-700 dark:text-red-400">Сервис недоступен</p>
                    <p className="text-sm text-muted-foreground mt-1">
                      Max Personal сервис не запущен. Обратитесь к администратору.
                    </p>
                  </div>
                </div>
              </div>
            )}

            {serviceAvailable !== false && (
              <>
                {isConnected && connectedUser ? (
                  <div className="rounded-md border p-4 bg-green-500/5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <CheckCircle2 className="h-5 w-5 text-green-600" />
                        <div>
                          <p className="font-medium">Аккаунт подключен</p>
                          <p className="text-sm text-muted-foreground">
                            {connectedUser.name || connectedUser.phone}
                          </p>
                        </div>
                      </div>
                      <Button variant="outline" size="sm" onClick={logout} disabled={isLoading} data-testid="button-max-personal-logout">
                        {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Отключить"}
                      </Button>
                    </div>
                  </div>
                ) : maxPersonalStatus?.connected && maxPersonalStatus.botInfo ? (
                  <div className="rounded-md border p-4 bg-green-500/5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <CheckCircle2 className="h-5 w-5 text-green-600" />
                        <div>
                          <p className="font-medium">Аккаунт подключен</p>
                          <p className="text-sm text-muted-foreground">
                            {maxPersonalStatus.botInfo.first_name}
                            {maxPersonalStatus.botInfo.username && ` (+${maxPersonalStatus.botInfo.username})`}
                          </p>
                        </div>
                      </div>
                      <Button variant="outline" size="sm" onClick={logout} disabled={isLoading} data-testid="button-max-personal-logout">
                        {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Отключить"}
                      </Button>
                    </div>
                  </div>
                ) : authStatus === "disconnected" ? (
                  <div className="space-y-4">
                    <div className="rounded-md border p-4">
                      <h4 className="font-medium text-sm mb-3">Подключение через QR-код</h4>
                      <p className="text-xs text-muted-foreground mb-3">
                        Нажмите кнопку для получения QR-кода. Откройте Max на телефоне, перейдите в Настройки → Устройства → Привязать устройство и отсканируйте код.
                      </p>
                      <div className="space-y-3">
                        <Button onClick={startAuth} disabled={isLoading} className="w-full" data-testid="button-max-start-auth">
                          {isLoading ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <MessageSquare className="mr-2 h-4 w-4" />
                          )}
                          Получить QR-код
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : authStatus === "qr_ready" || authStatus === "connecting" ? (
                  <div className="space-y-4">
                    <div className="flex flex-col items-center">
                      {authStatus === "connecting" ? (
                        <div className="w-64 h-64 flex flex-col items-center justify-center gap-2">
                          <Loader2 className="h-8 w-8 animate-spin" />
                          <p className="text-sm text-muted-foreground">Подключение...</p>
                        </div>
                      ) : qrDataUrl ? (
                        <div className="p-4 bg-white rounded-lg">
                          <img 
                            src={qrDataUrl} 
                            alt="QR код для авторизации Max" 
                            className="w-64 h-64"
                            data-testid="img-max-qr"
                          />
                        </div>
                      ) : (
                        <div className="w-64 h-64 flex items-center justify-center">
                          <Loader2 className="h-8 w-8 animate-spin" />
                        </div>
                      )}
                      <p className="text-sm text-muted-foreground mt-4 text-center">
                        {fallbackMessage || "Отсканируйте QR-код в приложении Max"}
                      </p>
                      {!fallbackMessage && (
                        <p className="text-xs text-muted-foreground">
                          Код обновляется автоматически
                        </p>
                      )}
                    </div>
                    <div className="flex justify-center">
                      <Button variant="outline" onClick={cancelAuth} data-testid="button-max-cancel-auth">
                        Отмена
                      </Button>
                    </div>
                  </div>
                ) : null}
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function WhatsAppPersonalCard({ channelStatuses, featureFlags, toggleChannelMutation, refetch }: WhatsAppPersonalCardProps) {
  const { toast } = useToast();
  const [authStatus, setAuthStatus] = useState<WhatsAppAuthStatus>("disconnected");
  const [authMethod, setAuthMethod] = useState<WhatsAppAuthMethod | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [phoneNumber, setPhoneNumber] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [connectedUser, setConnectedUser] = useState<{ id: string; name: string; phone: string } | null>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const whatsappPersonalStatus = channelStatuses?.find(c => c.channel === "whatsapp_personal");
  const whatsappPersonalEnabled = featureFlags?.WHATSAPP_PERSONAL_CHANNEL_ENABLED ?? false;

  const stopPolling = () => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  };

  const startAuth = async () => {
    setIsLoading(true);
    setAuthMethod("qr");
    try {
      const response = await apiRequest("POST", "/api/whatsapp-personal/start-auth", {});
      const result = await response.json();
      
      if (result.success) {
        if (result.status === "connected") {
          setAuthStatus("connected");
          toast({ title: "Подключение успешно", description: "WhatsApp аккаунт уже авторизован" });
          refetch();
        } else if (result.qrDataUrl) {
          setQrDataUrl(result.qrDataUrl);
          setAuthStatus("qr_ready");
          pollIntervalRef.current = setInterval(checkAuth, 2000);
        }
      } else {
        toast({ title: "Ошибка", description: result.error, variant: "destructive" });
      }
    } catch (error: any) {
      toast({ title: "Ошибка", description: error.message || "Не удалось начать авторизацию", variant: "destructive" });
    } finally {
      setIsLoading(false);
    }
  };

  const startAuthWithPhone = async () => {
    if (!phoneNumber.trim()) {
      toast({ title: "Ошибка", description: "Введите номер телефона", variant: "destructive" });
      return;
    }
    
    setIsLoading(true);
    setAuthMethod("phone");
    try {
      const response = await apiRequest("POST", "/api/whatsapp-personal/start-auth-phone", { phoneNumber });
      const result = await response.json();
      
      if (result.success) {
        if (result.status === "connected") {
          setAuthStatus("connected");
          toast({ title: "Подключение успешно", description: "WhatsApp аккаунт уже авторизован" });
          refetch();
        } else if (result.pairingCode) {
          setPairingCode(result.pairingCode);
          setAuthStatus("pairing_code_ready");
          pollIntervalRef.current = setInterval(checkAuth, 2000);
        }
      } else {
        toast({ title: "Ошибка", description: result.error, variant: "destructive" });
      }
    } catch (error: any) {
      toast({ title: "Ошибка", description: error.message || "Не удалось начать авторизацию", variant: "destructive" });
    } finally {
      setIsLoading(false);
    }
  };

  const checkAuth = async () => {
    try {
      const response = await apiRequest("POST", "/api/whatsapp-personal/check-auth", {});
      const result = await response.json();
      
      if (result.status === "connected") {
        stopPolling();
        setConnectedUser(result.user);
        setAuthStatus("connected");
        toast({ title: "Авторизация успешна", description: `Аккаунт: ${result.user?.name || result.user?.phone || "подключен"}` });
        refetch();
      } else if (result.status === "qr_ready" && result.qrDataUrl) {
        setQrDataUrl(result.qrDataUrl);
        setAuthStatus("qr_ready");
      } else if (result.status === "pairing_code_ready" && result.pairingCode) {
        setPairingCode(result.pairingCode);
        setAuthStatus("pairing_code_ready");
      } else if (result.status === "connecting") {
        setAuthStatus("connecting");
      } else if (result.status === "error" || result.status === "disconnected") {
        stopPolling();
        setAuthStatus("disconnected");
        if (result.error) {
          toast({ title: "Ошибка", description: result.error, variant: "destructive" });
        }
      }
    } catch {
    }
  };

  const logout = async () => {
    setIsLoading(true);
    try {
      await apiRequest("POST", "/api/whatsapp-personal/logout", {});
      setAuthStatus("disconnected");
      setConnectedUser(null);
      setQrDataUrl(null);
      setPairingCode(null);
      setAuthMethod(null);
      toast({ title: "Выход выполнен" });
      refetch();
    } catch (error: any) {
      toast({ title: "Ошибка", description: error.message || "Не удалось выйти", variant: "destructive" });
    } finally {
      setIsLoading(false);
    }
  };

  const cancelAuth = () => {
    stopPolling();
    setAuthStatus("disconnected");
    setQrDataUrl(null);
    setPairingCode(null);
    setAuthMethod(null);
  };

  useEffect(() => {
    return () => stopPolling();
  }, []);

  const isConnected = whatsappPersonalStatus?.connected || authStatus === "connected";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Smartphone className="h-5 w-5" />
          WhatsApp Personal
          {isConnected ? (
            <Badge variant="outline" className="bg-green-500/10 text-green-600">
              <CheckCircle2 className="mr-1 h-3 w-3" />
              Подключен
            </Badge>
          ) : whatsappPersonalEnabled ? (
            <Badge variant="outline" className="bg-yellow-500/10 text-yellow-600">
              <AlertCircle className="mr-1 h-3 w-3" />
              Не настроен
            </Badge>
          ) : (
            <Badge variant="outline" className="bg-muted text-muted-foreground">
              <XCircle className="mr-1 h-3 w-3" />
              Отключен
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          Подключите личный аккаунт WhatsApp через QR-код или номер телефона
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between rounded-md border p-4">
          <div>
            <Label>Включить WhatsApp Personal</Label>
            <p className="text-xs text-muted-foreground mt-1">
              Использовать личный аккаунт для переписки
            </p>
          </div>
          <Switch
            checked={whatsappPersonalEnabled}
            onCheckedChange={(checked) => toggleChannelMutation.mutate({ channel: "whatsapp_personal", enabled: checked })}
            disabled={toggleChannelMutation.isPending}
            data-testid="switch-whatsapp-personal-enabled"
          />
        </div>

        {whatsappPersonalEnabled && (
          <>
            <div className="rounded-md bg-yellow-500/10 border border-yellow-500/20 p-4">
              <div className="flex items-start gap-2">
                <AlertCircle className="h-5 w-5 text-yellow-600 mt-0.5" />
                <div>
                  <p className="font-medium text-yellow-700 dark:text-yellow-400">Важное предупреждение</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    Это неофициальный метод интеграции. WhatsApp может ограничить или заблокировать аккаунт при подозрительной активности. Используйте с осторожностью.
                  </p>
                </div>
              </div>
            </div>

            {isConnected && connectedUser ? (
              <div className="rounded-md border p-4 bg-green-500/5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-5 w-5 text-green-600" />
                    <div>
                      <p className="font-medium">Аккаунт подключен</p>
                      <p className="text-sm text-muted-foreground">
                        {connectedUser.name || connectedUser.phone}
                      </p>
                    </div>
                  </div>
                  <Button variant="outline" size="sm" onClick={logout} disabled={isLoading}>
                    {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Отключить"}
                  </Button>
                </div>
              </div>
            ) : whatsappPersonalStatus?.connected && whatsappPersonalStatus.botInfo ? (
              <div className="rounded-md border p-4 bg-green-500/5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-5 w-5 text-green-600" />
                    <div>
                      <p className="font-medium">Аккаунт подключен</p>
                      <p className="text-sm text-muted-foreground">
                        {whatsappPersonalStatus.botInfo.first_name}
                        {whatsappPersonalStatus.botInfo.username && ` (+${whatsappPersonalStatus.botInfo.username})`}
                      </p>
                    </div>
                  </div>
                  <Button variant="outline" size="sm" onClick={logout} disabled={isLoading}>
                    {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Отключить"}
                  </Button>
                </div>
              </div>
            ) : authStatus === "disconnected" ? (
              <div className="space-y-4">
                <div className="rounded-md border p-4 bg-muted/30">
                  <p className="text-sm mb-3">
                    Выберите способ подключения WhatsApp аккаунта:
                  </p>
                </div>
                
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="rounded-md border p-4 space-y-3">
                    <h4 className="font-medium text-sm">Через QR-код</h4>
                    <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside">
                      <li>Откройте WhatsApp на телефоне</li>
                      <li>Настройки - Связанные устройства</li>
                      <li>Нажмите "Привязать устройство"</li>
                      <li>Отсканируйте QR-код</li>
                    </ol>
                    <Button onClick={startAuth} disabled={isLoading} className="w-full" data-testid="button-whatsapp-start-qr">
                      {isLoading && authMethod === "qr" ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Smartphone className="mr-2 h-4 w-4" />
                      )}
                      Получить QR-код
                    </Button>
                  </div>
                  
                  <div className="rounded-md border p-4 space-y-3">
                    <h4 className="font-medium text-sm">По номеру телефона</h4>
                    <p className="text-xs text-muted-foreground">
                      Введите номер телефона WhatsApp и получите код для ввода в приложении
                    </p>
                    <Input
                      placeholder="+7 999 123 45 67"
                      value={phoneNumber}
                      onChange={(e) => setPhoneNumber(e.target.value)}
                      data-testid="input-whatsapp-phone"
                    />
                    <Button onClick={startAuthWithPhone} disabled={isLoading || !phoneNumber.trim()} className="w-full" data-testid="button-whatsapp-start-phone">
                      {isLoading && authMethod === "phone" ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Smartphone className="mr-2 h-4 w-4" />
                      )}
                      Получить код
                    </Button>
                  </div>
                </div>
              </div>
            ) : authStatus === "qr_ready" || (authStatus === "connecting" && authMethod === "qr") ? (
              <div className="space-y-4">
                <div className="flex flex-col items-center">
                  {authStatus === "connecting" ? (
                    <div className="w-64 h-64 flex flex-col items-center justify-center gap-2">
                      <Loader2 className="h-8 w-8 animate-spin" />
                      <p className="text-sm text-muted-foreground">Обновление QR-кода...</p>
                    </div>
                  ) : qrDataUrl ? (
                    <div className="p-4 bg-white rounded-lg">
                      <img 
                        src={qrDataUrl} 
                        alt="QR код для авторизации WhatsApp" 
                        className="w-64 h-64"
                        data-testid="img-whatsapp-qr"
                      />
                    </div>
                  ) : (
                    <div className="w-64 h-64 flex items-center justify-center">
                      <Loader2 className="h-8 w-8 animate-spin" />
                    </div>
                  )}
                  <p className="text-sm text-muted-foreground mt-4 text-center">
                    Отсканируйте QR-код в приложении WhatsApp
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Код обновляется автоматически каждые 20 сек
                  </p>
                </div>
                <div className="flex justify-center">
                  <Button variant="outline" onClick={cancelAuth}>
                    Отмена
                  </Button>
                </div>
              </div>
            ) : authStatus === "pairing_code_ready" || (authStatus === "connecting" && authMethod === "phone") ? (
              <div className="space-y-4">
                <div className="flex flex-col items-center">
                  {authStatus === "connecting" ? (
                    <div className="h-32 flex flex-col items-center justify-center gap-2">
                      <Loader2 className="h-8 w-8 animate-spin" />
                      <p className="text-sm text-muted-foreground">Подключение...</p>
                    </div>
                  ) : pairingCode ? (
                    <div className="text-center space-y-4">
                      <p className="text-sm text-muted-foreground">
                        Введите этот код в WhatsApp:
                      </p>
                      <div className="text-4xl font-mono font-bold tracking-widest bg-muted p-4 rounded-lg" data-testid="text-pairing-code">
                        {pairingCode.slice(0, 4)}-{pairingCode.slice(4)}
                      </div>
                      <div className="text-xs text-muted-foreground space-y-1">
                        <p>1. Откройте WhatsApp - Настройки - Связанные устройства</p>
                        <p>2. Нажмите "Привязать устройство"</p>
                        <p>3. Выберите "Связать по номеру телефона"</p>
                        <p>4. Введите код выше</p>
                      </div>
                    </div>
                  ) : (
                    <div className="h-32 flex items-center justify-center">
                      <Loader2 className="h-8 w-8 animate-spin" />
                    </div>
                  )}
                </div>
                <div className="flex justify-center">
                  <Button variant="outline" onClick={cancelAuth}>
                    Отмена
                  </Button>
                </div>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ChannelSettings() {
  const { toast } = useToast();
  const [maxToken, setMaxToken] = useState("");
  const [maxWebhookSecret, setMaxWebhookSecret] = useState("");
  const [testingConnection, setTestingConnection] = useState(false);
  const [showPaywall, setShowPaywall] = useState(false);

  const { data: billingStatus } = useBillingStatus();
  const canAccess = billingStatus?.canAccess ?? false;

  const { data: channelStatuses, isLoading, refetch } = useQuery<ChannelStatus[]>({
    queryKey: ["/api/channels/status"],
  });

  const { data: featureFlags } = useQuery<Record<string, boolean>>({
    queryKey: ["/api/channels/feature-flags"],
  });

  const toggleChannelMutation = useMutation({
    mutationFn: async ({ channel, enabled }: { channel: string; enabled: boolean }) => {
      return apiRequest("POST", `/api/channels/${channel}/toggle`, { enabled });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/channels/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/channels/feature-flags"] });
      toast({ title: "Настройки канала обновлены" });
    },
    onError: async (error: any) => {
      if (error?.response) {
        try {
          const data = await error.response.json();
          if (isSubscriptionRequired(data)) {
            setShowPaywall(true);
            return;
          }
        } catch {}
      }
      toast({ title: "Не удалось обновить настройки канала", variant: "destructive" });
    },
  });

  const saveConfigMutation = useMutation({
    mutationFn: async (config: { channel: string; token?: string; webhookSecret?: string }) => {
      return apiRequest("POST", `/api/channels/${config.channel}/config`, config);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/channels/status"] });
      toast({ title: "Конфигурация сохранена" });
      setMaxToken("");
      setMaxWebhookSecret("");
    },
    onError: () => {
      toast({ title: "Не удалось сохранить конфигурацию", variant: "destructive" });
    },
  });

  const saveWhatsAppConfigMutation = useMutation({
    mutationFn: async (config: { accessToken?: string; phoneNumberId?: string; verifyToken?: string; appSecret?: string }) => {
      return apiRequest("POST", `/api/channels/whatsapp/config`, config);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/channels/status"] });
      toast({ title: "Конфигурация WhatsApp сохранена" });
    },
    onError: () => {
      toast({ title: "Не удалось сохранить конфигурацию WhatsApp", variant: "destructive" });
    },
  });

  const testConnection = async (channel: string, testToken?: string) => {
    setTestingConnection(true);
    try {
      const response = await apiRequest("POST", `/api/channels/${channel}/test`, { 
        token: testToken || undefined 
      });
      const result = await response.json();
      if (result.success) {
        toast({ 
          title: "Подключение успешно", 
          description: result.botInfo?.first_name 
            ? `Бот: ${result.botInfo.first_name} (@${result.botInfo.username || 'N/A'})`
            : "Токен действителен"
        });
        refetch();
      } else {
        toast({ 
          title: "Ошибка подключения", 
          description: result.error || "Не удалось подключиться",
          variant: "destructive" 
        });
      }
    } catch {
      toast({ title: "Ошибка проверки подключения", variant: "destructive" });
    } finally {
      setTestingConnection(false);
    }
  };

  const maxStatus = channelStatuses?.find(c => c.channel === "max");
  const maxEnabled = featureFlags?.MAX_CHANNEL_ENABLED ?? false;

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Каналы связи</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-32 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <SubscriptionPaywall 
        open={showPaywall} 
        onOpenChange={setShowPaywall}
        trigger="channel"
      />
      
      {!canAccess && (
        <Card className="mb-6 border-yellow-500/30 bg-yellow-500/5" data-testid="banner-subscription-warning">
          <CardContent className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 py-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-yellow-500/10">
                <Lock className="h-5 w-5 text-yellow-600" />
              </div>
              <div>
                <p className="font-medium" data-testid="text-subscription-warning">Подписка не активна</p>
                <p className="text-sm text-muted-foreground">
                  Подключение каналов требует активной подписки
                </p>
              </div>
            </div>
            <Button 
              onClick={() => setShowPaywall(true)} 
              data-testid="button-channels-subscribe"
              className="w-full sm:w-auto"
            >
              <Zap className="mr-2 h-4 w-4" />
              Активировать за $50/мес
            </Button>
          </CardContent>
        </Card>
      )}

      <ChannelPaywallOverlay canAccess={canAccess} onSubscribeClick={() => setShowPaywall(true)}>
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Link2 className="h-5 w-5" />
                MAX Messenger
            {maxStatus?.connected ? (
              <Badge variant="outline" className="bg-green-500/10 text-green-600">
                <CheckCircle2 className="mr-1 h-3 w-3" />
                Подключен
              </Badge>
            ) : maxEnabled ? (
              <Badge variant="outline" className="bg-yellow-500/10 text-yellow-600">
                <AlertCircle className="mr-1 h-3 w-3" />
                Не настроен
              </Badge>
            ) : (
              <Badge variant="outline" className="bg-muted text-muted-foreground">
                <XCircle className="mr-1 h-3 w-3" />
                Отключен
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            Интеграция с MAX (VK Teams) для приема и отправки сообщений
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between rounded-md border p-4">
            <div>
              <Label>Включить канал MAX</Label>
              <p className="text-xs text-muted-foreground mt-1">
                Разрешить прием сообщений через MAX Messenger
              </p>
            </div>
            <Switch
              checked={maxEnabled}
              onCheckedChange={(checked) => toggleChannelMutation.mutate({ channel: "max", enabled: checked })}
              disabled={toggleChannelMutation.isPending}
              data-testid="switch-max-enabled"
            />
          </div>

          {maxEnabled && (
            <>
              <Separator />

              {maxStatus?.connected && maxStatus.botInfo && (
                <div className="rounded-md bg-green-500/10 p-4">
                  <div className="flex items-center gap-2 text-green-700 dark:text-green-400">
                    <CheckCircle2 className="h-5 w-5" />
                    <span className="font-medium">Бот подключен</span>
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">
                    Имя: {maxStatus.botInfo.first_name || "N/A"} 
                    {maxStatus.botInfo.username && ` (@${maxStatus.botInfo.username})`}
                  </p>
                </div>
              )}

              {maxStatus?.lastError && (
                <div className="rounded-md bg-red-500/10 p-4">
                  <div className="flex items-center gap-2 text-red-700 dark:text-red-400">
                    <XCircle className="h-5 w-5" />
                    <span className="font-medium">Ошибка подключения</span>
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">{maxStatus.lastError}</p>
                </div>
              )}

              <div className="space-y-4">
                <div>
                  <Label htmlFor="max-token">API Токен</Label>
                  <p className="text-xs text-muted-foreground mb-2">
                    Получите токен в platform.max.ru в разделе "Мои боты"
                  </p>
                  <Input
                    id="max-token"
                    type="password"
                    placeholder={maxStatus?.connected ? "••••••••" : "Введите токен бота"}
                    value={maxToken}
                    onChange={(e) => setMaxToken(e.target.value)}
                    data-testid="input-max-token"
                  />
                </div>

                <div>
                  <Label htmlFor="max-webhook-secret">Webhook Secret (опционально)</Label>
                  <p className="text-xs text-muted-foreground mb-2">
                    Секретный ключ для проверки подлинности webhook-запросов
                  </p>
                  <Input
                    id="max-webhook-secret"
                    type="password"
                    placeholder="Опциональный секрет"
                    value={maxWebhookSecret}
                    onChange={(e) => setMaxWebhookSecret(e.target.value)}
                    data-testid="input-max-webhook-secret"
                  />
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() => testConnection("max", maxToken)}
                  disabled={testingConnection || (!maxToken && !maxStatus?.connected)}
                  data-testid="button-test-max-connection"
                >
                  {testingConnection ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="mr-2 h-4 w-4" />
                  )}
                  Проверить подключение
                </Button>
                <Button
                  onClick={() => saveConfigMutation.mutate({ 
                    channel: "max", 
                    token: maxToken || undefined,
                    webhookSecret: maxWebhookSecret || undefined
                  })}
                  disabled={saveConfigMutation.isPending || (!maxToken && !maxWebhookSecret)}
                  data-testid="button-save-max-config"
                >
                  <Save className="mr-2 h-4 w-4" />
                  Сохранить конфигурацию
                </Button>
              </div>

              <Separator />

              <div>
                <Label>Webhook URL</Label>
                <p className="text-xs text-muted-foreground mb-2">
                  Укажите этот URL в настройках бота на platform.max.ru
                </p>
                <code className="block rounded-md bg-muted px-3 py-2 text-sm font-mono">
                  {window.location.origin}/webhooks/max
                </code>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <TelegramBotCard 
        channelStatuses={channelStatuses}
        featureFlags={featureFlags}
        toggleChannelMutation={toggleChannelMutation}
        testConnection={testConnection}
        saveConfigMutation={saveConfigMutation}
        testingConnection={testingConnection}
      />

      <TelegramPersonalCard 
        channelStatuses={channelStatuses}
        featureFlags={featureFlags}
        toggleChannelMutation={toggleChannelMutation}
        refetch={refetch}
      />

      <WhatsAppCard 
        channelStatuses={channelStatuses}
        featureFlags={featureFlags}
        toggleChannelMutation={toggleChannelMutation}
        testConnection={testConnection}
        saveWhatsAppConfigMutation={saveWhatsAppConfigMutation}
        testingConnection={testingConnection}
      />

      <WhatsAppPersonalCard
        channelStatuses={channelStatuses}
        featureFlags={featureFlags}
        toggleChannelMutation={toggleChannelMutation}
        refetch={refetch}
      />

      <MaxPersonalCard
        channelStatuses={channelStatuses}
        featureFlags={featureFlags}
        toggleChannelMutation={toggleChannelMutation}
        refetch={refetch}
      />
        </div>
      </ChannelPaywallOverlay>
    </>
  );
}

const settingsFormSchema = z.object({
  name: z.string().min(1, "Название бизнеса обязательно"),
  language: z.string(),
  tone: z.string(),
  addressStyle: z.string(),
  currency: z.string(),
  timezone: z.string(),
  workingHoursStart: z.string(),
  workingHoursEnd: z.string(),
  autoReplyOutsideHours: z.boolean(),
  escalationEmail: z.string().email().optional().or(z.literal("")),
  escalationTelegram: z.string().optional(),
  allowDiscounts: z.boolean(),
  maxDiscountPercent: z.coerce.number().min(0).max(100),
});

type SettingsFormValues = z.infer<typeof settingsFormSchema>;

export default function Settings() {
  const { toast } = useToast();

  const { data: tenant, isLoading } = useQuery<Tenant>({
    queryKey: ["/api/tenant"],
  });

  const form = useForm<SettingsFormValues>({
    resolver: zodResolver(settingsFormSchema),
    defaultValues: {
      name: "",
      language: "ru",
      tone: "formal",
      addressStyle: "vy",
      currency: "RUB",
      timezone: "Europe/Moscow",
      workingHoursStart: "09:00",
      workingHoursEnd: "18:00",
      autoReplyOutsideHours: true,
      escalationEmail: "",
      escalationTelegram: "",
      allowDiscounts: false,
      maxDiscountPercent: 0,
    },
    values: tenant
      ? {
          name: tenant.name,
          language: tenant.language,
          tone: tenant.tone,
          addressStyle: tenant.addressStyle,
          currency: tenant.currency,
          timezone: tenant.timezone,
          workingHoursStart: tenant.workingHoursStart || "09:00",
          workingHoursEnd: tenant.workingHoursEnd || "18:00",
          autoReplyOutsideHours: tenant.autoReplyOutsideHours ?? true,
          escalationEmail: tenant.escalationEmail || "",
          escalationTelegram: tenant.escalationTelegram || "",
          allowDiscounts: tenant.allowDiscounts ?? false,
          maxDiscountPercent: tenant.maxDiscountPercent || 0,
        }
      : undefined,
  });

  const updateMutation = useMutation({
    mutationFn: async (data: SettingsFormValues) => {
      return apiRequest("PATCH", "/api/tenant", data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tenant"] });
      toast({ title: "Настройки сохранены" });
    },
    onError: () => {
      toast({ title: "Не удалось сохранить настройки", variant: "destructive" });
    },
  });

  const handleSubmit = (data: SettingsFormValues) => {
    updateMutation.mutate(data);
  };

  if (isLoading) {
    return (
      <div className="space-y-6 p-6">
        <Skeleton className="h-10 w-48" />
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-32 w-full" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-3xl font-semibold">Настройки</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Настройка поведения и параметров AI Sales Operator
        </p>
      </div>

      <Tabs defaultValue="business" className="space-y-6">
        <TabsList className="flex-wrap">
          <TabsTrigger value="business" data-testid="tab-business">
            <Building2 className="mr-2 h-4 w-4" />
            Бизнес
          </TabsTrigger>
          <TabsTrigger value="communication" data-testid="tab-communication">
            <MessageSquare className="mr-2 h-4 w-4" />
            Общение
          </TabsTrigger>
          <TabsTrigger value="working-hours" data-testid="tab-working-hours">
            <Clock className="mr-2 h-4 w-4" />
            Рабочие часы
          </TabsTrigger>
          <TabsTrigger value="escalation" data-testid="tab-escalation">
            <Bell className="mr-2 h-4 w-4" />
            Эскалация
          </TabsTrigger>
          <TabsTrigger value="ai-behavior" data-testid="tab-ai-behavior">
            <Bot className="mr-2 h-4 w-4" />
            Поведение AI
          </TabsTrigger>
          <TabsTrigger value="channels" data-testid="tab-channels">
            <Link2 className="mr-2 h-4 w-4" />
            Каналы
          </TabsTrigger>
        </TabsList>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)}>
            <TabsContent value="business">
              <Card>
                <CardHeader>
                  <CardTitle>Профиль бизнеса</CardTitle>
                  <CardDescription>
                    Основная информация о вашем бизнесе
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <FormField
                    control={form.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Название компании</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="Название вашего магазина"
                            {...field}
                            data-testid="input-business-name"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <div className="grid gap-4 sm:grid-cols-2">
                    <FormField
                      control={form.control}
                      name="currency"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Валюта</FormLabel>
                          <Select
                            onValueChange={field.onChange}
                            defaultValue={field.value}
                          >
                            <FormControl>
                              <SelectTrigger data-testid="select-currency">
                                <SelectValue placeholder="Выберите валюту" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="RUB">RUB (Российский рубль)</SelectItem>
                              <SelectItem value="USD">USD (Доллар США)</SelectItem>
                              <SelectItem value="EUR">EUR (Евро)</SelectItem>
                              <SelectItem value="UAH">UAH (Украинская гривна)</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="timezone"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Часовой пояс</FormLabel>
                          <Select
                            onValueChange={field.onChange}
                            defaultValue={field.value}
                          >
                            <FormControl>
                              <SelectTrigger data-testid="select-timezone">
                                <SelectValue placeholder="Выберите часовой пояс" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="Europe/Moscow">Москва</SelectItem>
                              <SelectItem value="Europe/Kiev">Киев</SelectItem>
                              <SelectItem value="Europe/London">Лондон</SelectItem>
                              <SelectItem value="America/New_York">Нью-Йорк</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="communication">
              <Card>
                <CardHeader>
                  <CardTitle>Стиль общения</CardTitle>
                  <CardDescription>
                    Как AI должен общаться с клиентами
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <FormField
                    control={form.control}
                    name="language"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Язык</FormLabel>
                        <Select
                          onValueChange={field.onChange}
                          defaultValue={field.value}
                        >
                          <FormControl>
                            <SelectTrigger data-testid="select-language">
                              <SelectValue placeholder="Выберите язык" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="ru">Русский</SelectItem>
                            <SelectItem value="en">Английский</SelectItem>
                            <SelectItem value="uk">Украинский</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <div className="grid gap-4 sm:grid-cols-2">
                    <FormField
                      control={form.control}
                      name="tone"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Тон общения</FormLabel>
                          <Select
                            onValueChange={field.onChange}
                            defaultValue={field.value}
                          >
                            <FormControl>
                              <SelectTrigger data-testid="select-tone">
                                <SelectValue placeholder="Выберите тон" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="formal">Формальный</SelectItem>
                              <SelectItem value="friendly">Дружеский</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="addressStyle"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Обращение</FormLabel>
                          <Select
                            onValueChange={field.onChange}
                            defaultValue={field.value}
                          >
                            <FormControl>
                              <SelectTrigger data-testid="select-address-style">
                                <SelectValue placeholder="Выберите стиль" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="vy">На Вы</SelectItem>
                              <SelectItem value="ty">На Ты</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="working-hours">
              <Card>
                <CardHeader>
                  <CardTitle>Рабочие часы</CardTitle>
                  <CardDescription>
                    Когда AI должен отвечать автоматически
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <FormField
                      control={form.control}
                      name="workingHoursStart"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Начало работы</FormLabel>
                          <FormControl>
                            <Input
                              type="time"
                              {...field}
                              data-testid="input-working-start"
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="workingHoursEnd"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Конец работы</FormLabel>
                          <FormControl>
                            <Input
                              type="time"
                              {...field}
                              data-testid="input-working-end"
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                  <Separator />
                  <FormField
                    control={form.control}
                    name="autoReplyOutsideHours"
                    render={({ field }) => (
                      <FormItem className="flex items-center justify-between rounded-md border p-4">
                        <div>
                          <FormLabel>Автоответ в нерабочее время</FormLabel>
                          <FormDescription>
                            Отправлять автоматические сообщения вне рабочих часов
                          </FormDescription>
                        </div>
                        <FormControl>
                          <Switch
                            checked={field.value}
                            onCheckedChange={field.onChange}
                            data-testid="switch-auto-reply"
                          />
                        </FormControl>
                      </FormItem>
                    )}
                  />
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="escalation">
              <Card>
                <CardHeader>
                  <CardTitle>Настройки эскалации</CardTitle>
                  <CardDescription>
                    Куда отправлять уведомления об эскалациях
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <FormField
                    control={form.control}
                    name="escalationEmail"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Email для эскалаций</FormLabel>
                        <FormControl>
                          <Input
                            type="email"
                            placeholder="owner@example.com"
                            {...field}
                            data-testid="input-escalation-email"
                          />
                        </FormControl>
                        <FormDescription>
                          Получать email-уведомления об эскалированных разговорах
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="escalationTelegram"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Telegram для эскалаций</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="@username или ID чата"
                            {...field}
                            data-testid="input-escalation-telegram"
                          />
                        </FormControl>
                        <FormDescription>
                          Получать Telegram-уведомления об эскалированных разговорах
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="ai-behavior">
              <div className="space-y-6">
                <Card>
                  <CardHeader>
                    <CardTitle>Поведение AI</CardTitle>
                    <CardDescription>
                      Настройка обработки специальных запросов
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <FormField
                      control={form.control}
                      name="allowDiscounts"
                      render={({ field }) => (
                        <FormItem className="flex items-center justify-between rounded-md border p-4">
                          <div>
                            <FormLabel>Разрешить AI предлагать скидки</FormLabel>
                            <FormDescription>
                              AI сможет предлагать скидки в установленных пределах
                            </FormDescription>
                          </div>
                          <FormControl>
                            <Switch
                              checked={field.value}
                              onCheckedChange={field.onChange}
                              data-testid="switch-allow-discounts"
                            />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                    {form.watch("allowDiscounts") && (
                      <FormField
                        control={form.control}
                        name="maxDiscountPercent"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Максимальная скидка (%)</FormLabel>
                            <FormControl>
                              <Input
                                type="number"
                                min={0}
                                max={100}
                                {...field}
                                data-testid="input-max-discount"
                              />
                            </FormControl>
                            <FormDescription>
                              Максимальный процент скидки, который AI может предложить
                            </FormDescription>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    )}
                  </CardContent>
                </Card>

                {/* Phase 1: Decision Engine Settings */}
                <DecisionEngineSettings />

                {/* Phase 2: Human Delay Settings */}
                <HumanDelaySettings />

                {/* Training Policies */}
                <TrainingPoliciesSettings />
              </div>
            </TabsContent>

            <TabsContent value="channels">
              <ChannelSettings />
            </TabsContent>

            <div className="flex justify-end pt-6">
              <Button
                type="submit"
                disabled={updateMutation.isPending}
                data-testid="button-save-settings"
              >
                <Save className="mr-2 h-4 w-4" />
                Сохранить настройки
              </Button>
            </div>
          </form>
        </Form>
      </Tabs>
    </div>
  );
}

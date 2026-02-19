# Карта точек интеграции — Gearbox OEM by VIN/FRAME + tag verification

Аудит репозитория: где что лежит (без кода, только локализация).

---

## 1) Обработка входящих сообщений каналов

### Telegram Personal
- **`server/routes/telegram-webhook.ts`** — вебхук для **бота** Telegram (TELEGRAM_CHANNEL_ENABLED): проверка подписи, парсинг апдейта через `telegramAdapter.parseIncomingMessage`, аудит, ответ 200. **Не сохраняет в БД и не вызывает AI** (бот-канал).
- **`server/services/telegram-client-manager.ts`** — **личный** канал: при получении сообщения (MTProto) вызывает `processIncomingMessageFull(tenantId, parsed)` (импорт из `inbound-message-handler`). Точка входа в общий пайплайн «сохранить сообщение + запустить AI».

### WhatsApp Personal
- **`server/routes/whatsapp-webhook.ts`** — вебхук для **WhatsApp Business API** (WHATSAPP_CHANNEL_ENABLED): verify challenge, парсинг через `whatsappAdapter.parseIncomingMessage`, аудит, ответ 200. **Не сохраняет в БД и не вызывает AI** (канал API).
- **`server/services/whatsapp-personal-adapter.ts`** — **личный** канал (Baileys): в обработчиках входящих сообщений (и история) вызывается `processIncomingMessageFull(tenantId, parsed)` (импорт из `inbound-message-handler`). Несколько мест вызова (~396, 450, 616, 670). Единая точка входа в пайплайн «сохранить + AI».

### MAX (бот и личный)
- **`server/routes/max-webhook.ts`** — роутер: `POST /` — вебхук для канала **MAX (бот)** (MAX_CHANNEL_ENABLED): проверка секрета, `processInboundMessage("max", payload)` из `channel-adapter`, дедуп по id, аудит, ответ 200. **Не вызывает handleIncomingMessage** — только парсинг, сохранение в БД и AI для MAX бота здесь не делаются.
- **`server/routes.ts`** — `POST /api/max-personal/incoming` — входящие от **MAX Personal** (Python-сервис): проверка `x-internal-secret`, валидация tenant, парсинг через `MaxPersonalAdapter.parseIncomingMessage`, вызов `processIncomingMessageFull(tenant_id, parsed)`. Единая точка входа для личного MAX.

### Общий пайплайн (сохранение + AI)
- **`server/services/inbound-message-handler.ts`**
  - **`handleIncomingMessage(tenantId, parsed)`** — поиск/создание customer по (tenantId, channel, externalUserId), поиск/создание conversation, дедуп сообщений, создание message в БД, обновление unreadCount, broadcast по WebSocket. Возвращает `{ conversationId, messageId, isNew }`.
  - **`processIncomingMessageFull(tenantId, parsed)`** — вызывает `handleIncomingMessage`, затем `triggerAiSuggestion(conversationId)`.
  - **`triggerAiSuggestion(conversationId)`** — загрузка диалога, тенанта, последнего сообщения клиента; RAG (docs + products); память клиента; вызов **Decision Engine** `generateWithDecisionEngine(...)`; создание записи AI suggestion в БД; broadcast новой подсказки; инкремент frequent_topics; при необходимости — генерация саммари; при AUTO_SEND — лог. Точка, где **всегда** вызывается генерация подсказки и классификация интента (внутри Decision Engine).

Итог по п.1: для **Personal**-каналов входящие входят через адаптеры (Telegram/WhatsApp в Node, MAX — через POST `/api/max-personal/incoming`), далее везде сходятся в **`inbound-message-handler.ts`** (`processIncomingMessageFull` → `handleIncomingMessage` + `triggerAiSuggestion`).

---

## 2) AI suggestion generation и intent classification

- **`server/routes.ts`** — `POST /api/conversations/:id/generate-suggestion` — ручной запрос подсказки из UI: загрузка диалога, последнего сообщения клиента, RAG (docs + products), история; вызов **`generateWithDecisionEngine`** из `./services/decision-engine`; сохранение подсказки в БД (включая intent, decision, confidence и т.д.); аудит.
- **`server/services/inbound-message-handler.ts`** — функция **`triggerAiSuggestion(conversationId)`**: вызывается после сохранения входящего сообщения; собирает контекст (conversation, tenant, last customer message, RAG, customerMemory); вызывает **`generateWithDecisionEngine`** из `./services/decision-engine`; создаёт запись в `ai_suggestions` (intent, confidence, decision, explanations, penalties, autosendEligible и т.д.); при необходимости триггерит customer summary.

Генерация текста ответа и классификация интента выполняются **внутри** Decision Engine.

- **`server/services/decision-engine.ts`** — основной сервис: **`generateWithDecisionEngine(context)`** — RAG-контекст, few-shot, промпт, вызов OpenAI (chat completions); парсинг ответа (reply + intent + confidence breakdown + self-check); решение AUTO_SEND / NEED_APPROVAL / ESCALATE по порогам и правилам; тройная блокировка для autosend; возврат `SuggestionResponse` (replyText, intent, confidence, decision, needsApproval, needsHandoff, usedSources, explanations, penalties, autosendEligible, autosendBlockReason, selfCheckNeedHandoff, selfCheckReasons). Intent classification зашита в промпт/парсинг ответа модели здесь же.
- **`server/services/rag-retrieval.ts`** — используется Decision Engine для `retrieveContext`, `formatContextForPrompt` (источники для подсказки).
- **`server/services/few-shot-builder.ts`** — выбор примеров по интенту, сборка блока few-shot для промпта (используется в Decision Engine).

Итог по п.2: вызов генерации подсказки и интента — **`routes.ts`** (ручной generate-suggestion) и **`inbound-message-handler.ts`** (triggerAiSuggestion); логика генерации и интента — **`server/services/decision-engine.ts`**; RAG и few-shot — **`rag-retrieval.ts`**, **`few-shot-builder.ts`**.

---

## 3) Decision Engine (AUTO_SEND / NEED_APPROVAL / ESCALATE), как подключается

- **`server/services/decision-engine.ts`** — единственное место реализации:
  - Пороги `tAuto`, `tEscalate`, настройки `autosendAllowed`, `intentsAutosendAllowed`, `intentsForceHandoff`.
  - Функции принятия решения и проверки autosend eligibility (в т.ч. экспорт для тестов `_testing`).
  - **`generateWithDecisionEngine(context)`** — полный пайплайн: генерация ответа, интент, confidence, self-check, решение (AUTO_SEND / NEED_APPROVAL / ESCALATE), тройная блокировка для autosend.
- Подключение:
  - **`server/services/inbound-message-handler.ts`** — в `triggerAiSuggestion` динамический импорт `generateWithDecisionEngine` и вызов после сохранения входящего сообщения.
  - **`server/routes.ts`** — в обработчике `POST /api/conversations/:id/generate-suggestion` динамический импорт `generateWithDecisionEngine` и вызов.
- Настройки Decision Engine по тенанту хранятся в БД (таблица **decision_settings**), читаются в decision-engine (через storage или передачу контекста). Схема и типы — **`shared/schema.ts`** (decisionSettings, DecisionSettings).
- Feature flags: **`server/services/feature-flags.ts`** — флаги DECISION_ENGINE_ENABLED, AI_AUTOSEND_ENABLED используются в decision-engine для kill-switch и разрешения автоотправки.

Итог по п.3: Decision Engine живёт в **`server/services/decision-engine.ts`**; подключается только из **`inbound-message-handler.ts`** (авто при входящем) и **`routes.ts`** (ручная кнопка generate-suggestion). Настройки — БД (decision_settings) + feature flags.

---

## 4) Conversation / customer metadata: Drizzle schema и сервисы

### Схема (Drizzle)
- **`shared/schema.ts`**:
  - **customers** — id, tenantId, channelId, channel, externalId, name, phone, email, tags, **metadata** (jsonb), createdAt, updatedAt.
  - **conversations** — id, tenantId, customerId, channelId, status, mode, lastMessageAt, unreadCount, createdAt (отдельного поля metadata нет; контекст — связь с customer и messages).
  - **messages** — id, conversationId, role, content, attachments, **metadata** (jsonb), createdAt.
  - **customer_memory** — tenantId, customerId, preferences (jsonb), frequentTopics (jsonb), lastSummaryText, updatedAt.
  - **customer_notes** — заметки оператора по клиенту.
  - Типы/экспорты: Customer, Conversation, Message, ConversationWithCustomer, ConversationDetail и др.

### Хранение и доступ (сервисы)
- **`server/storage.ts`** — интерфейс **IStorage**: методы для tenants, channels, users, customers (getCustomer, getCustomerByExternalId, createCustomer, updateCustomer, getCustomerMemory, …), conversations (getConversation, getConversationWithCustomer, getConversationDetail, getConversationsByTenant, createConversation, updateConversation), messages (createMessage, getMessagesByConversation), и остальные сущности. В конце файла — экспорт синглтона **`storage`**.
- **`server/database-storage.ts`** — класс **DatabaseStorage** реализует IStorage поверх Drizzle/PostgreSQL; используется как реализация: `export const storage = new DatabaseStorage()` в **`server/storage.ts`**.

Итог по п.4: схема сущностей и metadata (customers.metadata, messages.metadata и т.д.) — **`shared/schema.ts`**; API доступа к данным — **`server/storage.ts`** (интерфейс + экспорт storage); реализация — **`server/database-storage.ts`**.

---

## 5) Интеграции / внешние сервисы, как добавлять новый tool/service

### Каналы (адаптеры мессенджеров)
- **`server/services/channel-adapter.ts`**:
  - Интерфейс **ChannelAdapter** (name, sendMessage, parseIncomingMessage, опционально sendTypingStart/Stop, verifyWebhook).
  - **ChannelRegistry** — регистрация адаптеров по имени канала; **CHANNEL_FLAG_MAP** — привязка типа канала к feature flag.
  - **processInboundMessage(channelType, rawPayload, tenantId?)** — получение адаптера по channelType, парсинг, возврат ParsedIncomingMessage (используется вебхуком MAX бота; для Personal каналов не используется как точка сохранения — они идут через processIncomingMessageFull).
  - **processOutboundMessage(...)** — отправка через адаптер (sendMessage, опционально typing).
  - В конце файла регистрируются адаптеры: MockChannelAdapter, TelegramAdapter, whatsappAdapter, MaxAdapter, **WhatsAppPersonalAdapter**. **Telegram Personal** не регистрируется как ChannelAdapter в registry (он работает через telegram-client-manager и напрямую вызывает processIncomingMessageFull). **MAX Personal** вызывается из routes и max-personal-adapter по tenantId, а не через registry по channelType для входящих.
- Добавление нового канала: реализовать класс с интерфейсом **ChannelAdapter**; при необходимости добавить тип в **shared/schema.ts** (CHANNEL_TYPES) и флаг в **feature-flags** и CHANNEL_FLAG_MAP; зарегистрировать в **channel-adapter.ts**; для входящих либо вебхук → processInboundMessage + вызов handleIncomingMessage/processIncomingMessageFull, либо свой менеджер (как Telegram/WhatsApp Personal) с вызовом **processIncomingMessageFull**.

### Внешние HTTP-сервисы (пример — MAX Personal Python)
- **`server/services/max-personal-adapter.ts`** — клиент к Python-сервису: **MAX_SERVICE_URL** (по умолчанию `http://localhost:8100`); методы вызывают `fetch(MAX_SERVICE_URL/start-auth|check-auth|send-message|logout|status|...)`. Добавление нового внешнего сервиса по аналогии: свой адаптер/клиент с base URL из env и вызовами fetch; при необходимости новый роут в **routes.ts** (например внутренний endpoint для входящих от этого сервиса).

### Feature flags для каналов и AI
- **`server/services/feature-flags.ts`** — конфиг флагов (в т.ч. TELEGRAM_PERSONAL_CHANNEL_ENABLED, WHATSAPP_PERSONAL_CHANNEL_ENABLED, MAX_PERSONAL_CHANNEL_ENABLED, DECISION_ENGINE_ENABLED, AI_AUTOSEND_ENABLED и др.); при добавлении нового канала/поведения — добавить флаг и учесть в CHANNEL_FLAG_MAP или в логике Decision Engine.

Итог по п.5: каналы и их контракт — **`server/services/channel-adapter.ts`** (интерфейс + registry + processInbound/Outbound); новый канал — новый адаптер, регистрация, при необходимости новый тип в schema и feature flag; внешние HTTP-сервисы — отдельные адаптеры/клиенты (как **max-personal-adapter.ts**) и при необходимости роуты в **routes.ts**.

---

## 6) MAX Python Playwright сервис (FastAPI), как Node его вызывает

### Где лежит Python-сервис
- **`max_personal_service.py`** (корень репозитория) — FastAPI-приложение: SESSIONS_DIR, NODE_BACKEND_URL (env, по умолчанию `http://localhost:5000`), INTERNAL_SECRET (MAX_INTERNAL_SECRET или SESSION_SECRET); эндпоинты start-auth, send-message, check-status, logout и др.; при входящем сообщении из Max вызывается **forward_message_to_node** — POST на **`{NODE_BACKEND_URL}/api/max-personal/incoming`** с телом `{ tenant_id, message }` и заголовком (в коде Python передаётся секрет для проверки на Node). Запуск: uvicorn (порт 8100 по умолчанию).

### Как Node запускает и вызывает Python
- **`server/index.ts`** — функция **startMaxPersonalService()**: проверка наличия `./max_personal_service.py`, spawn `python3` с этим скриптом, в env передаётся **NODE_BACKEND_URL: `http://localhost:${PORT || 5000}`**. При старте сервера Node при необходимости запускает Python-процесс; общение обратное — Python шлёт входящие сообщения на Node.
- **`server/routes.ts`** — **POST /api/max-personal/incoming** — принимает запросы от Python: проверка заголовка **x-internal-secret** (ожидается MAX_INTERNAL_SECRET или SESSION_SECRET); валидация tenant_id и наличия активной сессии MAX Personal; **MaxPersonalAdapter.parseIncomingMessage(message)**; **processIncomingMessageFull(tenant_id, parsed)**.
- **`server/services/max-personal-adapter.ts`** — Node как **клиент** Python: **MAX_SERVICE_URL** = `process.env.MAX_SERVICE_URL || "http://localhost:8100"`; вызовы **fetch(MAX_SERVICE_URL/start-auth|send-message|check-auth|logout|status|...)** для авторизации, отправки сообщений, статуса. Исходящие из Node в MAX идут через этот адаптер; входящие из MAX в Node идут с Python на **/api/max-personal/incoming**.

Итог по п.6: Python-сервис — **`max_personal_service.py`** (корень); Node запускает его из **`server/index.ts`** (startMaxPersonalService), передаёт NODE_BACKEND_URL; Node принимает входящие от Python в **`server/routes.ts`** (POST /api/max-personal/incoming); Node вызывает Python по HTTP в **`server/services/max-personal-adapter.ts`** (MAX_SERVICE_URL, fetch к эндпоинтам FastAPI).
ё
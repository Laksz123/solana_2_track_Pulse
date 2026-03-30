// ==================== TELEGRAM COMMAND BOT ====================
// Interactive Telegram bot for controlling the trading engine
// Commands: /start, /status, /trade, /mode, /balance, /positions, /pnl, /help

import { CONFIG, log } from "./config";

// ==================== TYPES ====================

export interface BotControl {
  tradingEnabled: boolean;
  strategy: number;           // 0=Conservative, 1=Moderate, 2=Aggressive
  onStrategyChange?: (strategy: number) => void;
  onTradingToggle?: (enabled: boolean) => void;
  getState: () => {
    cashUSD: number;
    positions: { symbol: string; coinId: string; amount: number; avgBuyPrice: number; currentPrice: number; unrealizedPnL: number; unrealizedPnLPct: number }[];
    trades: { timestamp: number; action: string; symbol: string; amountUSD: number; price: number; confidence: number; reasoning: string }[];
    closedTrades: { symbol: string; buyPrice: number; sellPrice: number; units: number; pnlUSD: number; returnPct: number }[];
    peakEquity: number;
    cycleCount: number;
    startedAt: string;
    lastRunAt: string;
  };
}

const STRATEGY_NAMES = ["🛡 Conservative", "⚖️ Moderate", "🔥 Aggressive"];
const STRATEGY_EMOJI = ["🛡", "⚖️", "🔥"];

const TG_API = "https://api.telegram.org/bot";

// ==================== TELEGRAM API HELPERS ====================

async function tgRequest(method: string, params: Record<string, any> = {}): Promise<any> {
  const token = CONFIG.telegramBotToken;
  if (!token) return null;

  try {
    const resp = await fetch(`${TG_API}${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    const data = await resp.json() as any;
    if (!data.ok) {
      log.error(`Telegram API error [${method}]:`, data.description);
    }
    return data;
  } catch (err) {
    log.error(`Telegram fetch error [${method}]:`, err);
    return null;
  }
}

async function sendMessage(chatId: string | number, text: string, replyMarkup?: any): Promise<void> {
  await tgRequest("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

async function answerCallback(callbackId: string, text?: string): Promise<void> {
  await tgRequest("answerCallbackQuery", {
    callback_query_id: callbackId,
    text: text || "",
  });
}

// ==================== COMMAND HANDLERS ====================

function handleStart(chatId: string | number, control: BotControl): void {
  const msg = `🤖 <b>AI Asset Manager Bot</b>

Привет! Я управляю 24/7 трейдинг ботом.

<b>Команды:</b>
/status — Статус бота и портфеля
/trade — Вкл/Выкл торговлю
/mode — Выбрать режим (стратегию)
/balance — Баланс портфеля
/positions — Открытые позиции
/pnl — P&L отчёт
/trades — Последние сделки
/app — Открыть приложение
/help — Помощь

<b>Текущий режим:</b> ${STRATEGY_NAMES[control.strategy]}
<b>Торговля:</b> ${control.tradingEnabled ? "✅ Активна" : "⏸ Остановлена"}`;

  // Add Web App button if URL is configured
  const keyboard: any = { inline_keyboard: [] };
  if (CONFIG.webAppUrl) {
    keyboard.inline_keyboard.push([
      { text: "📱 Открыть приложение", web_app: { url: CONFIG.webAppUrl } },
    ]);
  }
  keyboard.inline_keyboard.push([
    { text: "📊 Статус", callback_data: "cmd_status" },
    { text: "⚡ Торговля", callback_data: "cmd_trade" },
    { text: "🎯 Режим", callback_data: "cmd_mode" },
  ]);

  sendMessage(chatId, msg, keyboard);
}

function handleApp(chatId: string | number): void {
  if (!CONFIG.webAppUrl) {
    sendMessage(chatId, `⚠️ <b>Web App URL не настроен</b>\n\nДобавьте WEB_APP_URL в .env файл бота.\nПример: WEB_APP_URL=https://your-app.vercel.app`);
    return;
  }

  const keyboard = {
    inline_keyboard: [
      [{ text: "📱 Открыть AI Asset Manager", web_app: { url: CONFIG.webAppUrl } }],
      [{ text: "🌐 Открыть в браузере", url: CONFIG.webAppUrl }],
    ],
  };

  sendMessage(chatId, `📱 <b>AI Asset Manager</b>\n\nОткройте приложение для полного управления:\n• Портфель и балансы\n• Торговые графики\n• ML анализ\n• Подключение кошелька\n• Бэктестинг`, keyboard);
}

function handleStatus(chatId: string | number, control: BotControl): void {
  const state = control.getState();
  const totalEquity = state.cashUSD + state.positions.reduce((s, p) => s + p.amount * p.currentPrice, 0);
  const totalPnL = totalEquity - (CONFIG.initialCapital || 10000);
  const totalPnLPct = CONFIG.initialCapital > 0 ? (totalPnL / CONFIG.initialCapital) * 100 : 0;
  const drawdown = state.peakEquity > 0 ? ((state.peakEquity - totalEquity) / state.peakEquity) * 100 : 0;

  const uptime = state.startedAt ? getUptime(state.startedAt) : "N/A";

  const msg = `📊 <b>Статус бота</b>

💰 <b>Портфель:</b> $${totalEquity.toFixed(2)}
💵 <b>Кеш:</b> $${state.cashUSD.toFixed(2)}
📈 <b>P&L:</b> ${totalPnL >= 0 ? "+" : ""}$${totalPnL.toFixed(2)} (${totalPnLPct >= 0 ? "+" : ""}${totalPnLPct.toFixed(1)}%)
📉 <b>Макс. просадка:</b> ${drawdown.toFixed(1)}%
📊 <b>Позиций:</b> ${state.positions.length}
🔄 <b>Циклов:</b> ${state.cycleCount}
⏱ <b>Аптайм:</b> ${uptime}

${STRATEGY_EMOJI[control.strategy]} <b>Режим:</b> ${STRATEGY_NAMES[control.strategy]}
${control.tradingEnabled ? "✅ Торговля активна" : "⏸ Торговля остановлена"}`;

  sendMessage(chatId, msg);
}

function handleTrade(chatId: string | number, control: BotControl): void {
  const keyboard = {
    inline_keyboard: [
      [
        { text: "▶️ Включить", callback_data: "trade_on" },
        { text: "⏸ Остановить", callback_data: "trade_off" },
      ],
    ],
  };

  const msg = `⚡ <b>Управление торговлей</b>

Текущий статус: ${control.tradingEnabled ? "✅ Активна" : "⏸ Остановлена"}

Выберите действие:`;

  sendMessage(chatId, msg, keyboard);
}

function handleMode(chatId: string | number, control: BotControl): void {
  const keyboard = {
    inline_keyboard: [
      [{ text: `${control.strategy === 0 ? "✅ " : ""}🛡 Conservative`, callback_data: "mode_0" }],
      [{ text: `${control.strategy === 1 ? "✅ " : ""}⚖️ Moderate`, callback_data: "mode_1" }],
      [{ text: `${control.strategy === 2 ? "✅ " : ""}🔥 Aggressive`, callback_data: "mode_2" }],
    ],
  };

  const riskInfo = [
    "Макс. позиция: 20% | Stop: 5% | TP: 8%",
    "Макс. позиция: 30% | Stop: 8% | TP: 15%",
    "Макс. позиция: 40% | Stop: 12% | TP: 25%",
  ];

  const msg = `🎯 <b>Выбор режима торговли</b>

Текущий: ${STRATEGY_NAMES[control.strategy]}
${riskInfo[control.strategy]}

Выберите стратегию:`;

  sendMessage(chatId, msg, keyboard);
}

function handleBalance(chatId: string | number, control: BotControl): void {
  const state = control.getState();
  const totalEquity = state.cashUSD + state.positions.reduce((s, p) => s + p.amount * p.currentPrice, 0);
  const posValue = state.positions.reduce((s, p) => s + p.amount * p.currentPrice, 0);

  const cashPct = totalEquity > 0 ? (state.cashUSD / totalEquity * 100) : 100;
  const posPct = totalEquity > 0 ? (posValue / totalEquity * 100) : 0;

  const bar = (pct: number) => {
    const filled = Math.round(pct / 5);
    return "█".repeat(filled) + "░".repeat(20 - filled);
  };

  const msg = `💰 <b>Баланс</b>

<b>Всего:</b> $${totalEquity.toFixed(2)}

💵 Кеш: $${state.cashUSD.toFixed(2)} (${cashPct.toFixed(0)}%)
${bar(cashPct)}

📊 Позиции: $${posValue.toFixed(2)} (${posPct.toFixed(0)}%)
${bar(posPct)}`;

  sendMessage(chatId, msg);
}

function handlePositions(chatId: string | number, control: BotControl): void {
  const state = control.getState();

  if (state.positions.length === 0) {
    sendMessage(chatId, "📭 <b>Нет открытых позиций</b>\n\nКеш: $" + state.cashUSD.toFixed(2));
    return;
  }

  let msg = "📊 <b>Открытые позиции</b>\n\n";

  for (const p of state.positions) {
    const value = p.amount * p.currentPrice;
    const pnlEmoji = p.unrealizedPnL >= 0 ? "🟢" : "🔴";
    msg += `${pnlEmoji} <b>${p.symbol}</b>
   Кол-во: ${p.amount.toFixed(6)}
   Ср. цена: $${p.avgBuyPrice.toFixed(2)}
   Текущая: $${p.currentPrice.toFixed(2)}
   Стоимость: $${value.toFixed(2)}
   P&L: ${p.unrealizedPnL >= 0 ? "+" : ""}$${p.unrealizedPnL.toFixed(2)} (${p.unrealizedPnLPct >= 0 ? "+" : ""}${p.unrealizedPnLPct.toFixed(1)}%)
\n`;
  }

  sendMessage(chatId, msg);
}

function handlePnL(chatId: string | number, control: BotControl): void {
  const state = control.getState();
  const totalEquity = state.cashUSD + state.positions.reduce((s, p) => s + p.amount * p.currentPrice, 0);
  const realizedPnL = state.closedTrades.reduce((s, t) => s + t.pnlUSD, 0);
  const unrealizedPnL = state.positions.reduce((s, p) => s + p.unrealizedPnL, 0);
  const totalPnL = realizedPnL + unrealizedPnL;
  const winners = state.closedTrades.filter((t) => t.pnlUSD > 0);
  const losers = state.closedTrades.filter((t) => t.pnlUSD < 0);
  const winRate = state.closedTrades.length > 0 ? (winners.length / state.closedTrades.length * 100) : 0;
  const avgWin = winners.length > 0 ? winners.reduce((s, t) => s + t.pnlUSD, 0) / winners.length : 0;
  const avgLoss = losers.length > 0 ? losers.reduce((s, t) => s + t.pnlUSD, 0) / losers.length : 0;

  const msg = `📈 <b>P&L отчёт</b>

💰 <b>Equity:</b> $${totalEquity.toFixed(2)}
📊 <b>Total P&L:</b> ${totalPnL >= 0 ? "+" : ""}$${totalPnL.toFixed(2)}

✅ <b>Realized:</b> ${realizedPnL >= 0 ? "+" : ""}$${realizedPnL.toFixed(2)}
⏳ <b>Unrealized:</b> ${unrealizedPnL >= 0 ? "+" : ""}$${unrealizedPnL.toFixed(2)}

📊 <b>Сделок:</b> ${state.closedTrades.length}
🏆 <b>Win Rate:</b> ${winRate.toFixed(0)}%
✅ <b>Побед:</b> ${winners.length} (avg +$${avgWin.toFixed(2)})
❌ <b>Потерь:</b> ${losers.length} (avg $${avgLoss.toFixed(2)})`;

  sendMessage(chatId, msg);
}

function handleTrades(chatId: string | number, control: BotControl): void {
  const state = control.getState();
  const recent = state.trades.slice(-10).reverse();

  if (recent.length === 0) {
    sendMessage(chatId, "📭 <b>Нет сделок</b>");
    return;
  }

  let msg = "📝 <b>Последние сделки</b>\n\n";

  for (const t of recent) {
    const emoji = t.action === "BUY" ? "🟢" : t.action === "SELL" ? "🔴" : "⚪";
    const date = new Date(t.timestamp * 1000);
    const time = date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    msg += `${emoji} <b>${t.action} ${t.symbol}</b> ${time}
   $${t.amountUSD.toFixed(2)} @ $${t.price.toFixed(2)} (${(t.confidence * 100).toFixed(0)}%)
\n`;
  }

  sendMessage(chatId, msg);
}

function handleHelp(chatId: string | number): void {
  const msg = `📖 <b>Справка</b>

<b>Основные команды:</b>
/start — Приветствие
/status — Полный статус бота
/trade — Включить/выключить торговлю
/mode — Выбрать стратегию

<b>Портфель:</b>
/balance — Баланс (кеш + позиции)
/positions — Открытые позиции
/pnl — P&L отчёт
/trades — Последние сделки

<b>Стратегии:</b>
🛡 Conservative — низкий риск, до 20% на позицию
⚖️ Moderate — средний риск, до 30%
🔥 Aggressive — высокий риск, до 40%

Бот анализирует рынок каждые ${CONFIG.tradeIntervalSec}с используя 9 TA индикаторов + ML ensemble из 4 моделей.`;

  sendMessage(chatId, msg);
}

// ==================== CALLBACK HANDLER ====================

function handleCallback(
  callbackId: string,
  chatId: string | number,
  data: string,
  control: BotControl,
): void {
  if (data === "trade_on") {
    control.tradingEnabled = true;
    if (control.onTradingToggle) control.onTradingToggle(true);
    answerCallback(callbackId, "✅ Торговля включена");
    sendMessage(chatId, "✅ <b>Торговля включена!</b>\n\nБот начнёт торговать в следующем цикле.");
  } else if (data === "trade_off") {
    control.tradingEnabled = false;
    if (control.onTradingToggle) control.onTradingToggle(false);
    answerCallback(callbackId, "⏸ Торговля остановлена");
    sendMessage(chatId, "⏸ <b>Торговля остановлена</b>\n\nБот продолжит мониторинг, но не будет совершать сделки.");
  } else if (data.startsWith("mode_")) {
    const newStrategy = parseInt(data.replace("mode_", ""), 10);
    if (newStrategy >= 0 && newStrategy <= 2) {
      control.strategy = newStrategy;
      if (control.onStrategyChange) control.onStrategyChange(newStrategy);
      answerCallback(callbackId, `${STRATEGY_NAMES[newStrategy]} выбран`);
      sendMessage(chatId, `${STRATEGY_EMOJI[newStrategy]} <b>Режим изменён: ${STRATEGY_NAMES[newStrategy]}</b>\n\nНовая стратегия применится в следующем цикле.`);
    }
  }
}

// ==================== UPTIME HELPER ====================

function getUptime(startedAt: string): string {
  const start = new Date(startedAt).getTime();
  const now = Date.now();
  const diff = Math.floor((now - start) / 1000);

  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  const mins = Math.floor((diff % 3600) / 60);

  if (days > 0) return `${days}д ${hours}ч ${mins}м`;
  if (hours > 0) return `${hours}ч ${mins}м`;
  return `${mins}м`;
}

// ==================== POLLING LOOP ====================

export class TelegramCommandBot {
  private control: BotControl;
  private lastUpdateId = 0;
  private running = false;
  private pollInterval = 2000; // 2 seconds

  constructor(control: BotControl) {
    this.control = control;
  }

  async start(): Promise<void> {
    if (!CONFIG.telegramBotToken) {
      log.warn("Telegram bot token not set — command bot disabled");
      return;
    }

    this.running = true;
    log.info("Telegram command bot started — polling for commands...");

    // Set bot commands menu
    await tgRequest("setMyCommands", {
      commands: [
        { command: "start", description: "🤖 Запуск бота" },
        { command: "app", description: "📱 Открыть приложение" },
        { command: "status", description: "📊 Статус бота" },
        { command: "trade", description: "⚡ Вкл/Выкл торговлю" },
        { command: "mode", description: "🎯 Выбрать режим" },
        { command: "balance", description: "💰 Баланс" },
        { command: "positions", description: "📊 Позиции" },
        { command: "pnl", description: "📈 P&L отчёт" },
        { command: "trades", description: "📝 Последние сделки" },
        { command: "help", description: "📖 Справка" },
      ],
    });

    // Set menu button to Web App if URL configured
    if (CONFIG.webAppUrl) {
      await tgRequest("setChatMenuButton", {
        menu_button: {
          type: "web_app",
          text: "📱 App",
          web_app: { url: CONFIG.webAppUrl },
        },
      });
      log.info(`Telegram Menu Button set to: ${CONFIG.webAppUrl}`);
    }

    // Polling loop
    while (this.running) {
      try {
        await this.pollUpdates();
      } catch (err) {
        log.error("Telegram polling error:", err);
      }
      await new Promise((r) => setTimeout(r, this.pollInterval));
    }
  }

  stop(): void {
    this.running = false;
    log.info("Telegram command bot stopped");
  }

  private async pollUpdates(): Promise<void> {
    const data = await tgRequest("getUpdates", {
      offset: this.lastUpdateId + 1,
      timeout: 1,
      allowed_updates: ["message", "callback_query"],
    });

    if (!data?.result) return;

    for (const update of data.result) {
      this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);

      // Handle callback queries (inline buttons)
      if (update.callback_query) {
        const cb = update.callback_query;
        const chatId = cb.message?.chat?.id;
        if (chatId && this.isAuthorized(chatId)) {
          // Handle quick command callbacks from /start buttons
          if (cb.data === "cmd_status") {
            answerCallback(cb.id); handleStatus(chatId, this.control);
          } else if (cb.data === "cmd_trade") {
            answerCallback(cb.id); handleTrade(chatId, this.control);
          } else if (cb.data === "cmd_mode") {
            answerCallback(cb.id); handleMode(chatId, this.control);
          } else {
            handleCallback(cb.id, chatId, cb.data, this.control);
          }
        }
        continue;
      }

      // Handle text messages
      const msg = update.message;
      if (!msg?.text || !msg.chat?.id) continue;

      const chatId = msg.chat.id;

      // Authorization check
      if (!this.isAuthorized(chatId)) {
        sendMessage(chatId, "⛔ Доступ запрещён. Ваш Chat ID: <code>" + chatId + "</code>");
        log.warn("Unauthorized access attempt from chat:", chatId);
        continue;
      }

      const text = msg.text.trim().toLowerCase();
      const command = text.split(" ")[0].split("@")[0]; // handle /command@botname

      switch (command) {
        case "/start": handleStart(chatId, this.control); break;
        case "/status": handleStatus(chatId, this.control); break;
        case "/trade": handleTrade(chatId, this.control); break;
        case "/mode": handleMode(chatId, this.control); break;
        case "/balance": handleBalance(chatId, this.control); break;
        case "/positions": handlePositions(chatId, this.control); break;
        case "/pnl": handlePnL(chatId, this.control); break;
        case "/trades": handleTrades(chatId, this.control); break;
        case "/app": handleApp(chatId); break;
        case "/help": handleHelp(chatId); break;
        default:
          if (text.startsWith("/")) {
            sendMessage(chatId, "❓ Неизвестная команда. Используй /help для списка команд.");
          }
      }
    }
  }

  private isAuthorized(chatId: number | string): boolean {
    // If TELEGRAM_CHAT_ID is set, only that chat is allowed
    if (CONFIG.telegramChatId) {
      return String(chatId) === String(CONFIG.telegramChatId);
    }
    // If no chat ID is configured, allow anyone (first user)
    return true;
  }
}

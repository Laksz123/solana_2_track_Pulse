// ==================== TELEGRAM BOT INTEGRATION ====================
// Sends trade alerts and P&L reports to Telegram via Bot API
// Uses browser-side fetch — no server required

// ==================== TYPES ====================

export interface TelegramSettings {
  enabled: boolean;
  botToken: string;       // from @BotFather
  chatId: string;         // user or group chat ID
  sendTradeAlerts: boolean;
  sendPnLReports: boolean;
  reportIntervalMin: number; // minutes between P&L reports (0 = off)
}

export const DEFAULT_TELEGRAM_SETTINGS: TelegramSettings = {
  enabled: false,
  botToken: "",
  chatId: "",
  sendTradeAlerts: true,
  sendPnLReports: true,
  reportIntervalMin: 60,
};

interface TradeAlert {
  action: "BUY" | "SELL" | "HOLD";
  symbol: string;
  amountUSD: number;
  price: number;
  confidence: number;
  reasoning: string;
  swapMode: "real" | "simulated";
}

interface PnLReport {
  totalPnLUSD: number;
  totalPnLPct: number;
  realizedPnLUSD: number;
  unrealizedPnLUSD: number;
  winRate: number;
  totalTrades: number;
  maxDrawdown: number;
  sharpeRatio: number;
  profitFactor: number;
  totalEquity: number;
  positions: { symbol: string; pnlPct: number; amountUSD: number }[];
}

// ==================== TELEGRAM API ====================

const TG_API = "https://api.telegram.org/bot";

async function sendMessage(
  botToken: string,
  chatId: string,
  text: string,
  parseMode: "HTML" | "Markdown" = "HTML",
): Promise<boolean> {
  if (!botToken || !chatId) return false;

  try {
    const url = `${TG_API}${botToken}/sendMessage`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: true,
      }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      console.error("Telegram sendMessage error:", resp.status, err);
      return false;
    }
    return true;
  } catch (err) {
    console.error("Telegram sendMessage error:", err);
    return false;
  }
}

// ==================== TEST CONNECTION ====================

export async function testTelegramConnection(
  botToken: string,
  chatId: string,
): Promise<{ success: boolean; error?: string }> {
  if (!botToken || !chatId) {
    return { success: false, error: "Bot token and chat ID required" };
  }

  const text = "✅ <b>AI Asset Manager</b> connected!\n\nTrade alerts will be sent here.";
  const ok = await sendMessage(botToken, chatId, text);
  if (ok) return { success: true };
  return { success: false, error: "Failed to send message. Check bot token and chat ID." };
}

// ==================== TRADE ALERT ====================

export async function sendTradeAlert(
  settings: TelegramSettings,
  alert: TradeAlert,
): Promise<boolean> {
  if (!settings.enabled || !settings.sendTradeAlerts) return false;

  const emoji = alert.action === "BUY" ? "🟢" : alert.action === "SELL" ? "🔴" : "⚪️";
  const modeTag = alert.swapMode === "real" ? "🔴 LIVE" : "🟡 SIM";
  const confBar = "█".repeat(Math.round(alert.confidence * 10)) + "░".repeat(10 - Math.round(alert.confidence * 10));

  const text = [
    `${emoji} <b>${alert.action} ${alert.symbol}</b>`,
    ``,
    `💰 Amount: <code>$${formatNum(alert.amountUSD)}</code>`,
    `📊 Price: <code>$${formatNum(alert.price)}</code>`,
    `🎯 Confidence: <code>${(alert.confidence * 100).toFixed(0)}%</code> [${confBar}]`,
    `⚙️ Mode: ${modeTag}`,
    ``,
    `📝 ${escapeHtml(alert.reasoning.slice(0, 200))}`,
    ``,
    `<i>AI Asset Manager • ${new Date().toLocaleTimeString()}</i>`,
  ].join("\n");

  return sendMessage(settings.botToken, settings.chatId, text);
}

// ==================== P&L REPORT ====================

export async function sendPnLReport(
  settings: TelegramSettings,
  report: PnLReport,
): Promise<boolean> {
  if (!settings.enabled || !settings.sendPnLReports) return false;

  const pnlEmoji = report.totalPnLUSD >= 0 ? "📈" : "📉";
  const pnlSign = report.totalPnLUSD >= 0 ? "+" : "";

  const posLines = report.positions
    .filter((p) => p.amountUSD > 0.01)
    .map((p) => {
      const sign = p.pnlPct >= 0 ? "+" : "";
      return `  • ${p.symbol}: $${formatNum(p.amountUSD)} (${sign}${p.pnlPct.toFixed(1)}%)`;
    })
    .join("\n");

  const text = [
    `${pnlEmoji} <b>P&L Report</b>`,
    ``,
    `💰 Total P&L: <code>${pnlSign}$${formatNum(Math.abs(report.totalPnLUSD))}</code> (${pnlSign}${report.totalPnLPct.toFixed(2)}%)`,
    `✅ Realized: <code>${report.realizedPnLUSD >= 0 ? "+" : ""}$${formatNum(Math.abs(report.realizedPnLUSD))}</code>`,
    `⏳ Unrealized: <code>${report.unrealizedPnLUSD >= 0 ? "+" : ""}$${formatNum(Math.abs(report.unrealizedPnLUSD))}</code>`,
    ``,
    `📊 Stats:`,
    `  Win Rate: ${report.winRate.toFixed(0)}% (${report.totalTrades} trades)`,
    `  Sharpe: ${report.sharpeRatio.toFixed(2)}`,
    `  Profit Factor: ${report.profitFactor === Infinity ? "∞" : report.profitFactor.toFixed(2)}`,
    `  Max DD: -${report.maxDrawdown.toFixed(1)}%`,
    ``,
    `💼 Equity: <code>$${formatNum(report.totalEquity)}</code>`,
    posLines ? `\n📦 Positions:\n${posLines}` : "",
    ``,
    `<i>AI Asset Manager • ${new Date().toLocaleString()}</i>`,
  ].filter(Boolean).join("\n");

  return sendMessage(settings.botToken, settings.chatId, text);
}

// ==================== HELPERS ====================

function formatNum(v: number): string {
  if (v >= 1000) return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (v >= 1) return v.toFixed(2);
  if (v >= 0.01) return v.toFixed(4);
  return v.toFixed(6);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

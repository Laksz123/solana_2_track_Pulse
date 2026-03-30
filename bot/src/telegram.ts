// ==================== TELEGRAM NOTIFICATIONS (BOT) ====================

import { CONFIG, log } from "./config";

const TG_API = "https://api.telegram.org/bot";

async function sendMessage(text: string): Promise<boolean> {
  if (!CONFIG.telegramEnabled || !CONFIG.telegramBotToken || !CONFIG.telegramChatId) return false;

  try {
    const url = `${TG_API}${CONFIG.telegramBotToken}/sendMessage`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CONFIG.telegramChatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });

    if (!resp.ok) {
      log.error("Telegram error:", resp.status);
      return false;
    }
    return true;
  } catch (err) {
    log.error("Telegram send error:", err);
    return false;
  }
}

function fmtNum(v: number): string {
  if (v >= 1000) return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (v >= 1) return v.toFixed(2);
  if (v >= 0.01) return v.toFixed(4);
  return v.toFixed(6);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function sendTradeAlert(
  action: "BUY" | "SELL" | "HOLD",
  symbol: string,
  amountUSD: number,
  price: number,
  confidence: number,
  reasoning: string,
): Promise<boolean> {
  const emoji = action === "BUY" ? "🟢" : action === "SELL" ? "🔴" : "⚪️";
  const modeTag = CONFIG.enableRealSwaps ? "🔴 LIVE" : "🟡 SIM";
  const confBar = "█".repeat(Math.round(confidence * 10)) + "░".repeat(10 - Math.round(confidence * 10));

  const text = [
    `${emoji} <b>${action} ${symbol}</b>`,
    ``,
    `💰 Amount: <code>$${fmtNum(amountUSD)}</code>`,
    `📊 Price: <code>$${fmtNum(price)}</code>`,
    `🎯 Confidence: <code>${(confidence * 100).toFixed(0)}%</code> [${confBar}]`,
    `⚙️ Mode: ${modeTag}`,
    ``,
    `📝 ${escapeHtml(reasoning.slice(0, 200))}`,
    ``,
    `<i>🤖 AI Bot • ${new Date().toLocaleTimeString()}</i>`,
  ].join("\n");

  return sendMessage(text);
}

export interface PnLSummary {
  totalPnLUSD: number;
  totalPnLPct: number;
  realizedPnLUSD: number;
  unrealizedPnLUSD: number;
  totalTrades: number;
  winRate: number;
  totalEquity: number;
  positions: { symbol: string; amountUSD: number; pnlPct: number }[];
}

export async function sendPnLReport(report: PnLSummary): Promise<boolean> {
  const pnlEmoji = report.totalPnLUSD >= 0 ? "📈" : "📉";
  const sign = report.totalPnLUSD >= 0 ? "+" : "";

  const posLines = report.positions
    .filter((p) => p.amountUSD > 0.01)
    .map((p) => `  • ${p.symbol}: $${fmtNum(p.amountUSD)} (${p.pnlPct >= 0 ? "+" : ""}${p.pnlPct.toFixed(1)}%)`)
    .join("\n");

  const text = [
    `${pnlEmoji} <b>P&L Report (Bot)</b>`,
    ``,
    `💰 Total P&L: <code>${sign}$${fmtNum(Math.abs(report.totalPnLUSD))}</code> (${sign}${report.totalPnLPct.toFixed(2)}%)`,
    `✅ Realized: <code>${report.realizedPnLUSD >= 0 ? "+" : ""}$${fmtNum(Math.abs(report.realizedPnLUSD))}</code>`,
    `⏳ Unrealized: <code>${report.unrealizedPnLUSD >= 0 ? "+" : ""}$${fmtNum(Math.abs(report.unrealizedPnLUSD))}</code>`,
    ``,
    `📊 Win Rate: ${report.winRate.toFixed(0)}% (${report.totalTrades} trades)`,
    `💼 Equity: <code>$${fmtNum(report.totalEquity)}</code>`,
    posLines ? `\n📦 Positions:\n${posLines}` : "",
    ``,
    `<i>🤖 AI Bot • ${new Date().toLocaleString()}</i>`,
  ].filter(Boolean).join("\n");

  return sendMessage(text);
}

export async function sendBotStarted(): Promise<boolean> {
  const profile = CONFIG.strategy === 0 ? "Conservative" : CONFIG.strategy === 1 ? "Moderate" : "Aggressive";
  const text = [
    `🚀 <b>AI Trading Bot Started</b>`,
    ``,
    `📋 Strategy: ${profile}`,
    `💰 Capital: $${fmtNum(CONFIG.initialCapital)}`,
    `⏱ Interval: ${CONFIG.tradeIntervalSec}s`,
    `🪙 Coins: ${CONFIG.coins.join(", ")}`,
    `⚙️ Mode: ${CONFIG.enableRealSwaps ? "🔴 LIVE SWAPS" : "🟡 SIMULATION"}`,
    ``,
    `<i>🤖 AI Bot • ${new Date().toLocaleString()}</i>`,
  ].join("\n");

  return sendMessage(text);
}

export async function sendBotError(error: string): Promise<boolean> {
  return sendMessage(`⚠️ <b>Bot Error</b>\n\n<code>${escapeHtml(error.slice(0, 500))}</code>\n\n<i>🤖 AI Bot • ${new Date().toLocaleTimeString()}</i>`);
}

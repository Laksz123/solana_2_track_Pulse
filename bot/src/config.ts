// ==================== BOT CONFIGURATION ====================

import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

function envStr(key: string, fallback: string = ""): string {
  return process.env[key] || fallback;
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  return v ? parseInt(v, 10) : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key]?.toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return fallback;
}

export const CONFIG = {
  // Solana
  keypairPath: envStr("SOLANA_KEYPAIR_PATH", "./wallet.json"),
  privateKey: envStr("SOLANA_PRIVATE_KEY"),
  rpcUrl: envStr("SOLANA_RPC_URL", "https://api.devnet.solana.com"),

  // Strategy
  strategy: envInt("STRATEGY", 1),
  tradeIntervalSec: envInt("TRADE_INTERVAL", 300),
  initialCapital: envInt("INITIAL_CAPITAL", 10000),

  // Trading
  enableRealSwaps: envBool("ENABLE_REAL_SWAPS", false),
  maxTradeUSD: envInt("MAX_TRADE_USD", 500),
  slippageBps: envInt("SLIPPAGE_BPS", 50),

  // Telegram
  telegramEnabled: envBool("TELEGRAM_ENABLED", false),
  telegramBotToken: envStr("TELEGRAM_BOT_TOKEN"),
  telegramChatId: envStr("TELEGRAM_CHAT_ID"),
  telegramReportMin: envInt("TELEGRAM_REPORT_INTERVAL_MIN", 60),

  // Coins
  coins: envStr("COINS", "bitcoin,ethereum,solana,bonk,jupiter,raydium").split(",").map((s) => s.trim()),

  // State
  stateFile: envStr("STATE_FILE", "./bot-state.json"),

  // Telegram Mini App
  webAppUrl: envStr("WEB_APP_URL", ""),

  // Logging
  logLevel: envStr("LOG_LEVEL", "info") as "debug" | "info" | "warn" | "error",
};

// ==================== STRATEGY RISK PROFILES ====================

export const STRATEGY_PROFILES = [
  { name: "Conservative", maxPositionPct: 0.15, stopLossPct: 2,  takeProfitPct: 3,  trailingStopPct: 1.5, maxHoldHours: 48, minConfidence: 0.5 },
  { name: "Moderate",     maxPositionPct: 0.25, stopLossPct: 3,  takeProfitPct: 5,  trailingStopPct: 2,   maxHoldHours: 24, minConfidence: 0.35 },
  { name: "Aggressive",   maxPositionPct: 0.40, stopLossPct: 5,  takeProfitPct: 8,  trailingStopPct: 3,   maxHoldHours: 12, minConfidence: 0.25 },
];

export function getStrategyProfile() {
  return STRATEGY_PROFILES[CONFIG.strategy] || STRATEGY_PROFILES[1];
}

// ==================== LOGGER ====================

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LOG_LEVELS[CONFIG.logLevel] ?? 1;

function timestamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export const log = {
  debug: (...args: unknown[]) => { if (currentLevel <= 0) console.log(`[${timestamp()}] [DEBUG]`, ...args); },
  info:  (...args: unknown[]) => { if (currentLevel <= 1) console.log(`[${timestamp()}] [INFO]`, ...args); },
  warn:  (...args: unknown[]) => { if (currentLevel <= 2) console.warn(`[${timestamp()}] [WARN]`, ...args); },
  error: (...args: unknown[]) => { if (currentLevel <= 3) console.error(`[${timestamp()}] [ERROR]`, ...args); },
};

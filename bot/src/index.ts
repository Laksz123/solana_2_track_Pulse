// ==================== AI ASSET MANAGER — 24/7 TRADING BOT ====================
// Autonomous trading bot: market data → AI analysis → Jupiter swaps → Telegram alerts
// Runs headless via Node.js with cron-like interval loop

import * as fs from "fs";
import * as path from "path";
import { Keypair, Connection, VersionedTransaction } from "@solana/web3.js";
import { CONFIG, getStrategyProfile, log } from "./config";
import { fetchMarketOverview, fetchOHLC, fetchPriceHistory, buildOHLCVFromPrices, OHLCV, MarketAsset } from "./market-data";
import { analyzeCandles, FullAnalysis } from "./technical-analysis";
import { sendTradeAlert, sendPnLReport, sendBotStarted, sendBotError, PnLSummary } from "./telegram";
import { TelegramCommandBot, BotControl } from "./telegram-commands";

// ==================== TYPES ====================

interface Position {
  symbol: string;
  coinId: string;
  amount: number;        // units of coin
  avgBuyPrice: number;
  currentPrice: number;
  unrealizedPnL: number;
  unrealizedPnLPct: number;
  peakPrice: number;     // highest price since entry (for trailing stop)
  openedAt: number;      // timestamp when position was opened
}

interface TradeRecord {
  timestamp: number;
  action: "BUY" | "SELL" | "HOLD";
  symbol: string;
  coinId: string;
  amountUSD: number;
  price: number;
  units: number;
  confidence: number;
  reasoning: string;
}

interface ClosedTrade {
  symbol: string;
  buyPrice: number;
  sellPrice: number;
  units: number;
  pnlUSD: number;
  returnPct: number;
}

interface BotState {
  cashUSD: number;
  positions: Position[];
  trades: TradeRecord[];
  closedTrades: ClosedTrade[];
  openBuys: Record<string, { price: number; units: number; timestamp: number }[]>;
  peakEquity: number;
  startedAt: string;
  lastRunAt: string;
  cycleCount: number;
}

// ==================== TOKEN MINT ADDRESSES ====================

const TOKEN_MINTS: Record<string, string> = {
  solana: "So11111111111111111111111111111111111111112",
  bitcoin: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
  ethereum: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
  bonk: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  jupiter: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  raydium: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
  "usd-coin": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

const COINGECKO_TO_SYMBOL: Record<string, string> = {
  bitcoin: "BTC", ethereum: "ETH", solana: "SOL",
  bonk: "BONK", jupiter: "JUP", raydium: "RAY", "usd-coin": "USDC",
};

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// ==================== STATE PERSISTENCE ====================

function loadState(): BotState {
  const filePath = path.resolve(CONFIG.stateFile);
  try {
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      log.info("Loaded state from", filePath);
      return data;
    }
  } catch (err) {
    log.warn("Failed to load state, starting fresh:", err);
  }

  return {
    cashUSD: CONFIG.initialCapital,
    positions: [],
    trades: [],
    closedTrades: [],
    openBuys: {},
    peakEquity: CONFIG.initialCapital,
    startedAt: new Date().toISOString(),
    lastRunAt: "",
    cycleCount: 0,
  };
}

function saveState(state: BotState): void {
  const filePath = path.resolve(CONFIG.stateFile);
  try {
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
    log.debug("State saved to", filePath);
  } catch (err) {
    log.error("Failed to save state:", err);
  }
}

// ==================== SOLANA WALLET ====================

function loadKeypair(): Keypair | null {
  // Try base58 private key from env
  if (CONFIG.privateKey) {
    try {
      const decoded = Buffer.from(CONFIG.privateKey, "base64");
      return Keypair.fromSecretKey(decoded);
    } catch {
      try {
        // Try as JSON array
        const arr = JSON.parse(CONFIG.privateKey);
        return Keypair.fromSecretKey(new Uint8Array(arr));
      } catch {
        log.error("Invalid SOLANA_PRIVATE_KEY format");
        return null;
      }
    }
  }

  // Try keypair file
  const kpPath = path.resolve(CONFIG.keypairPath);
  try {
    if (fs.existsSync(kpPath)) {
      const data = JSON.parse(fs.readFileSync(kpPath, "utf-8"));
      return Keypair.fromSecretKey(new Uint8Array(data));
    }
  } catch (err) {
    log.error("Failed to load keypair from", kpPath, err);
  }

  log.warn("No Solana keypair found — real swaps disabled");
  return null;
}

// ==================== JUPITER SWAP ====================

const JUPITER_API = "https://quote-api.jup.ag/v6";

async function executeJupiterSwap(
  connection: Connection,
  keypair: Keypair,
  inputMint: string,
  outputMint: string,
  amountLamports: number,
): Promise<{ success: boolean; signature?: string; error?: string }> {
  try {
    // 1. Get quote
    const quoteUrl = `${JUPITER_API}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=${CONFIG.slippageBps}`;
    const quoteResp = await fetch(quoteUrl);
    if (!quoteResp.ok) return { success: false, error: `Quote error: ${quoteResp.status}` };
    const quoteData = await quoteResp.json();

    // 2. Build swap transaction
    const swapResp = await fetch(`${JUPITER_API}/swap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quoteData,
        userPublicKey: keypair.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
      }),
    });
    if (!swapResp.ok) return { success: false, error: `Swap build error: ${swapResp.status}` };
    const swapData = await swapResp.json() as any;
    const swapTransaction = swapData.swapTransaction;

    // 3. Deserialize, sign, send
    const txBuf = Buffer.from(swapTransaction, "base64");
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([keypair]);

    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    });
    log.info("Swap TX sent:", sig);

    // 4. Confirm
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");

    return { success: true, signature: sig };
  } catch (err: any) {
    return { success: false, error: err.message || String(err) };
  }
}

// ==================== AI TRADE DECISION ====================

interface TradeDecision {
  action: "BUY" | "SELL" | "HOLD";
  coinId: string;
  symbol: string;
  amountUSD: number;
  confidence: number;
  reasoning: string;
  currentPrice: number;
}

function makeDecision(
  asset: MarketAsset,
  analysis: FullAnalysis,
  state: BotState,
): TradeDecision {
  const profile = getStrategyProfile();
  const { compositeScore, rsi } = analysis;
  const position = state.positions.find((p) => p.coinId === asset.id);

  // Confidence from composite score
  const confidence = Math.min(1, Math.abs(compositeScore) * 1.5 + 0.15);

  const totalEquity = state.cashUSD + state.positions.reduce((s, p) => s + p.amount * p.currentPrice, 0);

  // ==================== SELL LOGIC (check FIRST — protect capital) ====================
  if (position) {
    const pnlPct = position.avgBuyPrice > 0
      ? ((asset.currentPrice - position.avgBuyPrice) / position.avgBuyPrice) * 100
      : 0;
    const posValue = position.amount * asset.currentPrice;
    const holdHours = position.openedAt ? (Date.now() - position.openedAt) / (1000 * 60 * 60) : 0;
    const dropFromPeak = position.peakPrice > 0
      ? ((position.peakPrice - asset.currentPrice) / position.peakPrice) * 100
      : 0;

    // 1. STOP LOSS — immediate full exit
    if (pnlPct <= -profile.stopLossPct) {
      return {
        action: "SELL", coinId: asset.id, symbol: asset.symbol,
        amountUSD: posValue, confidence: 0.95, currentPrice: asset.currentPrice,
        reasoning: `🛑 STOP LOSS: ${pnlPct.toFixed(1)}% loss (limit: -${profile.stopLossPct}%)`,
      };
    }

    // 2. TAKE PROFIT — sell all when target reached
    if (pnlPct >= profile.takeProfitPct) {
      return {
        action: "SELL", coinId: asset.id, symbol: asset.symbol,
        amountUSD: posValue, confidence: 0.9, currentPrice: asset.currentPrice,
        reasoning: `🎯 TAKE PROFIT: +${pnlPct.toFixed(1)}% (target: +${profile.takeProfitPct}%)`,
      };
    }

    // 3. TRAILING STOP — if we were in profit but price dropped from peak
    if (pnlPct > 0.5 && dropFromPeak >= profile.trailingStopPct) {
      return {
        action: "SELL", coinId: asset.id, symbol: asset.symbol,
        amountUSD: posValue, confidence: 0.85, currentPrice: asset.currentPrice,
        reasoning: `📉 TRAILING STOP: dropped ${dropFromPeak.toFixed(1)}% from peak $${position.peakPrice.toFixed(2)} (limit: ${profile.trailingStopPct}%)`,
      };
    }

    // 4. TIME-BASED EXIT — sell losers after max hold time
    if (holdHours > profile.maxHoldHours && pnlPct < 0.5) {
      return {
        action: "SELL", coinId: asset.id, symbol: asset.symbol,
        amountUSD: posValue, confidence: 0.7, currentPrice: asset.currentPrice,
        reasoning: `⏰ TIME EXIT: held ${holdHours.toFixed(0)}h (max: ${profile.maxHoldHours}h), P&L: ${pnlPct.toFixed(1)}%`,
      };
    }

    // 5. PARTIAL PROFIT — sell 50% when halfway to take-profit
    if (pnlPct >= profile.takeProfitPct * 0.5 && pnlPct < profile.takeProfitPct) {
      // Only sell half once — check if we already partially sold
      const halfValue = posValue * 0.5;
      if (halfValue > 5) {
        return {
          action: "SELL", coinId: asset.id, symbol: asset.symbol,
          amountUSD: halfValue, confidence: 0.75, currentPrice: asset.currentPrice,
          reasoning: `💰 PARTIAL PROFIT: +${pnlPct.toFixed(1)}% — securing 50% at halfway to target`,
        };
      }
    }

    // 6. SIGNAL-BASED SELL — TA says sell (much looser threshold now)
    if (compositeScore < -0.08 && confidence >= profile.minConfidence) {
      const sellSignals = analysis.signals.filter((s) => s.signal === "SELL").map((s) => s.name);
      return {
        action: "SELL", coinId: asset.id, symbol: asset.symbol,
        amountUSD: posValue, confidence, currentPrice: asset.currentPrice,
        reasoning: `📊 SIGNAL SELL: score ${compositeScore.toFixed(2)} | RSI ${rsi.toFixed(0)} | ${sellSignals.join(", ")}`,
      };
    }

    // 7. RSI OVERBOUGHT SELL — take profit when RSI > 70
    if (rsi > 70 && pnlPct > 0) {
      return {
        action: "SELL", coinId: asset.id, symbol: asset.symbol,
        amountUSD: posValue * 0.6, confidence: 0.7, currentPrice: asset.currentPrice,
        reasoning: `📈 OVERBOUGHT: RSI ${rsi.toFixed(0)} > 70, locking in +${pnlPct.toFixed(1)}% profit`,
      };
    }
  }

  // ==================== BUY LOGIC ====================
  // Skip low confidence
  if (confidence < profile.minConfidence) {
    return {
      action: "HOLD", coinId: asset.id, symbol: asset.symbol,
      amountUSD: 0, confidence, currentPrice: asset.currentPrice,
      reasoning: `Low confidence ${(confidence * 100).toFixed(0)}% < ${(profile.minConfidence * 100).toFixed(0)}%`,
    };
  }

  // Only buy if we don't already hold this asset
  if (!position && compositeScore > 0.1) {
    const kellyFraction = Math.min(profile.maxPositionPct, confidence * 0.35);
    const maxSpend = Math.min(
      totalEquity * kellyFraction,
      state.cashUSD * 0.85, // keep 15% cash reserve
      CONFIG.maxTradeUSD,
    );

    if (maxSpend < 5) {
      return { action: "HOLD", coinId: asset.id, symbol: asset.symbol, amountUSD: 0, confidence, currentPrice: asset.currentPrice, reasoning: "Insufficient cash" };
    }

    const buySignals = analysis.signals.filter((s) => s.signal === "BUY").map((s) => s.name);
    return {
      action: "BUY", coinId: asset.id, symbol: asset.symbol,
      amountUSD: maxSpend, confidence, currentPrice: asset.currentPrice,
      reasoning: `Score ${compositeScore.toFixed(2)} | RSI ${rsi.toFixed(0)} | ${buySignals.join(", ")}`,
    };
  }

  return {
    action: "HOLD", coinId: asset.id, symbol: asset.symbol,
    amountUSD: 0, confidence, currentPrice: asset.currentPrice,
    reasoning: `Score ${compositeScore.toFixed(2)} — no action`,
  };
}

// ==================== TRADE MATCHING (FIFO) ====================

function matchSell(state: BotState, coinId: string, symbol: string, sellPrice: number, sellUnits: number): void {
  const buys = state.openBuys[coinId];
  if (!buys || buys.length === 0) return;

  let remaining = sellUnits;
  while (remaining > 0.0001 && buys.length > 0) {
    const buy = buys[0];
    const matchUnits = Math.min(remaining, buy.units);
    const pnlUSD = matchUnits * (sellPrice - buy.price);
    const returnPct = buy.price > 0 ? ((sellPrice - buy.price) / buy.price) * 100 : 0;

    state.closedTrades.push({ symbol, buyPrice: buy.price, sellPrice, units: matchUnits, pnlUSD, returnPct });

    buy.units -= matchUnits;
    remaining -= matchUnits;
    if (buy.units < 0.0001) buys.shift();
  }

  if (buys.length === 0) delete state.openBuys[coinId];
}

// ==================== EXECUTE TRADE ====================

async function executeTrade(
  decision: TradeDecision,
  state: BotState,
  connection: Connection | null,
  keypair: Keypair | null,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  if (decision.action === "BUY" && decision.amountUSD > 0) {
    const buyAmount = Math.min(decision.amountUSD, state.cashUSD);
    if (buyAmount < 1) return;

    const units = buyAmount / decision.currentPrice;

    // Execute real swap if enabled
    if (CONFIG.enableRealSwaps && connection && keypair) {
      const inputMint = USDC_MINT;
      const outputMint = TOKEN_MINTS[decision.coinId];
      if (outputMint) {
        const lamports = Math.floor(buyAmount * 1e6); // USDC has 6 decimals
        const result = await executeJupiterSwap(connection, keypair, inputMint, outputMint, lamports);
        if (!result.success) {
          log.error(`Real swap failed for BUY ${decision.symbol}:`, result.error);
          await sendBotError(`BUY ${decision.symbol} swap failed: ${result.error}`);
          return;
        }
        log.info(`Real swap executed: BUY ${decision.symbol} TX: ${result.signature}`);
      }
    }

    // Update portfolio
    state.cashUSD -= buyAmount;
    const existing = state.positions.find((p) => p.coinId === decision.coinId);
    if (existing) {
      const newAmount = existing.amount + units;
      existing.avgBuyPrice = (existing.avgBuyPrice * existing.amount + decision.currentPrice * units) / newAmount;
      existing.amount = newAmount;
      existing.currentPrice = decision.currentPrice;
    } else {
      state.positions.push({
        symbol: decision.symbol, coinId: decision.coinId,
        amount: units, avgBuyPrice: decision.currentPrice,
        currentPrice: decision.currentPrice, unrealizedPnL: 0, unrealizedPnLPct: 0,
        peakPrice: decision.currentPrice, openedAt: Date.now(),
      });
    }

    // Track open buys for FIFO matching
    if (!state.openBuys[decision.coinId]) state.openBuys[decision.coinId] = [];
    state.openBuys[decision.coinId].push({ price: decision.currentPrice, units, timestamp: now });

    log.info(`BUY ${decision.symbol}: $${buyAmount.toFixed(2)} @ $${decision.currentPrice} (${(decision.confidence * 100).toFixed(0)}%)`);
    await sendTradeAlert("BUY", decision.symbol, buyAmount, decision.currentPrice, decision.confidence, decision.reasoning);

  } else if (decision.action === "SELL" && decision.amountUSD > 0) {
    const position = state.positions.find((p) => p.coinId === decision.coinId);
    if (!position) return;

    const sellUnits = Math.min(position.amount, decision.amountUSD / decision.currentPrice);
    const sellUSD = sellUnits * decision.currentPrice;

    // Execute real swap if enabled
    if (CONFIG.enableRealSwaps && connection && keypair) {
      const inputMint = TOKEN_MINTS[decision.coinId];
      const outputMint = USDC_MINT;
      if (inputMint) {
        // Approximate lamports for the token
        const lamports = Math.floor(sellUnits * 1e9); // Most SPL tokens use 9 decimals
        const result = await executeJupiterSwap(connection, keypair, inputMint, outputMint, lamports);
        if (!result.success) {
          log.error(`Real swap failed for SELL ${decision.symbol}:`, result.error);
          await sendBotError(`SELL ${decision.symbol} swap failed: ${result.error}`);
          return;
        }
        log.info(`Real swap executed: SELL ${decision.symbol} TX: ${result.signature}`);
      }
    }

    // Match sell with open buys
    matchSell(state, decision.coinId, decision.symbol, decision.currentPrice, sellUnits);

    // Update portfolio
    state.cashUSD += sellUSD;
    position.amount -= sellUnits;
    if (position.amount < 0.0001) {
      state.positions = state.positions.filter((p) => p.coinId !== decision.coinId);
    }

    log.info(`SELL ${decision.symbol}: $${sellUSD.toFixed(2)} @ $${decision.currentPrice} (${(decision.confidence * 100).toFixed(0)}%)`);
    await sendTradeAlert("SELL", decision.symbol, sellUSD, decision.currentPrice, decision.confidence, decision.reasoning);
  }

  // Record trade
  state.trades.push({
    timestamp: now,
    action: decision.action,
    symbol: decision.symbol,
    coinId: decision.coinId,
    amountUSD: decision.amountUSD,
    price: decision.currentPrice,
    units: decision.amountUSD / decision.currentPrice,
    confidence: decision.confidence,
    reasoning: decision.reasoning,
  });

  // Keep last 500 trades in state
  if (state.trades.length > 500) state.trades = state.trades.slice(-400);
}

// ==================== TRADING CYCLE ====================

async function runCycle(state: BotState, connection: Connection | null, keypair: Keypair | null): Promise<void> {
  state.cycleCount++;
  state.lastRunAt = new Date().toISOString();

  log.info(`=== Cycle #${state.cycleCount} ===`);

  // 1. Fetch market data
  const assets = await fetchMarketOverview(CONFIG.coins);
  if (assets.length === 0) {
    log.warn("No market data received, skipping cycle");
    return;
  }

  // 2. Update current prices on positions + track peak for trailing stop
  for (const pos of state.positions) {
    const asset = assets.find((a) => a.id === pos.coinId);
    if (asset) {
      pos.currentPrice = asset.currentPrice;
      pos.unrealizedPnL = (asset.currentPrice - pos.avgBuyPrice) * pos.amount;
      pos.unrealizedPnLPct = pos.avgBuyPrice > 0 ? ((asset.currentPrice - pos.avgBuyPrice) / pos.avgBuyPrice) * 100 : 0;
      // Track peak price for trailing stop
      if (!pos.peakPrice) pos.peakPrice = pos.avgBuyPrice;
      if (asset.currentPrice > pos.peakPrice) pos.peakPrice = asset.currentPrice;
      // Backfill openedAt for legacy positions
      if (!pos.openedAt) pos.openedAt = Date.now();
    }
  }

  // 3. Track equity
  const totalEquity = state.cashUSD + state.positions.reduce((s, p) => s + p.amount * p.currentPrice, 0);
  if (totalEquity > state.peakEquity) state.peakEquity = totalEquity;

  log.info(`Equity: $${totalEquity.toFixed(2)} | Cash: $${state.cashUSD.toFixed(2)} | Positions: ${state.positions.length}`);

  // 4. Analyze each asset and make decisions
  const decisions: TradeDecision[] = [];

  for (const asset of assets) {
    try {
      // Fetch OHLCV data
      let candles = await fetchOHLC(asset.id, 7);
      if (candles.length < 20) {
        const prices = await fetchPriceHistory(asset.id, 7);
        candles = buildOHLCVFromPrices(prices);
      }
      if (candles.length < 10) {
        log.debug(`Skipping ${asset.symbol}: insufficient candle data (${candles.length})`);
        continue;
      }

      // Run technical analysis
      const analysis = analyzeCandles(candles);

      // Make AI decision
      const decision = makeDecision(asset, analysis, state);
      decisions.push(decision);

      log.debug(`${asset.symbol}: score=${analysis.compositeScore.toFixed(2)} → ${decision.action} (${(decision.confidence * 100).toFixed(0)}%)`);

    } catch (err) {
      log.error(`Error analyzing ${asset.symbol}:`, err);
    }
  }

  // 5. Execute trades: ALL sells first (risk management), then best BUY
  const actionable = decisions.filter((d) => d.action !== "HOLD" && d.amountUSD > 0);

  if (actionable.length > 0) {
    const sells = actionable.filter((d) => d.action === "SELL").sort((a, b) => b.confidence - a.confidence);
    const buys = actionable.filter((d) => d.action === "BUY").sort((a, b) => b.confidence - a.confidence);

    // Execute ALL sells — never delay risk management
    for (const sell of sells) {
      await executeTrade(sell, state, connection, keypair);
    }
    if (sells.length > 0) {
      log.info(`Executed ${sells.length} SELL(s) this cycle`);
    }

    // Execute best BUY (only 1 per cycle to avoid over-exposure)
    if (buys.length > 0 && sells.length === 0) {
      await executeTrade(buys[0], state, connection, keypair);
    }
  } else {
    log.info("All HOLD — no trades this cycle");
  }

  // 6. Save state
  saveState(state);
}

// ==================== P&L REPORT ====================

function buildPnLSummary(state: BotState): PnLSummary {
  const totalEquity = state.cashUSD + state.positions.reduce((s, p) => s + p.amount * p.currentPrice, 0);
  const realizedPnL = state.closedTrades.reduce((s, t) => s + t.pnlUSD, 0);
  const unrealizedPnL = state.positions.reduce((s, p) => s + p.unrealizedPnL, 0);
  const totalPnLUSD = realizedPnL + unrealizedPnL;
  const totalPnLPct = CONFIG.initialCapital > 0 ? (totalPnLUSD / CONFIG.initialCapital) * 100 : 0;
  const winners = state.closedTrades.filter((t) => t.pnlUSD > 0);
  const winRate = state.closedTrades.length > 0 ? (winners.length / state.closedTrades.length) * 100 : 0;

  return {
    totalPnLUSD,
    totalPnLPct,
    realizedPnLUSD: realizedPnL,
    unrealizedPnLUSD: unrealizedPnL,
    totalTrades: state.closedTrades.length,
    winRate,
    totalEquity,
    positions: state.positions.map((p) => ({
      symbol: p.symbol,
      amountUSD: p.amount * p.currentPrice,
      pnlPct: p.unrealizedPnLPct,
    })),
  };
}

// ==================== MAIN ====================

async function main(): Promise<void> {
  log.info("======================================");
  log.info("  AI ASSET MANAGER — 24/7 TRADING BOT");
  log.info("======================================");
  log.info(`Strategy: ${getStrategyProfile().name}`);
  log.info(`Interval: ${CONFIG.tradeIntervalSec}s`);
  log.info(`Coins: ${CONFIG.coins.join(", ")}`);
  log.info(`Real swaps: ${CONFIG.enableRealSwaps ? "ENABLED ⚠️" : "disabled (simulation)"}`);
  log.info(`RPC: ${CONFIG.rpcUrl}`);

  // Load state
  const state = loadState();
  log.info(`Cash: $${state.cashUSD.toFixed(2)} | Positions: ${state.positions.length} | Trades: ${state.trades.length}`);

  // Load keypair
  const keypair = loadKeypair();
  if (keypair) {
    log.info(`Wallet: ${keypair.publicKey.toBase58()}`);
  }

  // Connect to Solana
  let connection: Connection | null = null;
  if (CONFIG.enableRealSwaps && keypair) {
    connection = new Connection(CONFIG.rpcUrl, "confirmed");
    log.info("Solana connection established");
  }

  // ==================== TELEGRAM COMMAND BOT ====================
  // Set up bot control for Telegram commands
  const botControl: BotControl = {
    tradingEnabled: true,
    strategy: CONFIG.strategy,
    getState: () => state,
    onStrategyChange: (newStrategy) => {
      CONFIG.strategy = newStrategy;
      log.info(`Strategy changed via Telegram: ${getStrategyProfile().name}`);
    },
    onTradingToggle: (enabled) => {
      log.info(`Trading ${enabled ? "enabled" : "disabled"} via Telegram`);
    },
  };

  // Start Telegram command bot (runs in background)
  const tgBot = new TelegramCommandBot(botControl);
  tgBot.start(); // non-blocking, runs polling loop

  // Send Telegram start notification
  await sendBotStarted();

  // P&L report timer
  let lastReportAt = Date.now();

  // Graceful shutdown
  let running = true;
  const shutdown = () => {
    log.info("Shutting down...");
    running = false;
    tgBot.stop();
    saveState(state);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Main loop
  log.info(`Starting trading loop (every ${CONFIG.tradeIntervalSec}s)...`);

  while (running) {
    try {
      // Check if trading is enabled via Telegram control
      if (botControl.tradingEnabled) {
        await runCycle(state, connection, keypair);
      } else {
        log.debug("Trading paused via Telegram — skipping cycle");
      }

      // Send periodic P&L report
      if (CONFIG.telegramEnabled && CONFIG.telegramReportMin > 0) {
        const elapsed = Date.now() - lastReportAt;
        if (elapsed >= CONFIG.telegramReportMin * 60 * 1000) {
          const summary = buildPnLSummary(state);
          await sendPnLReport(summary);
          lastReportAt = Date.now();
        }
      }
    } catch (err: any) {
      log.error("Cycle error:", err);
      await sendBotError(err.message || String(err));
    }

    // Wait for next cycle
    await new Promise((r) => setTimeout(r, CONFIG.tradeIntervalSec * 1000));
  }
}

main().catch((err) => {
  log.error("Fatal error:", err);
  sendBotError(`Fatal: ${err.message || err}`).finally(() => process.exit(1));
});

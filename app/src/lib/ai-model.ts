// ==================== AI TRADING MODEL ====================
// Combines technical analysis signals with risk management
// to produce precise buy/sell/hold decisions

import { OHLCV, RealMarketAsset } from "./market-data";
import { analyzeAsset, FullAnalysis, TASignal } from "./technical-analysis";

// ==================== PORTFOLIO STATE ====================

export interface PortfolioPosition {
  symbol: string;
  coinId: string;
  amount: number;       // units held
  avgBuyPrice: number;  // USD
  currentPrice: number;
  unrealizedPnL: number;
  unrealizedPnLPct: number;
}

export interface Portfolio {
  cashUSD: number;
  positions: PortfolioPosition[];
  totalValue: number;
}

// ==================== AI DECISION ====================

export interface AITradeDecision {
  action: "BUY" | "SELL" | "HOLD";
  symbol: string;
  coinId: string;
  amountUSD: number;
  currentPrice: number;
  confidence: number;        // 0-1
  reasoning: string;
  analysis: FullAnalysis;
  riskLevel: "low" | "medium" | "high";
  signalsSummary: string[];  // human-readable list of active signals
}

// ==================== RISK MANAGEMENT ====================

interface RiskParams {
  maxPositionPct: number;     // max % of portfolio in one asset
  maxDrawdownPct: number;     // max loss before force-sell
  minConfidence: number;      // min confidence to execute trade
  trailingStopPct: number;    // trailing stop-loss %
  takeProfitPct: number;      // take-profit %
  riskPerTradePct: number;    // max risk per trade as % of portfolio
}

const STRATEGY_RISK: Record<number, RiskParams> = {
  // Conservative
  0: {
    maxPositionPct: 0.20,
    maxDrawdownPct: 0.05,
    minConfidence: 0.40,
    trailingStopPct: 0.03,
    takeProfitPct: 0.08,
    riskPerTradePct: 0.03,
  },
  // Moderate
  1: {
    maxPositionPct: 0.30,
    maxDrawdownPct: 0.10,
    minConfidence: 0.30,
    trailingStopPct: 0.05,
    takeProfitPct: 0.15,
    riskPerTradePct: 0.06,
  },
  // Aggressive
  2: {
    maxPositionPct: 0.45,
    maxDrawdownPct: 0.20,
    minConfidence: 0.20,
    trailingStopPct: 0.08,
    takeProfitPct: 0.25,
    riskPerTradePct: 0.12,
  },
};

// ==================== POSITION SIZING (Kelly Criterion variant) ====================

function calculatePositionSize(
  confidence: number,
  portfolioValue: number,
  risk: RiskParams,
  currentPositionPct: number,
): number {
  // Modified Kelly: f = (p * b - q) / b
  // Where p = win probability (confidence), q = 1-p, b = avg win/loss ratio
  const p = Math.max(0.01, Math.min(0.99, confidence));
  const q = 1 - p;
  const b = risk.takeProfitPct / risk.trailingStopPct; // reward/risk ratio
  const kelly = (p * b - q) / b;

  // Use half-Kelly for safety
  const halfKelly = Math.max(0, kelly * 0.5);

  // Apply position limits
  const maxNewPosition = (risk.maxPositionPct - currentPositionPct) * portfolioValue;
  const riskBasedSize = risk.riskPerTradePct * portfolioValue;

  return Math.min(halfKelly * portfolioValue, maxNewPosition, riskBasedSize);
}

// ==================== MAIN AI DECISION FUNCTION ====================

export function makeAITradeDecision(
  asset: RealMarketAsset,
  candles: OHLCV[],
  portfolio: Portfolio,
  strategy: number,
): AITradeDecision {
  const risk = STRATEGY_RISK[strategy] || STRATEGY_RISK[1];

  // Run full technical analysis
  const analysis = analyzeAsset(candles);

  // Check if we already hold this asset
  const existingPos = portfolio.positions.find((p) => p.coinId === asset.id);
  const currentPositionValue = existingPos ? existingPos.amount * asset.currentPrice : 0;
  const currentPositionPct = portfolio.totalValue > 0 ? currentPositionValue / portfolio.totalValue : 0;

  const signalsSummary: string[] = analysis.signals
    .filter((s) => s.signal !== "neutral")
    .map((s) => `${s.name}: ${s.signal.toUpperCase()} (${(s.strength * 100).toFixed(0)}%) — ${s.description}`);

  // Default: HOLD
  let action: "BUY" | "SELL" | "HOLD" = "HOLD";
  let amountUSD = 0;
  let reasoning = "";
  let riskLevel: "low" | "medium" | "high" = "medium";

  // ==================== SELL LOGIC ====================
  if (existingPos) {
    // Force sell: stop-loss hit
    if (existingPos.unrealizedPnLPct <= -risk.maxDrawdownPct * 100) {
      action = "SELL";
      amountUSD = currentPositionValue;
      reasoning = `Stop-loss triggered: ${existingPos.unrealizedPnLPct.toFixed(1)}% loss exceeds max drawdown of ${(risk.maxDrawdownPct * 100).toFixed(0)}%`;
      riskLevel = "high";
    }
    // Take profit
    else if (existingPos.unrealizedPnLPct >= risk.takeProfitPct * 100) {
      action = "SELL";
      amountUSD = currentPositionValue * 0.5; // sell half at take-profit
      reasoning = `Take-profit: ${existingPos.unrealizedPnLPct.toFixed(1)}% gain reached target of ${(risk.takeProfitPct * 100).toFixed(0)}%`;
      riskLevel = "low";
    }
    // Technical sell signal
    else if (analysis.recommendation === "STRONG_SELL" && analysis.overallConfidence >= risk.minConfidence) {
      action = "SELL";
      amountUSD = currentPositionValue * 0.7; // sell 70% on strong signal
      reasoning = buildSellReasoning(analysis);
      riskLevel = "medium";
    }
    else if (analysis.recommendation === "SELL" && analysis.overallConfidence >= risk.minConfidence) {
      action = "SELL";
      amountUSD = currentPositionValue * 0.4; // sell 40% on moderate signal
      reasoning = buildSellReasoning(analysis);
      riskLevel = "medium";
    }
    // Trailing stop
    else if (existingPos.unrealizedPnLPct > risk.trailingStopPct * 100 * 0.5) {
      // If we were in profit but now dropping
      const dropFromHigh = (asset.high24h - asset.currentPrice) / asset.high24h;
      if (dropFromHigh > risk.trailingStopPct) {
        action = "SELL";
        amountUSD = currentPositionValue * 0.5;
        reasoning = `Trailing stop: price dropped ${(dropFromHigh * 100).toFixed(1)}% from 24h high`;
        riskLevel = "medium";
      }
    }
  }

  // ==================== BUY LOGIC ====================
  // Guard: must have enough cash AND not already maxed out on this asset
  const minCashReserve = portfolio.totalValue * 0.10; // always keep 10% cash
  const availableCash = Math.max(0, portfolio.cashUSD - minCashReserve);
  const alreadyMaxed = currentPositionPct >= risk.maxPositionPct;

  if (action === "HOLD" && availableCash > 10 && !alreadyMaxed) {
    const isBuySignal = analysis.recommendation === "STRONG_BUY" || analysis.recommendation === "BUY";
    const isWeakBuy = !existingPos && analysis.overallScore > 0.05 && analysis.overallConfidence >= risk.minConfidence;
    // Dip-buying: only if we DON'T already hold this asset
    const isDipBuy = !existingPos && asset.priceChangePercent24h < -3 && analysis.overallScore > -0.15;
    // RSI oversold: only if we DON'T already hold this asset
    const isOversoldBuy = !existingPos && analysis.rsi < 35 && analysis.overallScore > -0.2;

    if (
      (isBuySignal && analysis.overallConfidence >= risk.minConfidence) ||
      isWeakBuy ||
      isDipBuy ||
      isOversoldBuy
    ) {
      let size = calculatePositionSize(
        Math.max(analysis.overallConfidence, 0.3),
        portfolio.totalValue,
        risk,
        currentPositionPct,
      );

      // For dip buys, use a fixed % of portfolio
      if (isDipBuy && size < availableCash * risk.riskPerTradePct) {
        size = availableCash * risk.riskPerTradePct;
      }

      // Cap at available cash (never go negative)
      size = Math.min(size, availableCash);

      if (size > 5) {
        action = "BUY";
        amountUSD = size;
        reasoning = isDipBuy
          ? `Dip buy: ${asset.symbol} dropped ${asset.priceChangePercent24h.toFixed(1)}% in 24h. ${buildBuyReasoning(analysis, asset)}`
          : isOversoldBuy
          ? `Oversold (RSI=${analysis.rsi.toFixed(0)}): ${buildBuyReasoning(analysis, asset)}`
          : buildBuyReasoning(analysis, asset);
        riskLevel = analysis.overallConfidence > 0.7 ? "low" : analysis.overallConfidence > 0.4 ? "medium" : "high";
      }
    }
  }

  // ==================== HOLD REASONING ====================
  if (action === "HOLD") {
    reasoning = buildHoldReasoning(analysis, existingPos, risk);
  }

  return {
    action,
    symbol: asset.symbol,
    coinId: asset.id,
    amountUSD: Math.round(amountUSD * 100) / 100,
    currentPrice: asset.currentPrice,
    confidence: analysis.overallConfidence,
    reasoning,
    analysis,
    riskLevel,
    signalsSummary,
  };
}

// ==================== REASONING BUILDERS ====================

function buildBuyReasoning(analysis: FullAnalysis, asset: RealMarketAsset): string {
  const parts: string[] = [];

  const buySignals = analysis.signals.filter((s) => s.signal === "buy");
  const topSignals = buySignals.sort((a, b) => b.strength - a.strength).slice(0, 3);

  parts.push(`${analysis.recommendation} signal (score: ${(analysis.overallScore * 100).toFixed(0)}%, confidence: ${(analysis.overallConfidence * 100).toFixed(0)}%).`);

  for (const sig of topSignals) {
    parts.push(sig.description + ".");
  }

  if (analysis.trend.trend === "strong_up" || analysis.trend.trend === "up") {
    parts.push(`Trend: ${analysis.trend.trend.replace("_", " ")}.`);
  }

  if (asset.priceChangePercent24h < -5) {
    parts.push(`24h dip of ${asset.priceChangePercent24h.toFixed(1)}% — potential recovery entry.`);
  }

  return parts.join(" ");
}

function buildSellReasoning(analysis: FullAnalysis): string {
  const parts: string[] = [];

  const sellSignals = analysis.signals.filter((s) => s.signal === "sell");
  const topSignals = sellSignals.sort((a, b) => b.strength - a.strength).slice(0, 3);

  parts.push(`${analysis.recommendation} signal (score: ${(analysis.overallScore * 100).toFixed(0)}%, confidence: ${(analysis.overallConfidence * 100).toFixed(0)}%).`);

  for (const sig of topSignals) {
    parts.push(sig.description + ".");
  }

  return parts.join(" ");
}

function buildHoldReasoning(
  analysis: FullAnalysis,
  existingPos: PortfolioPosition | undefined,
  risk: RiskParams,
): string {
  const parts: string[] = [];

  if (analysis.overallConfidence < risk.minConfidence) {
    parts.push(`Confidence too low (${(analysis.overallConfidence * 100).toFixed(0)}% < ${(risk.minConfidence * 100).toFixed(0)}% threshold).`);
  }

  if (analysis.recommendation === "HOLD") {
    parts.push("Mixed signals — no clear direction.");
  }

  const neutralCount = analysis.signals.filter((s) => s.signal === "neutral").length;
  if (neutralCount > analysis.signals.length / 2) {
    parts.push(`${neutralCount}/${analysis.signals.length} indicators are neutral.`);
  }

  if (existingPos) {
    parts.push(`Holding ${existingPos.symbol} (P&L: ${existingPos.unrealizedPnLPct >= 0 ? "+" : ""}${existingPos.unrealizedPnLPct.toFixed(1)}%).`);
  }

  if (analysis.adx < 20) {
    parts.push(`Weak trend (ADX=${analysis.adx.toFixed(0)}) — waiting for stronger signal.`);
  }

  return parts.length > 0 ? parts.join(" ") : "Waiting for a clear trading opportunity.";
}

// ==================== ANALYZE ALL ASSETS & PICK BEST ====================

export function analyzeAllAssets(
  assets: RealMarketAsset[],
  candlesMap: Record<string, OHLCV[]>,
  portfolio: Portfolio,
  strategy: number,
): AITradeDecision[] {
  const decisions: AITradeDecision[] = [];

  for (const asset of assets) {
    const candles = candlesMap[asset.id];
    if (!candles || candles.length < 20) continue;

    const decision = makeAITradeDecision(asset, candles, portfolio, strategy);
    decisions.push(decision);
  }

  // Sort: prioritize sells (risk management first), then buys by confidence,
  // then HOLDs by most interesting (highest absolute score)
  decisions.sort((a, b) => {
    if (a.action === "SELL" && b.action !== "SELL") return -1;
    if (b.action === "SELL" && a.action !== "SELL") return 1;
    if (a.action === "BUY" && b.action === "BUY") return b.confidence - a.confidence;
    if (a.action === "BUY") return -1;
    if (b.action === "BUY") return 1;
    // HOLDs: sort by absolute score (most interesting first)
    return Math.abs(b.analysis.overallScore) - Math.abs(a.analysis.overallScore);
  });

  return decisions;
}

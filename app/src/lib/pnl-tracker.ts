// ==================== P&L TRACKER (REALTIME) ====================
// Tracks live trading performance: realized/unrealized P&L,
// win rate, Sharpe ratio, max drawdown, equity curve

import { PortfolioPosition } from "./ai-model";

// ==================== TYPES ====================

export interface TradeRecord {
  id: string;
  timestamp: number;       // unix seconds
  action: "BUY" | "SELL";
  symbol: string;
  coinId: string;
  amountUSD: number;
  price: number;
  units: number;
}

export interface ClosedTrade {
  symbol: string;
  coinId: string;
  buyPrice: number;
  sellPrice: number;
  units: number;
  pnlUSD: number;
  returnPct: number;
  holdingSeconds: number;
  buyTimestamp: number;
  sellTimestamp: number;
}

export interface EquitySnapshot {
  timestamp: number;
  totalEquity: number;
  cashUSD: number;
  positionsUSD: number;
  realizedPnL: number;
  unrealizedPnL: number;
}

export interface PnLMetrics {
  // P&L
  totalPnLUSD: number;           // realized + unrealized
  totalPnLPct: number;
  realizedPnLUSD: number;        // closed trades only
  unrealizedPnLUSD: number;      // open positions only
  unrealizedPnLPct: number;

  // Trade stats
  totalTrades: number;           // completed round-trips
  winningTrades: number;
  losingTrades: number;
  winRate: number;               // %
  avgWinUSD: number;
  avgLossUSD: number;
  largestWinUSD: number;
  largestLossUSD: number;
  profitFactor: number;          // gross profit / gross loss
  expectancy: number;            // avg $ per trade

  // Risk metrics
  maxDrawdown: number;           // max drawdown %
  maxDrawdownUSD: number;
  currentDrawdown: number;       // current drawdown from peak %
  sharpeRatio: number;           // annualized
  sortinoRatio: number;          // annualized (downside only)
  volatility: number;            // annualized %
  calmarRatio: number;           // annual return / max drawdown

  // Streaks
  currentStreak: number;         // positive = win streak, negative = loss streak
  longestWinStreak: number;
  longestLossStreak: number;

  // Portfolio
  totalEquity: number;
  peakEquity: number;
  cashPct: number;               // % in cash
  positionsPct: number;          // % in positions
}

// ==================== P&L TRACKER CLASS ====================

export class PnLTracker {
  private trades: TradeRecord[] = [];
  private closedTrades: ClosedTrade[] = [];
  private equityHistory: EquitySnapshot[] = [];
  private openBuys: Map<string, { timestamp: number; price: number; units: number }[]> = new Map();
  private initialCapital: number;
  private peakEquity: number;

  constructor(initialCapital: number = 10000) {
    this.initialCapital = initialCapital;
    this.peakEquity = initialCapital;
  }

  // ==================== RECORD TRADE ====================

  recordTrade(
    action: "BUY" | "SELL",
    symbol: string,
    coinId: string,
    amountUSD: number,
    price: number,
  ): void {
    const units = price > 0 ? amountUSD / price : 0;
    const trade: TradeRecord = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Math.floor(Date.now() / 1000),
      action,
      symbol,
      coinId,
      amountUSD,
      price,
      units,
    };
    this.trades.push(trade);

    if (action === "BUY") {
      const buys = this.openBuys.get(coinId) || [];
      buys.push({ timestamp: trade.timestamp, price, units });
      this.openBuys.set(coinId, buys);
    } else if (action === "SELL") {
      this.matchSell(coinId, symbol, price, units, trade.timestamp);
    }
  }

  // ==================== MATCH SELL WITH OPEN BUYS (FIFO) ====================

  private matchSell(coinId: string, symbol: string, sellPrice: number, sellUnits: number, sellTimestamp: number): void {
    const buys = this.openBuys.get(coinId);
    if (!buys || buys.length === 0) return;

    let remaining = sellUnits;
    while (remaining > 0.0001 && buys.length > 0) {
      const buy = buys[0];
      const matchUnits = Math.min(remaining, buy.units);
      const pnlUSD = matchUnits * (sellPrice - buy.price);
      const returnPct = buy.price > 0 ? ((sellPrice - buy.price) / buy.price) * 100 : 0;

      this.closedTrades.push({
        symbol,
        coinId,
        buyPrice: buy.price,
        sellPrice,
        units: matchUnits,
        pnlUSD,
        returnPct,
        holdingSeconds: sellTimestamp - buy.timestamp,
        buyTimestamp: buy.timestamp,
        sellTimestamp,
      });

      buy.units -= matchUnits;
      remaining -= matchUnits;

      if (buy.units < 0.0001) {
        buys.shift();
      }
    }

    if (buys.length === 0) {
      this.openBuys.delete(coinId);
    }
  }

  // ==================== SNAPSHOT EQUITY ====================

  snapshotEquity(cashUSD: number, positions: PortfolioPosition[]): void {
    const positionsUSD = positions.reduce((s, p) => s + p.amount * p.currentPrice, 0);
    const totalEquity = cashUSD + positionsUSD;
    const realizedPnL = this.closedTrades.reduce((s, t) => s + t.pnlUSD, 0);
    const unrealizedPnL = positions.reduce((s, p) => s + p.unrealizedPnL, 0);

    if (totalEquity > this.peakEquity) {
      this.peakEquity = totalEquity;
    }

    this.equityHistory.push({
      timestamp: Math.floor(Date.now() / 1000),
      totalEquity,
      cashUSD,
      positionsUSD,
      realizedPnL,
      unrealizedPnL,
    });

    // Keep max 2000 snapshots to avoid memory issues
    if (this.equityHistory.length > 2000) {
      this.equityHistory = this.equityHistory.slice(-1500);
    }
  }

  // ==================== CALCULATE METRICS ====================

  getMetrics(cashUSD: number, positions: PortfolioPosition[]): PnLMetrics {
    const positionsUSD = positions.reduce((s, p) => s + p.amount * p.currentPrice, 0);
    const totalEquity = cashUSD + positionsUSD;
    const unrealizedPnL = positions.reduce((s, p) => s + p.unrealizedPnL, 0);
    const realizedPnL = this.closedTrades.reduce((s, t) => s + t.pnlUSD, 0);
    const totalPnLUSD = realizedPnL + unrealizedPnL;
    const totalPnLPct = this.initialCapital > 0 ? (totalPnLUSD / this.initialCapital) * 100 : 0;

    // Update peak
    if (totalEquity > this.peakEquity) this.peakEquity = totalEquity;

    // Win/loss stats
    const winners = this.closedTrades.filter((t) => t.pnlUSD > 0);
    const losers = this.closedTrades.filter((t) => t.pnlUSD <= 0);
    const totalTrades = this.closedTrades.length;
    const winRate = totalTrades > 0 ? (winners.length / totalTrades) * 100 : 0;

    const grossProfit = winners.reduce((s, t) => s + t.pnlUSD, 0);
    const grossLoss = Math.abs(losers.reduce((s, t) => s + t.pnlUSD, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

    const avgWinUSD = winners.length > 0 ? grossProfit / winners.length : 0;
    const avgLossUSD = losers.length > 0 ? grossLoss / losers.length : 0;
    const largestWinUSD = winners.length > 0 ? Math.max(...winners.map((t) => t.pnlUSD)) : 0;
    const largestLossUSD = losers.length > 0 ? Math.min(...losers.map((t) => t.pnlUSD)) : 0;
    const expectancy = totalTrades > 0 ? totalPnLUSD / totalTrades : 0;

    // Drawdown
    let maxDrawdown = 0;
    let maxDrawdownUSD = 0;
    let peak = this.initialCapital;
    for (const snap of this.equityHistory) {
      if (snap.totalEquity > peak) peak = snap.totalEquity;
      const dd = peak > 0 ? ((peak - snap.totalEquity) / peak) * 100 : 0;
      const ddUSD = peak - snap.totalEquity;
      if (dd > maxDrawdown) {
        maxDrawdown = dd;
        maxDrawdownUSD = ddUSD;
      }
    }
    const currentDrawdown = this.peakEquity > 0 ? ((this.peakEquity - totalEquity) / this.peakEquity) * 100 : 0;

    // Sharpe, Sortino from equity snapshots
    const returns = this.calculateReturns();
    const avgReturn = returns.length > 0 ? returns.reduce((s, r) => s + r, 0) / returns.length : 0;
    const retStdDev = this.stdDev(returns);
    const downsideReturns = returns.filter((r) => r < 0);
    const downsideStdDev = this.stdDev(downsideReturns);

    // Annualize based on snapshot frequency (~15s intervals → ~5760/day)
    const snapshotsPerDay = this.estimateSnapshotsPerDay();
    const annFactor = Math.sqrt(365 * snapshotsPerDay);
    const sharpeRatio = retStdDev > 0 ? (avgReturn / retStdDev) * annFactor : 0;
    const sortinoRatio = downsideStdDev > 0 ? (avgReturn / downsideStdDev) * annFactor : 0;
    const volatility = retStdDev * annFactor * 100;

    // Calmar ratio
    const durationDays = this.equityHistory.length > 1
      ? (this.equityHistory[this.equityHistory.length - 1].timestamp - this.equityHistory[0].timestamp) / 86400
      : 1;
    const annualReturn = durationDays > 0
      ? (totalPnLPct / durationDays) * 365
      : 0;
    const calmarRatio = maxDrawdown > 0 ? annualReturn / maxDrawdown : 0;

    // Streaks
    const { currentStreak, longestWinStreak, longestLossStreak } = this.calculateStreaks();

    // Portfolio allocation
    const cashPct = totalEquity > 0 ? (cashUSD / totalEquity) * 100 : 100;
    const positionsPct = totalEquity > 0 ? (positionsUSD / totalEquity) * 100 : 0;

    return {
      totalPnLUSD,
      totalPnLPct,
      realizedPnLUSD: realizedPnL,
      unrealizedPnLUSD: unrealizedPnL,
      unrealizedPnLPct: positionsUSD > 0 ? (unrealizedPnL / (positionsUSD - unrealizedPnL)) * 100 : 0,
      totalTrades,
      winningTrades: winners.length,
      losingTrades: losers.length,
      winRate,
      avgWinUSD,
      avgLossUSD,
      largestWinUSD,
      largestLossUSD,
      profitFactor,
      expectancy,
      maxDrawdown,
      maxDrawdownUSD,
      currentDrawdown,
      sharpeRatio,
      sortinoRatio,
      volatility,
      calmarRatio,
      currentStreak,
      longestWinStreak,
      longestLossStreak,
      totalEquity,
      peakEquity: this.peakEquity,
      cashPct,
      positionsPct,
    };
  }

  // ==================== GETTERS ====================

  getEquityHistory(): EquitySnapshot[] {
    return this.equityHistory;
  }

  getClosedTrades(): ClosedTrade[] {
    return this.closedTrades;
  }

  getTradeCount(): number {
    return this.trades.length;
  }

  // ==================== HELPERS ====================

  private calculateReturns(): number[] {
    if (this.equityHistory.length < 2) return [];
    const returns: number[] = [];
    for (let i = 1; i < this.equityHistory.length; i++) {
      const prev = this.equityHistory[i - 1].totalEquity;
      const curr = this.equityHistory[i].totalEquity;
      if (prev > 0) returns.push((curr - prev) / prev);
    }
    return returns;
  }

  private estimateSnapshotsPerDay(): number {
    if (this.equityHistory.length < 2) return 1;
    const first = this.equityHistory[0].timestamp;
    const last = this.equityHistory[this.equityHistory.length - 1].timestamp;
    const durationDays = Math.max((last - first) / 86400, 0.01);
    return this.equityHistory.length / durationDays;
  }

  private calculateStreaks(): { currentStreak: number; longestWinStreak: number; longestLossStreak: number } {
    let currentStreak = 0;
    let longestWinStreak = 0;
    let longestLossStreak = 0;
    let winStreak = 0;
    let lossStreak = 0;

    for (const trade of this.closedTrades) {
      if (trade.pnlUSD > 0) {
        winStreak++;
        lossStreak = 0;
        if (winStreak > longestWinStreak) longestWinStreak = winStreak;
        currentStreak = winStreak;
      } else {
        lossStreak++;
        winStreak = 0;
        if (lossStreak > longestLossStreak) longestLossStreak = lossStreak;
        currentStreak = -lossStreak;
      }
    }

    return { currentStreak, longestWinStreak, longestLossStreak };
  }

  private stdDev(arr: number[]): number {
    if (arr.length < 2) return 0;
    const m = arr.reduce((s, v) => s + v, 0) / arr.length;
    return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
  }

  // ==================== SERIALIZATION ====================

  toJSON(): string {
    return JSON.stringify({
      trades: this.trades,
      closedTrades: this.closedTrades,
      equityHistory: this.equityHistory.slice(-500),
      initialCapital: this.initialCapital,
      peakEquity: this.peakEquity,
      openBuys: Object.fromEntries(this.openBuys),
    });
  }

  static fromJSON(json: string): PnLTracker {
    try {
      const data = JSON.parse(json);
      const tracker = new PnLTracker(data.initialCapital);
      tracker.trades = data.trades || [];
      tracker.closedTrades = data.closedTrades || [];
      tracker.equityHistory = data.equityHistory || [];
      tracker.peakEquity = data.peakEquity || data.initialCapital;
      tracker.openBuys = new Map(Object.entries(data.openBuys || {}));
      return tracker;
    } catch {
      return new PnLTracker();
    }
  }
}

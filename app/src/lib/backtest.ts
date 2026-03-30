// ==================== BACKTESTING ENGINE ====================
// Simulates AI trading strategy on historical data
// Calculates: win rate, total return, max drawdown, Sharpe ratio, equity curve

import { OHLCV, RealMarketAsset, TRACKED_COINS, fetchPriceHistory, buildOHLCVFromPrices } from "./market-data";
import { makeAITradeDecision, Portfolio, PortfolioPosition, AITradeDecision } from "./ai-model";

// ==================== TYPES ====================

export interface BacktestTrade {
  timestamp: number;
  action: "BUY" | "SELL";
  symbol: string;
  coinId: string;
  amountUSD: number;
  price: number;
  units: number;
  confidence: number;
  reasoning: string;
}

export interface EquityPoint {
  timestamp: number;
  equity: number;       // total portfolio value in USD
  cashUSD: number;
  positionsUSD: number;
  drawdownPct: number;  // current drawdown from peak
}

export interface BacktestMetrics {
  totalReturn: number;          // total return %
  totalReturnUSD: number;      // absolute profit/loss USD
  annualizedReturn: number;    // annualized return %
  maxDrawdown: number;         // max drawdown %
  maxDrawdownUSD: number;      // max drawdown in USD
  sharpeRatio: number;         // Sharpe ratio (annualized)
  sortinoRatio: number;        // Sortino ratio (downside risk only)
  winRate: number;             // % of profitable trades
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  avgWinUSD: number;           // average winning trade USD
  avgLossUSD: number;          // average losing trade USD
  profitFactor: number;        // gross profit / gross loss
  avgHoldingPeriodHours: number;
  bestTrade: number;           // best single trade return %
  worstTrade: number;          // worst single trade return %
  volatility: number;          // annualized volatility %
}

export interface BacktestResult {
  metrics: BacktestMetrics;
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
  startDate: Date;
  endDate: Date;
  initialCapital: number;
  finalCapital: number;
  strategy: number;
  coinsAnalyzed: string[];
  durationDays: number;
}

export interface BacktestConfig {
  initialCapital: number;    // starting USD
  strategy: number;          // 0=conservative, 1=moderate, 2=aggressive
  days: number;              // lookback period (30, 60, 90)
  coins: string[];           // CoinGecko IDs to test
  candleIntervalMin: number; // candle interval in minutes (60 = 1h)
  stepSize: number;          // how many candles to advance per step
}

export const DEFAULT_BACKTEST_CONFIG: BacktestConfig = {
  initialCapital: 10000,
  strategy: 1,
  days: 30,
  coins: TRACKED_COINS.map((c) => c.id),
  candleIntervalMin: 60,   // 1-hour candles
  stepSize: 4,              // analyze every 4 hours
};

// ==================== FETCH HISTORICAL DATA ====================

export async function fetchBacktestData(
  coins: string[],
  days: number,
): Promise<Record<string, OHLCV[]>> {
  const result: Record<string, OHLCV[]> = {};

  for (const coinId of coins) {
    try {
      const history = await fetchPriceHistory(coinId, days);
      if (history.prices.length > 0) {
        const candles = buildOHLCVFromPrices(history.prices, history.volumes, 60);
        result[coinId] = candles;
      }
    } catch (err) {
      console.error(`fetchBacktestData(${coinId}) error:`, err);
    }
    // Rate limit delay
    await new Promise((r) => setTimeout(r, 2500));
  }

  return result;
}

// ==================== BACKTEST ENGINE ====================

export function runBacktest(
  historicalData: Record<string, OHLCV[]>,
  config: BacktestConfig,
  onProgress?: (pct: number) => void,
): BacktestResult {
  const trades: BacktestTrade[] = [];
  const equityCurve: EquityPoint[] = [];
  let peakEquity = config.initialCapital;

  // Initialize portfolio
  let portfolio: Portfolio = {
    cashUSD: config.initialCapital,
    positions: [],
    totalValue: config.initialCapital,
  };

  // Find the common time range across all coins
  const allTimestamps = new Set<number>();
  for (const coinId of config.coins) {
    const candles = historicalData[coinId];
    if (!candles) continue;
    for (const c of candles) {
      allTimestamps.add(c.time);
    }
  }

  const sortedTimestamps = Array.from(allTimestamps).sort((a, b) => a - b);
  if (sortedTimestamps.length === 0) {
    return emptyResult(config);
  }

  // We need at least 30 candles of warmup for indicators
  const WARMUP_CANDLES = 30;
  const totalSteps = Math.floor((sortedTimestamps.length - WARMUP_CANDLES) / config.stepSize);

  // Iterate through time
  for (let step = 0; step < totalSteps; step++) {
    const candleIdx = WARMUP_CANDLES + step * config.stepSize;
    if (candleIdx >= sortedTimestamps.length) break;

    const currentTime = sortedTimestamps[candleIdx];

    // Build market assets for this point in time
    const assets: RealMarketAsset[] = [];
    const candlesMap: Record<string, OHLCV[]> = {};

    for (const coinId of config.coins) {
      const allCandles = historicalData[coinId];
      if (!allCandles) continue;

      // Get candles up to current time
      const visibleCandles = allCandles.filter((c) => c.time <= currentTime);
      if (visibleCandles.length < WARMUP_CANDLES) continue;

      const currentCandle = visibleCandles[visibleCandles.length - 1];
      const prevCandle = visibleCandles.length > 24 ? visibleCandles[visibleCandles.length - 25] : visibleCandles[0];

      // Build a mock RealMarketAsset for this timestamp
      const coinInfo = TRACKED_COINS.find((c) => c.id === coinId);
      const priceChange24h = currentCandle.close - prevCandle.close;
      const priceChangePct24h = prevCandle.close > 0 ? (priceChange24h / prevCandle.close) * 100 : 0;

      // Calculate 24h high/low
      const last24Candles = visibleCandles.slice(-24);
      const high24h = Math.max(...last24Candles.map((c) => c.high));
      const low24h = Math.min(...last24Candles.map((c) => c.low));

      assets.push({
        id: coinId,
        symbol: coinInfo?.symbol || coinId.toUpperCase(),
        name: coinInfo?.name || coinId,
        currentPrice: currentCandle.close,
        priceChange24h,
        priceChangePercent24h: priceChangePct24h,
        marketCap: 0,
        totalVolume: last24Candles.reduce((s, c) => s + c.volume, 0),
        high24h,
        low24h,
        circulatingSupply: 0,
        sparkline7d: visibleCandles.slice(-168).map((c) => c.close),
        ohlcHistory: visibleCandles,
        lastUpdated: currentTime * 1000,
      });

      candlesMap[coinId] = visibleCandles;
    }

    if (assets.length === 0) continue;

    // Update positions with current prices
    portfolio.positions = portfolio.positions.map((pos) => {
      const asset = assets.find((a) => a.id === pos.coinId);
      if (!asset) return pos;
      return {
        ...pos,
        currentPrice: asset.currentPrice,
        unrealizedPnL: (asset.currentPrice - pos.avgBuyPrice) * pos.amount,
        unrealizedPnLPct: pos.avgBuyPrice > 0 ? ((asset.currentPrice - pos.avgBuyPrice) / pos.avgBuyPrice) * 100 : 0,
      };
    });

    // Calculate total portfolio value
    const positionsValue = portfolio.positions.reduce((s, p) => s + p.amount * p.currentPrice, 0);
    portfolio.totalValue = portfolio.cashUSD + positionsValue;

    // Run AI on each asset — pick the best decision
    const decisions: AITradeDecision[] = [];
    for (const asset of assets) {
      const candles = candlesMap[asset.id];
      if (!candles || candles.length < WARMUP_CANDLES) continue;
      const decision = makeAITradeDecision(asset, candles, portfolio, config.strategy);
      decisions.push(decision);
    }

    // Sort: sells first, then buys by confidence
    decisions.sort((a, b) => {
      if (a.action === "SELL" && b.action !== "SELL") return -1;
      if (b.action === "SELL" && a.action !== "SELL") return 1;
      if (a.action === "BUY" && b.action === "BUY") return b.confidence - a.confidence;
      if (a.action === "BUY") return -1;
      if (b.action === "BUY") return 1;
      return 0;
    });

    // Execute top decision
    const topDecision = decisions.find((d) => d.action !== "HOLD");
    if (topDecision) {
      if (topDecision.action === "BUY" && topDecision.amountUSD > 0) {
        const buyAmount = Math.min(topDecision.amountUSD, portfolio.cashUSD);
        if (buyAmount >= 1) {
          const units = buyAmount / topDecision.currentPrice;
          portfolio.cashUSD -= buyAmount;

          const ex = portfolio.positions.find((p) => p.coinId === topDecision.coinId);
          if (ex) {
            const newAmount = ex.amount + units;
            const newAvg = (ex.avgBuyPrice * ex.amount + topDecision.currentPrice * units) / newAmount;
            ex.amount = newAmount;
            ex.avgBuyPrice = newAvg;
            ex.currentPrice = topDecision.currentPrice;
            ex.unrealizedPnL = (topDecision.currentPrice - newAvg) * newAmount;
            ex.unrealizedPnLPct = ((topDecision.currentPrice - newAvg) / newAvg) * 100;
          } else {
            portfolio.positions.push({
              symbol: topDecision.symbol,
              coinId: topDecision.coinId,
              amount: units,
              avgBuyPrice: topDecision.currentPrice,
              currentPrice: topDecision.currentPrice,
              unrealizedPnL: 0,
              unrealizedPnLPct: 0,
            });
          }

          trades.push({
            timestamp: currentTime,
            action: "BUY",
            symbol: topDecision.symbol,
            coinId: topDecision.coinId,
            amountUSD: buyAmount,
            price: topDecision.currentPrice,
            units,
            confidence: topDecision.confidence,
            reasoning: topDecision.reasoning,
          });
        }
      } else if (topDecision.action === "SELL" && topDecision.amountUSD > 0) {
        const pos = portfolio.positions.find((p) => p.coinId === topDecision.coinId);
        if (pos) {
          const sellUnits = Math.min(topDecision.amountUSD / topDecision.currentPrice, pos.amount);
          const sellUSD = sellUnits * topDecision.currentPrice;
          portfolio.cashUSD += sellUSD;
          pos.amount -= sellUnits;

          if (pos.amount < 0.0001) {
            portfolio.positions = portfolio.positions.filter((p) => p.coinId !== topDecision.coinId);
          }

          trades.push({
            timestamp: currentTime,
            action: "SELL",
            symbol: topDecision.symbol,
            coinId: topDecision.coinId,
            amountUSD: sellUSD,
            price: topDecision.currentPrice,
            units: sellUnits,
            confidence: topDecision.confidence,
            reasoning: topDecision.reasoning,
          });
        }
      }
    }

    // Recalculate total value
    const newPosValue = portfolio.positions.reduce((s, p) => s + p.amount * p.currentPrice, 0);
    portfolio.totalValue = portfolio.cashUSD + newPosValue;

    // Track equity
    if (portfolio.totalValue > peakEquity) peakEquity = portfolio.totalValue;
    const drawdownPct = peakEquity > 0 ? ((peakEquity - portfolio.totalValue) / peakEquity) * 100 : 0;

    equityCurve.push({
      timestamp: currentTime,
      equity: portfolio.totalValue,
      cashUSD: portfolio.cashUSD,
      positionsUSD: newPosValue,
      drawdownPct,
    });

    // Progress callback
    if (onProgress) {
      onProgress(Math.round((step / totalSteps) * 100));
    }
  }

  // Calculate metrics
  const metrics = calculateMetrics(trades, equityCurve, config.initialCapital, portfolio.totalValue);

  const startDate = sortedTimestamps.length > 0 ? new Date(sortedTimestamps[0] * 1000) : new Date();
  const endDate = sortedTimestamps.length > 0 ? new Date(sortedTimestamps[sortedTimestamps.length - 1] * 1000) : new Date();

  return {
    metrics,
    trades,
    equityCurve,
    startDate,
    endDate,
    initialCapital: config.initialCapital,
    finalCapital: portfolio.totalValue,
    strategy: config.strategy,
    coinsAnalyzed: config.coins,
    durationDays: Math.round((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)),
  };
}

// ==================== METRICS CALCULATION ====================

function calculateMetrics(
  trades: BacktestTrade[],
  equityCurve: EquityPoint[],
  initialCapital: number,
  finalCapital: number,
): BacktestMetrics {
  const totalReturnUSD = finalCapital - initialCapital;
  const totalReturn = initialCapital > 0 ? (totalReturnUSD / initialCapital) * 100 : 0;

  // Duration in years
  const durationMs = equityCurve.length > 1
    ? (equityCurve[equityCurve.length - 1].timestamp - equityCurve[0].timestamp) * 1000
    : 1;
  const durationYears = Math.max(durationMs / (365.25 * 24 * 60 * 60 * 1000), 0.01);

  // Annualized return
  const annualizedReturn = initialCapital > 0
    ? (Math.pow(finalCapital / initialCapital, 1 / durationYears) - 1) * 100
    : 0;

  // Max drawdown
  let maxDrawdown = 0;
  let maxDrawdownUSD = 0;
  let peak = initialCapital;
  for (const pt of equityCurve) {
    if (pt.equity > peak) peak = pt.equity;
    const dd = peak > 0 ? ((peak - pt.equity) / peak) * 100 : 0;
    const ddUSD = peak - pt.equity;
    if (dd > maxDrawdown) {
      maxDrawdown = dd;
      maxDrawdownUSD = ddUSD;
    }
  }

  // Win/loss analysis — pair BUYs with subsequent SELLs
  const completedTrades = pairTrades(trades);
  const winningTrades = completedTrades.filter((t) => t.pnl > 0);
  const losingTrades = completedTrades.filter((t) => t.pnl <= 0);

  const totalTrades = completedTrades.length;
  const winRate = totalTrades > 0 ? (winningTrades.length / totalTrades) * 100 : 0;

  const grossProfit = winningTrades.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losingTrades.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  const avgWinUSD = winningTrades.length > 0 ? grossProfit / winningTrades.length : 0;
  const avgLossUSD = losingTrades.length > 0 ? grossLoss / losingTrades.length : 0;

  const bestTrade = completedTrades.length > 0
    ? Math.max(...completedTrades.map((t) => t.returnPct))
    : 0;
  const worstTrade = completedTrades.length > 0
    ? Math.min(...completedTrades.map((t) => t.returnPct))
    : 0;

  const avgHoldingPeriodHours = completedTrades.length > 0
    ? completedTrades.reduce((s, t) => s + t.holdingHours, 0) / completedTrades.length
    : 0;

  // Sharpe & Sortino from equity curve daily returns
  const dailyReturns = calculateDailyReturns(equityCurve);
  const avgReturn = dailyReturns.length > 0 ? dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length : 0;
  const returnStdDev = stdDev(dailyReturns);
  const downsideReturns = dailyReturns.filter((r) => r < 0);
  const downsideStdDev = stdDev(downsideReturns);

  // Annualize: multiply by sqrt(365) for daily data
  const annFactor = Math.sqrt(365);
  const sharpeRatio = returnStdDev > 0 ? (avgReturn / returnStdDev) * annFactor : 0;
  const sortinoRatio = downsideStdDev > 0 ? (avgReturn / downsideStdDev) * annFactor : 0;
  const volatility = returnStdDev * annFactor * 100;

  return {
    totalReturn,
    totalReturnUSD,
    annualizedReturn,
    maxDrawdown,
    maxDrawdownUSD,
    sharpeRatio,
    sortinoRatio,
    winRate,
    totalTrades,
    winningTrades: winningTrades.length,
    losingTrades: losingTrades.length,
    avgWinUSD,
    avgLossUSD,
    profitFactor,
    avgHoldingPeriodHours,
    bestTrade,
    worstTrade,
    volatility,
  };
}

// ==================== TRADE PAIRING ====================

interface PairedTrade {
  buyTime: number;
  sellTime: number;
  symbol: string;
  buyPrice: number;
  sellPrice: number;
  units: number;
  pnl: number;
  returnPct: number;
  holdingHours: number;
}

function pairTrades(trades: BacktestTrade[]): PairedTrade[] {
  const paired: PairedTrade[] = [];
  // Track open buy positions per coin
  const openBuys: Record<string, { timestamp: number; price: number; units: number }[]> = {};

  for (const trade of trades) {
    if (trade.action === "BUY") {
      if (!openBuys[trade.coinId]) openBuys[trade.coinId] = [];
      openBuys[trade.coinId].push({
        timestamp: trade.timestamp,
        price: trade.price,
        units: trade.units,
      });
    } else if (trade.action === "SELL") {
      const buys = openBuys[trade.coinId];
      if (!buys || buys.length === 0) continue;

      // FIFO: match with the oldest buy
      let remainingSellUnits = trade.units;
      while (remainingSellUnits > 0.0001 && buys.length > 0) {
        const buy = buys[0];
        const matchUnits = Math.min(remainingSellUnits, buy.units);
        const pnl = matchUnits * (trade.price - buy.price);
        const returnPct = buy.price > 0 ? ((trade.price - buy.price) / buy.price) * 100 : 0;
        const holdingHours = (trade.timestamp - buy.timestamp) / 3600;

        paired.push({
          buyTime: buy.timestamp,
          sellTime: trade.timestamp,
          symbol: trade.symbol,
          buyPrice: buy.price,
          sellPrice: trade.price,
          units: matchUnits,
          pnl,
          returnPct,
          holdingHours: Math.max(0, holdingHours),
        });

        buy.units -= matchUnits;
        remainingSellUnits -= matchUnits;

        if (buy.units < 0.0001) {
          buys.shift();
        }
      }
    }
  }

  return paired;
}

// ==================== HELPERS ====================

function calculateDailyReturns(equityCurve: EquityPoint[]): number[] {
  if (equityCurve.length < 2) return [];

  const returns: number[] = [];
  // Group by day
  const dayBuckets: Record<number, number> = {};
  for (const pt of equityCurve) {
    const dayKey = Math.floor(pt.timestamp / 86400);
    dayBuckets[dayKey] = pt.equity;
  }

  const days = Object.keys(dayBuckets).map(Number).sort((a, b) => a - b);
  for (let i = 1; i < days.length; i++) {
    const prevEquity = dayBuckets[days[i - 1]];
    const currEquity = dayBuckets[days[i]];
    if (prevEquity > 0) {
      returns.push((currEquity - prevEquity) / prevEquity);
    }
  }

  return returns;
}

function stdDev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = arr.reduce((s, v) => s + v, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}

function emptyResult(config: BacktestConfig): BacktestResult {
  return {
    metrics: {
      totalReturn: 0, totalReturnUSD: 0, annualizedReturn: 0,
      maxDrawdown: 0, maxDrawdownUSD: 0,
      sharpeRatio: 0, sortinoRatio: 0,
      winRate: 0, totalTrades: 0, winningTrades: 0, losingTrades: 0,
      avgWinUSD: 0, avgLossUSD: 0, profitFactor: 0,
      avgHoldingPeriodHours: 0, bestTrade: 0, worstTrade: 0, volatility: 0,
    },
    trades: [],
    equityCurve: [],
    startDate: new Date(),
    endDate: new Date(),
    initialCapital: config.initialCapital,
    finalCapital: config.initialCapital,
    strategy: config.strategy,
    coinsAnalyzed: config.coins,
    durationDays: 0,
  };
}

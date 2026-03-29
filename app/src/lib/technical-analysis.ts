// ==================== TECHNICAL ANALYSIS ENGINE ====================
// Implements proven trading indicators and pattern recognition
// Based on established financial analysis methodologies

import { OHLCV } from "./market-data";

// ==================== BASIC MATH HELPERS ====================

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stdDev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}

// ==================== MOVING AVERAGES ====================

export function SMA(closes: number[], period: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { result.push(NaN); continue; }
    const slice = closes.slice(i - period + 1, i + 1);
    result.push(mean(slice));
  }
  return result;
}

export function EMA(closes: number[], period: number): number[] {
  const result: number[] = [];
  const k = 2 / (period + 1);
  let ema = NaN;
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { result.push(NaN); continue; }
    if (i === period - 1) {
      ema = mean(closes.slice(0, period));
      result.push(ema);
      continue;
    }
    ema = closes[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

// ==================== RSI (Relative Strength Index) ====================
// Standard 14-period RSI. Values: 0-100
// >70 = overbought (sell signal), <30 = oversold (buy signal)

export function RSI(closes: number[], period: number = 14): number[] {
  const result: number[] = [];
  if (closes.length < period + 1) return closes.map(() => NaN);

  let avgGain = 0;
  let avgLoss = 0;

  // First calculation uses simple average
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = 0; i < period; i++) result.push(NaN);

  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  result.push(100 - 100 / (1 + rs));

  // Subsequent values use exponential smoothing (Wilder's)
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rs2 = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result.push(100 - 100 / (1 + rs2));
  }
  return result;
}

// ==================== MACD (Moving Average Convergence Divergence) ====================
// Standard: EMA(12) - EMA(26), Signal: EMA(9) of MACD
// Histogram > 0 = bullish momentum, < 0 = bearish

export interface MACDResult {
  macd: number[];
  signal: number[];
  histogram: number[];
}

export function MACD(closes: number[], fast: number = 12, slow: number = 26, sig: number = 9): MACDResult {
  const emaFast = EMA(closes, fast);
  const emaSlow = EMA(closes, slow);

  const macdLine: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (isNaN(emaFast[i]) || isNaN(emaSlow[i])) { macdLine.push(NaN); continue; }
    macdLine.push(emaFast[i] - emaSlow[i]);
  }

  // Signal line = EMA of MACD values (ignoring NaN)
  const validMacd = macdLine.filter((v) => !isNaN(v));
  const signalVals = EMA(validMacd, sig);

  // Map signal back to full array
  const signal: number[] = [];
  let si = 0;
  for (let i = 0; i < macdLine.length; i++) {
    if (isNaN(macdLine[i])) { signal.push(NaN); continue; }
    signal.push(signalVals[si] ?? NaN);
    si++;
  }

  const histogram = macdLine.map((m, i) => (isNaN(m) || isNaN(signal[i])) ? NaN : m - signal[i]);

  return { macd: macdLine, signal, histogram };
}

// ==================== BOLLINGER BANDS ====================
// Standard: SMA(20) ± 2*StdDev
// Price near upper band = overbought, near lower = oversold

export interface BollingerResult {
  upper: number[];
  middle: number[];
  lower: number[];
  bandwidth: number[];  // (upper - lower) / middle — volatility measure
  percentB: number[];   // (price - lower) / (upper - lower) — position within bands
}

export function BollingerBands(closes: number[], period: number = 20, mult: number = 2): BollingerResult {
  const middle = SMA(closes, period);
  const upper: number[] = [];
  const lower: number[] = [];
  const bandwidth: number[] = [];
  const percentB: number[] = [];

  for (let i = 0; i < closes.length; i++) {
    if (isNaN(middle[i])) {
      upper.push(NaN); lower.push(NaN); bandwidth.push(NaN); percentB.push(NaN);
      continue;
    }
    const slice = closes.slice(Math.max(0, i - period + 1), i + 1);
    const sd = stdDev(slice);
    const u = middle[i] + mult * sd;
    const l = middle[i] - mult * sd;
    upper.push(u);
    lower.push(l);
    bandwidth.push(middle[i] !== 0 ? (u - l) / middle[i] : 0);
    percentB.push((u - l) !== 0 ? (closes[i] - l) / (u - l) : 0.5);
  }

  return { upper, middle, lower, bandwidth, percentB };
}

// ==================== STOCHASTIC OSCILLATOR ====================
// %K and %D lines, 0-100. >80 = overbought, <20 = oversold

export interface StochasticResult {
  k: number[];
  d: number[];
}

export function Stochastic(highs: number[], lows: number[], closes: number[], kPeriod: number = 14, dPeriod: number = 3): StochasticResult {
  const kValues: number[] = [];

  for (let i = 0; i < closes.length; i++) {
    if (i < kPeriod - 1) { kValues.push(NaN); continue; }
    const highSlice = highs.slice(i - kPeriod + 1, i + 1);
    const lowSlice = lows.slice(i - kPeriod + 1, i + 1);
    const hh = Math.max(...highSlice);
    const ll = Math.min(...lowSlice);
    kValues.push(hh === ll ? 50 : ((closes[i] - ll) / (hh - ll)) * 100);
  }

  const dValues = SMA(kValues.map((v) => (isNaN(v) ? 0 : v)), dPeriod);

  return { k: kValues, d: dValues };
}

// ==================== ATR (Average True Range) ====================
// Measures volatility. Higher ATR = more volatile

export function ATR(highs: number[], lows: number[], closes: number[], period: number = 14): number[] {
  const tr: number[] = [highs[0] - lows[0]];

  for (let i = 1; i < closes.length; i++) {
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i - 1]);
    const lc = Math.abs(lows[i] - closes[i - 1]);
    tr.push(Math.max(hl, hc, lc));
  }

  const result: number[] = [];
  for (let i = 0; i < tr.length; i++) {
    if (i < period - 1) { result.push(NaN); continue; }
    if (i === period - 1) {
      result.push(mean(tr.slice(0, period)));
      continue;
    }
    result.push((result[result.length - 1] * (period - 1) + tr[i]) / period);
  }
  return result;
}

// ==================== OBV (On-Balance Volume) ====================
// Cumulative volume indicator — confirms price trends

export function OBV(closes: number[], volumes: number[]): number[] {
  const result: number[] = [volumes[0] || 0];
  for (let i = 1; i < closes.length; i++) {
    const v = volumes[i] || 0;
    if (closes[i] > closes[i - 1]) result.push(result[i - 1] + v);
    else if (closes[i] < closes[i - 1]) result.push(result[i - 1] - v);
    else result.push(result[i - 1]);
  }
  return result;
}

// ==================== ADX (Average Directional Index) ====================
// Trend strength: >25 = strong trend, <20 = weak/no trend

export function ADX(highs: number[], lows: number[], closes: number[], period: number = 14): number[] {
  if (closes.length < period * 2) return closes.map(() => NaN);

  const trArr: number[] = [];
  const plusDM: number[] = [];
  const minusDM: number[] = [];

  for (let i = 1; i < closes.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trArr.push(tr);

    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  // Smooth with Wilder's method
  const smooth = (arr: number[]): number[] => {
    const out: number[] = [];
    let s = arr.slice(0, period).reduce((a, b) => a + b, 0);
    out.push(s);
    for (let i = period; i < arr.length; i++) {
      s = s - s / period + arr[i];
      out.push(s);
    }
    return out;
  };

  const sTR = smooth(trArr);
  const sPlusDM = smooth(plusDM);
  const sMinusDM = smooth(minusDM);

  const dx: number[] = [];
  for (let i = 0; i < sTR.length; i++) {
    const plusDI = sTR[i] !== 0 ? (sPlusDM[i] / sTR[i]) * 100 : 0;
    const minusDI = sTR[i] !== 0 ? (sMinusDM[i] / sTR[i]) * 100 : 0;
    const sum = plusDI + minusDI;
    dx.push(sum !== 0 ? (Math.abs(plusDI - minusDI) / sum) * 100 : 0);
  }

  // ADX = smoothed DX
  const result: number[] = new Array(period).fill(NaN);
  if (dx.length < period) return closes.map(() => NaN);

  let adxVal = mean(dx.slice(0, period));
  result.push(adxVal);
  for (let i = period; i < dx.length; i++) {
    adxVal = (adxVal * (period - 1) + dx[i]) / period;
    result.push(adxVal);
  }

  // Pad to match original length
  while (result.length < closes.length) result.push(result[result.length - 1] || NaN);
  return result.slice(0, closes.length);
}

// ==================== SUPPORT & RESISTANCE LEVELS ====================

export interface SRLevel {
  price: number;
  strength: number; // how many times price touched this level
  type: "support" | "resistance";
}

export function findSupportResistance(highs: number[], lows: number[], closes: number[], tolerance: number = 0.02): SRLevel[] {
  const pivots: number[] = [];

  // Find local highs and lows
  for (let i = 2; i < closes.length - 2; i++) {
    if (highs[i] > highs[i - 1] && highs[i] > highs[i - 2] &&
        highs[i] > highs[i + 1] && highs[i] > highs[i + 2]) {
      pivots.push(highs[i]);
    }
    if (lows[i] < lows[i - 1] && lows[i] < lows[i - 2] &&
        lows[i] < lows[i + 1] && lows[i] < lows[i + 2]) {
      pivots.push(lows[i]);
    }
  }

  // Cluster nearby pivots
  const clusters: { price: number; count: number }[] = [];
  for (const p of pivots) {
    const existing = clusters.find((c) => Math.abs(c.price - p) / c.price < tolerance);
    if (existing) {
      existing.price = (existing.price * existing.count + p) / (existing.count + 1);
      existing.count++;
    } else {
      clusters.push({ price: p, count: 1 });
    }
  }

  const currentPrice = closes[closes.length - 1];
  return clusters
    .filter((c) => c.count >= 2)
    .map((c) => ({
      price: c.price,
      strength: c.count,
      type: c.price > currentPrice ? "resistance" as const : "support" as const,
    }))
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 6);
}

// ==================== TREND DETECTION ====================

export type TrendDirection = "strong_up" | "up" | "sideways" | "down" | "strong_down";

export function detectTrend(closes: number[]): { trend: TrendDirection; strength: number } {
  if (closes.length < 20) return { trend: "sideways", strength: 0 };

  const sma20 = SMA(closes, 20);
  const sma50 = SMA(closes, Math.min(50, closes.length));

  const last = closes.length - 1;
  const price = closes[last];
  const s20 = sma20[last];
  const s50 = sma50[last];

  if (isNaN(s20) || isNaN(s50)) return { trend: "sideways", strength: 0 };

  // Calculate slope of SMA20 over last 5 periods
  const slopeWindow = 5;
  const smaSlope = sma20[last] - sma20[Math.max(0, last - slopeWindow)];
  const slopePct = (smaSlope / sma20[Math.max(0, last - slopeWindow)]) * 100;

  const aboveS20 = price > s20;
  const aboveS50 = price > s50;
  const s20AboveS50 = s20 > s50;

  if (aboveS20 && aboveS50 && s20AboveS50 && slopePct > 1) {
    return { trend: "strong_up", strength: Math.min(1, slopePct / 3) };
  }
  if (aboveS20 && (aboveS50 || s20AboveS50)) {
    return { trend: "up", strength: Math.min(0.7, Math.abs(slopePct) / 3) };
  }
  if (!aboveS20 && !aboveS50 && !s20AboveS50 && slopePct < -1) {
    return { trend: "strong_down", strength: Math.min(1, Math.abs(slopePct) / 3) };
  }
  if (!aboveS20 && (!aboveS50 || !s20AboveS50)) {
    return { trend: "down", strength: Math.min(0.7, Math.abs(slopePct) / 3) };
  }

  return { trend: "sideways", strength: Math.min(0.3, Math.abs(slopePct) / 3) };
}

// ==================== DIVERGENCE DETECTION ====================
// RSI divergence = price makes new high/low but RSI doesn't = reversal signal

export interface Divergence {
  type: "bullish" | "bearish";
  strength: number; // 0-1
}

export function detectDivergence(closes: number[], rsiValues: number[], lookback: number = 14): Divergence | null {
  if (closes.length < lookback + 5 || rsiValues.length < lookback + 5) return null;

  const last = closes.length - 1;
  const recentCloses = closes.slice(last - lookback, last + 1);
  const recentRSI = rsiValues.slice(last - lookback, last + 1);

  // Find local lows in both
  const priceMinIdx = recentCloses.indexOf(Math.min(...recentCloses));
  const priceMaxIdx = recentCloses.indexOf(Math.max(...recentCloses));

  const validRSI = recentRSI.filter((v) => !isNaN(v));
  if (validRSI.length < 5) return null;

  const rsiMin = Math.min(...validRSI);
  const rsiMax = Math.max(...validRSI);

  const currentPrice = closes[last];
  const currentRSI = rsiValues[last];
  if (isNaN(currentRSI)) return null;

  // Bullish divergence: price at/near recent low but RSI higher than its recent low
  if (priceMinIdx >= lookback - 3 && currentRSI > rsiMin + 5) {
    return { type: "bullish", strength: Math.min(1, (currentRSI - rsiMin) / 20) };
  }

  // Bearish divergence: price at/near recent high but RSI lower than its recent high
  if (priceMaxIdx >= lookback - 3 && currentRSI < rsiMax - 5) {
    return { type: "bearish", strength: Math.min(1, (rsiMax - currentRSI) / 20) };
  }

  return null;
}

// ==================== CANDLESTICK PATTERNS ====================

export type CandlePattern = 
  | "hammer" | "inverted_hammer" | "engulfing_bullish" | "engulfing_bearish"
  | "doji" | "morning_star" | "evening_star" | "three_white_soldiers" | "three_black_crows"
  | null;

export function detectCandlePattern(candles: OHLCV[]): { pattern: CandlePattern; signal: "buy" | "sell" | "neutral" } {
  if (candles.length < 3) return { pattern: null, signal: "neutral" };

  const last = candles.length - 1;
  const c = candles[last];
  const p = candles[last - 1];
  const pp = candles[last - 2];

  const bodySize = Math.abs(c.close - c.open);
  const totalRange = c.high - c.low;
  const isGreen = c.close > c.open;
  const prevGreen = p.close > p.open;

  // Doji — very small body relative to range
  if (totalRange > 0 && bodySize / totalRange < 0.1) {
    return { pattern: "doji", signal: "neutral" };
  }

  // Hammer — small body at top, long lower shadow (bullish reversal)
  if (totalRange > 0) {
    const lowerShadow = Math.min(c.open, c.close) - c.low;
    const upperShadow = c.high - Math.max(c.open, c.close);
    if (lowerShadow > bodySize * 2 && upperShadow < bodySize * 0.5) {
      return { pattern: "hammer", signal: "buy" };
    }
    // Inverted hammer
    if (upperShadow > bodySize * 2 && lowerShadow < bodySize * 0.5 && !isGreen) {
      return { pattern: "inverted_hammer", signal: "buy" };
    }
  }

  // Engulfing patterns
  if (isGreen && !prevGreen && c.open <= p.close && c.close >= p.open && bodySize > Math.abs(p.close - p.open)) {
    return { pattern: "engulfing_bullish", signal: "buy" };
  }
  if (!isGreen && prevGreen && c.open >= p.close && c.close <= p.open && bodySize > Math.abs(p.close - p.open)) {
    return { pattern: "engulfing_bearish", signal: "sell" };
  }

  // Three white soldiers
  if (candles.length >= 3) {
    const all3Green = c.close > c.open && p.close > p.open && pp.close > pp.open;
    const ascending = c.close > p.close && p.close > pp.close;
    if (all3Green && ascending) {
      return { pattern: "three_white_soldiers", signal: "buy" };
    }
  }

  // Three black crows
  if (candles.length >= 3) {
    const all3Red = c.close < c.open && p.close < p.open && pp.close < pp.open;
    const descending = c.close < p.close && p.close < pp.close;
    if (all3Red && descending) {
      return { pattern: "three_black_crows", signal: "sell" };
    }
  }

  return { pattern: null, signal: "neutral" };
}

// ==================== VOLUME ANALYSIS ====================

export interface VolumeSignal {
  volumeTrend: "increasing" | "decreasing" | "stable";
  priceVolumeConfirm: boolean; // volume confirms price direction
  unusualVolume: boolean;       // spike > 2x average
}

export function analyzeVolume(closes: number[], volumes: number[]): VolumeSignal {
  if (volumes.length < 10) return { volumeTrend: "stable", priceVolumeConfirm: false, unusualVolume: false };

  const last = volumes.length - 1;
  const recentVol = volumes.slice(last - 4, last + 1);
  const avgVol = mean(volumes.slice(Math.max(0, last - 19), last + 1));
  const recentAvg = mean(recentVol);

  const olderAvg = mean(volumes.slice(Math.max(0, last - 9), last - 4));

  const volumeTrend = recentAvg > olderAvg * 1.2 ? "increasing" :
                      recentAvg < olderAvg * 0.8 ? "decreasing" : "stable";

  // Check if price direction matches volume direction
  const priceUp = closes[last] > closes[Math.max(0, last - 4)];
  const priceVolumeConfirm = (priceUp && volumeTrend === "increasing") ||
                             (!priceUp && volumeTrend === "increasing"); // selling pressure

  const unusualVolume = volumes[last] > avgVol * 2;

  return { volumeTrend, priceVolumeConfirm, unusualVolume };
}

// ==================== FULL TECHNICAL ANALYSIS ====================

export interface TASignal {
  name: string;
  value: number;
  signal: "buy" | "sell" | "neutral";
  strength: number; // 0-1
  description: string;
}

export interface FullAnalysis {
  signals: TASignal[];
  overallScore: number;        // -1 (strong sell) to +1 (strong buy)
  overallConfidence: number;   // 0-1
  recommendation: "STRONG_BUY" | "BUY" | "HOLD" | "SELL" | "STRONG_SELL";
  rsi: number;
  macd: { value: number; signal: number; histogram: number };
  bollinger: { upper: number; middle: number; lower: number; percentB: number };
  trend: { trend: TrendDirection; strength: number };
  supportResistance: SRLevel[];
  candlePattern: CandlePattern;
  volumeSignal: VolumeSignal;
  adx: number;
  stochastic: { k: number; d: number };
}

export function analyzeAsset(candles: OHLCV[]): FullAnalysis {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);
  const last = closes.length - 1;

  const signals: TASignal[] = [];

  // === RSI ===
  const rsiValues = RSI(closes, 14);
  const rsiNow = rsiValues[last];
  const rsiValid = !isNaN(rsiNow);
  if (rsiValid) {
    let rsiSignal: "buy" | "sell" | "neutral" = "neutral";
    let rsiStrength = 0;
    let rsiDesc = "";
    if (rsiNow < 30) {
      rsiSignal = "buy"; rsiStrength = Math.min(1, (30 - rsiNow) / 20);
      rsiDesc = `Oversold (${rsiNow.toFixed(1)}) — price likely to bounce up`;
    } else if (rsiNow > 70) {
      rsiSignal = "sell"; rsiStrength = Math.min(1, (rsiNow - 70) / 20);
      rsiDesc = `Overbought (${rsiNow.toFixed(1)}) — price likely to drop`;
    } else if (rsiNow < 45) {
      rsiSignal = "buy"; rsiStrength = 0.3;
      rsiDesc = `Leaning oversold (${rsiNow.toFixed(1)})`;
    } else if (rsiNow > 55) {
      rsiSignal = "sell"; rsiStrength = 0.3;
      rsiDesc = `Leaning overbought (${rsiNow.toFixed(1)})`;
    } else {
      rsiDesc = `Neutral zone (${rsiNow.toFixed(1)})`;
    }
    signals.push({ name: "RSI", value: rsiNow, signal: rsiSignal, strength: rsiStrength, description: rsiDesc });
  }

  // === MACD ===
  const macdResult = MACD(closes);
  const macdNow = macdResult.macd[last];
  const macdSig = macdResult.signal[last];
  const macdHist = macdResult.histogram[last];
  const macdValid = !isNaN(macdNow) && !isNaN(macdSig);
  if (macdValid) {
    const prevHist = macdResult.histogram[last - 1];
    let macdSignal: "buy" | "sell" | "neutral" = "neutral";
    let macdStrength = 0;
    let macdDesc = "";

    if (macdHist > 0 && (!isNaN(prevHist) && prevHist <= 0)) {
      macdSignal = "buy"; macdStrength = 0.8;
      macdDesc = "MACD crossed above signal — bullish crossover";
    } else if (macdHist < 0 && (!isNaN(prevHist) && prevHist >= 0)) {
      macdSignal = "sell"; macdStrength = 0.8;
      macdDesc = "MACD crossed below signal — bearish crossover";
    } else if (macdHist > 0) {
      macdSignal = "buy"; macdStrength = Math.min(0.6, Math.abs(macdHist) * 10);
      macdDesc = "MACD above signal — bullish momentum";
    } else {
      macdSignal = "sell"; macdStrength = Math.min(0.6, Math.abs(macdHist) * 10);
      macdDesc = "MACD below signal — bearish momentum";
    }
    signals.push({ name: "MACD", value: macdHist, signal: macdSignal, strength: macdStrength, description: macdDesc });
  }

  // === Bollinger Bands ===
  const bb = BollingerBands(closes);
  const bbPctB = bb.percentB[last];
  const bbValid = !isNaN(bbPctB);
  if (bbValid) {
    let bbSignal: "buy" | "sell" | "neutral" = "neutral";
    let bbStrength = 0;
    let bbDesc = "";
    if (bbPctB < 0.05) {
      bbSignal = "buy"; bbStrength = 0.8;
      bbDesc = "Price below lower Bollinger Band — extremely oversold";
    } else if (bbPctB < 0.2) {
      bbSignal = "buy"; bbStrength = 0.5;
      bbDesc = "Price near lower band — potential bounce";
    } else if (bbPctB > 0.95) {
      bbSignal = "sell"; bbStrength = 0.8;
      bbDesc = "Price above upper Bollinger Band — extremely overbought";
    } else if (bbPctB > 0.8) {
      bbSignal = "sell"; bbStrength = 0.5;
      bbDesc = "Price near upper band — potential pullback";
    } else {
      bbDesc = `Price in middle of bands (${(bbPctB * 100).toFixed(0)}%)`;
    }
    signals.push({ name: "Bollinger", value: bbPctB, signal: bbSignal, strength: bbStrength, description: bbDesc });
  }

  // === Stochastic ===
  const stoch = Stochastic(highs, lows, closes);
  const stochK = stoch.k[last];
  const stochD = stoch.d[last];
  const stochValid = !isNaN(stochK) && !isNaN(stochD);
  if (stochValid) {
    let stochSignal: "buy" | "sell" | "neutral" = "neutral";
    let stochStrength = 0;
    let stochDesc = "";
    if (stochK < 20 && stochD < 20) {
      stochSignal = "buy"; stochStrength = 0.7;
      stochDesc = `Stochastic oversold (%K=${stochK.toFixed(0)})`;
    } else if (stochK > 80 && stochD > 80) {
      stochSignal = "sell"; stochStrength = 0.7;
      stochDesc = `Stochastic overbought (%K=${stochK.toFixed(0)})`;
    } else if (stochK > stochD && stochK < 50) {
      stochSignal = "buy"; stochStrength = 0.4;
      stochDesc = `%K crossed above %D — bullish`;
    } else if (stochK < stochD && stochK > 50) {
      stochSignal = "sell"; stochStrength = 0.4;
      stochDesc = `%K crossed below %D — bearish`;
    } else {
      stochDesc = `Stochastic neutral (%K=${stochK.toFixed(0)})`;
    }
    signals.push({ name: "Stochastic", value: stochK, signal: stochSignal, strength: stochStrength, description: stochDesc });
  }

  // === ADX (trend strength) ===
  const adxValues = ADX(highs, lows, closes);
  const adxNow = adxValues[last];
  const adxValid = !isNaN(adxNow);

  // === Trend ===
  const trend = detectTrend(closes);
  {
    let trendSignal: "buy" | "sell" | "neutral" = "neutral";
    let trendStrength = trend.strength;
    let trendDesc = "";
    if (trend.trend === "strong_up") {
      trendSignal = "buy"; trendDesc = "Strong uptrend — price above both MA20 & MA50";
    } else if (trend.trend === "up") {
      trendSignal = "buy"; trendStrength *= 0.7; trendDesc = "Uptrend — price above moving averages";
    } else if (trend.trend === "strong_down") {
      trendSignal = "sell"; trendDesc = "Strong downtrend — price below both MA20 & MA50";
    } else if (trend.trend === "down") {
      trendSignal = "sell"; trendStrength *= 0.7; trendDesc = "Downtrend — price below moving averages";
    } else {
      trendDesc = "Sideways — no clear trend direction";
    }
    if (adxValid && adxNow > 25) {
      trendStrength = Math.min(1, trendStrength * 1.3);
      trendDesc += ` (ADX=${adxNow.toFixed(0)} — strong trend)`;
    }
    signals.push({ name: "Trend", value: trend.strength, signal: trendSignal, strength: trendStrength, description: trendDesc });
  }

  // === Divergence ===
  if (rsiValid) {
    const div = detectDivergence(closes, rsiValues);
    if (div) {
      signals.push({
        name: "Divergence",
        value: div.strength,
        signal: div.type === "bullish" ? "buy" : "sell",
        strength: div.strength * 0.8,
        description: div.type === "bullish"
          ? "Bullish RSI divergence — hidden buying pressure"
          : "Bearish RSI divergence — hidden selling pressure",
      });
    }
  }

  // === Candle patterns ===
  const candle = detectCandlePattern(candles);
  if (candle.pattern) {
    signals.push({
      name: "Candle",
      value: 0,
      signal: candle.signal,
      strength: 0.5,
      description: `Pattern: ${candle.pattern.replace(/_/g, " ")}`,
    });
  }

  // === Volume ===
  const volSig = analyzeVolume(closes, volumes);
  if (volSig.unusualVolume) {
    const priceUp = closes[last] > closes[Math.max(0, last - 1)];
    signals.push({
      name: "Volume",
      value: volumes[last],
      signal: priceUp ? "buy" : "sell",
      strength: 0.6,
      description: `Unusual volume spike — ${priceUp ? "strong buying" : "strong selling"} pressure`,
    });
  }

  // === Support/Resistance proximity ===
  const sr = findSupportResistance(highs, lows, closes);
  const currentPrice = closes[last];
  for (const level of sr.slice(0, 2)) {
    const dist = Math.abs(currentPrice - level.price) / currentPrice;
    if (dist < 0.03) {
      signals.push({
        name: "S/R Level",
        value: level.price,
        signal: level.type === "support" ? "buy" : "sell",
        strength: Math.min(0.7, level.strength * 0.2),
        description: `Near ${level.type} at $${level.price.toFixed(2)} (touched ${level.strength}x)`,
      });
    }
  }

  // ==================== COMBINE SIGNALS ====================
  // Weighted scoring: each signal contributes based on its strength and reliability

  const weights: Record<string, number> = {
    RSI: 1.5,
    MACD: 1.8,
    Bollinger: 1.2,
    Stochastic: 1.0,
    Trend: 2.0,
    Divergence: 1.5,
    Candle: 0.8,
    Volume: 1.0,
    "S/R Level": 1.3,
  };

  let totalScore = 0;
  let totalWeight = 0;

  for (const sig of signals) {
    const w = weights[sig.name] || 1;
    const score = sig.signal === "buy" ? sig.strength : sig.signal === "sell" ? -sig.strength : 0;
    totalScore += score * w;
    totalWeight += w;
  }

  const overallScore = totalWeight > 0 ? totalScore / totalWeight : 0;

  // Confidence = agreement between signals
  const buySignals = signals.filter((s) => s.signal === "buy").length;
  const sellSignals = signals.filter((s) => s.signal === "sell").length;
  const totalSignals = signals.length || 1;
  const agreement = Math.max(buySignals, sellSignals) / totalSignals;
  // Boost confidence: consider signal count and strength, not just pure agreement
  const avgStrength = signals.length > 0 ? signals.reduce((s, sig) => s + sig.strength, 0) / signals.length : 0;
  const overallConfidence = Math.min(1, agreement * 0.5 + Math.abs(overallScore) * 0.25 + avgStrength * 0.25);

  let recommendation: FullAnalysis["recommendation"];
  if (overallScore > 0.35) recommendation = "STRONG_BUY";
  else if (overallScore > 0.08) recommendation = "BUY";
  else if (overallScore < -0.35) recommendation = "STRONG_SELL";
  else if (overallScore < -0.08) recommendation = "SELL";
  else recommendation = "HOLD";

  return {
    signals,
    overallScore,
    overallConfidence,
    recommendation,
    rsi: rsiValid ? rsiNow : 50,
    macd: {
      value: macdValid ? macdNow : 0,
      signal: macdValid ? macdSig : 0,
      histogram: macdValid ? macdHist : 0,
    },
    bollinger: {
      upper: bbValid ? bb.upper[last] : 0,
      middle: bbValid ? bb.middle[last] : 0,
      lower: bbValid ? bb.lower[last] : 0,
      percentB: bbValid ? bbPctB : 0.5,
    },
    trend,
    supportResistance: sr,
    candlePattern: candle.pattern,
    volumeSignal: volSig,
    adx: adxValid ? adxNow : 0,
    stochastic: { k: stochValid ? stochK : 50, d: stochValid ? stochD : 50 },
  };
}

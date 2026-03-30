// ==================== TECHNICAL ANALYSIS (BOT) ====================
// Standalone TA indicators for the bot — mirrors app/src/lib/technical-analysis.ts

import { OHLCV } from "./market-data";

// ==================== HELPERS ====================

function mean(arr: number[]): number {
  return arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}

function stdDev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}

// ==================== INDICATORS ====================

export function sma(data: number[], period: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { result.push(NaN); continue; }
    result.push(mean(data.slice(i - period + 1, i + 1)));
  }
  return result;
}

export function ema(data: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = [data[0]];
  for (let i = 1; i < data.length; i++) {
    result.push(data[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

export function rsi(data: number[], period: number = 14): number[] {
  const result: number[] = new Array(data.length).fill(NaN);
  if (data.length < period + 1) return result;

  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = data[i] - data[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;

  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < data.length; i++) {
    const d = data[i] - data[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return result;
}

export function macd(data: number[]): { macd: number[]; signal: number[]; histogram: number[] } {
  const ema12 = ema(data, 12);
  const ema26 = ema(data, 26);
  const macdLine = ema12.map((v, i) => v - ema26[i]);
  const signalLine = ema(macdLine, 9);
  const hist = macdLine.map((v, i) => v - signalLine[i]);
  return { macd: macdLine, signal: signalLine, histogram: hist };
}

export function bollingerBands(data: number[], period: number = 20, mult: number = 2): { upper: number[]; middle: number[]; lower: number[] } {
  const mid = sma(data, period);
  const upper: number[] = [];
  const lower: number[] = [];

  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { upper.push(NaN); lower.push(NaN); continue; }
    const slice = data.slice(i - period + 1, i + 1);
    const sd = stdDev(slice);
    upper.push(mid[i] + mult * sd);
    lower.push(mid[i] - mult * sd);
  }
  return { upper, middle: mid, lower };
}

export function atr(candles: OHLCV[], period: number = 14): number[] {
  const result: number[] = [candles[0].high - candles[0].low];
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    );
    result.push(tr);
  }

  const atrVals: number[] = new Array(result.length).fill(NaN);
  if (result.length >= period) {
    atrVals[period - 1] = mean(result.slice(0, period));
    for (let i = period; i < result.length; i++) {
      atrVals[i] = (atrVals[i - 1] * (period - 1) + result[i]) / period;
    }
  }
  return atrVals;
}

export function obv(candles: OHLCV[]): number[] {
  const result: number[] = [0];
  for (let i = 1; i < candles.length; i++) {
    const vol = candles[i].volume || 1;
    if (candles[i].close > candles[i - 1].close) result.push(result[i - 1] + vol);
    else if (candles[i].close < candles[i - 1].close) result.push(result[i - 1] - vol);
    else result.push(result[i - 1]);
  }
  return result;
}

export function stochastic(candles: OHLCV[], period: number = 14): { k: number[]; d: number[] } {
  const kVals: number[] = new Array(candles.length).fill(NaN);
  for (let i = period - 1; i < candles.length; i++) {
    const slice = candles.slice(i - period + 1, i + 1);
    const hi = Math.max(...slice.map((c) => c.high));
    const lo = Math.min(...slice.map((c) => c.low));
    kVals[i] = hi !== lo ? ((candles[i].close - lo) / (hi - lo)) * 100 : 50;
  }
  const dVals = sma(kVals.map((v) => (isNaN(v) ? 50 : v)), 3);
  return { k: kVals, d: dVals };
}

export function adx(candles: OHLCV[], period: number = 14): number[] {
  if (candles.length < period * 2) return new Array(candles.length).fill(NaN);

  const plusDM: number[] = [];
  const minusDM: number[] = [];
  const tr: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    ));
  }

  const smoothTR = ema(tr, period);
  const smoothPlusDM = ema(plusDM, period);
  const smoothMinusDM = ema(minusDM, period);

  const dx: number[] = [];
  for (let i = 0; i < smoothTR.length; i++) {
    const plusDI = smoothTR[i] > 0 ? (smoothPlusDM[i] / smoothTR[i]) * 100 : 0;
    const minusDI = smoothTR[i] > 0 ? (smoothMinusDM[i] / smoothTR[i]) * 100 : 0;
    const sum = plusDI + minusDI;
    dx.push(sum > 0 ? (Math.abs(plusDI - minusDI) / sum) * 100 : 0);
  }

  const adxVals = ema(dx, period);
  const result = new Array(candles.length).fill(NaN);
  for (let i = 0; i < adxVals.length; i++) {
    result[i + 1] = adxVals[i];
  }
  return result;
}

// ==================== FULL ANALYSIS ====================

export type TASignal = "BUY" | "SELL" | "NEUTRAL";

export interface FullAnalysis {
  rsi: number;
  macdHist: number;
  sma20: number;
  ema12: number;
  bbPosition: number;
  atr: number;
  stochK: number;
  adx: number;
  obv: number;
  signals: { name: string; signal: TASignal; weight: number }[];
  compositeScore: number;
}

export function analyzeCandles(candles: OHLCV[]): FullAnalysis {
  const closes = candles.map((c) => c.close);
  const last = closes.length - 1;

  const rsiVals = rsi(closes);
  const macdResult = macd(closes);
  const bb = bollingerBands(closes);
  const sma20 = sma(closes, 20);
  const ema12Vals = ema(closes, 12);
  const atrVals = atr(candles);
  const stoch = stochastic(candles);
  const adxVals = adx(candles);
  const obvVals = obv(candles);

  const curRsi = rsiVals[last] || 50;
  const curMacdHist = macdResult.histogram[last] || 0;
  const curSma20 = sma20[last] || closes[last];
  const curEma12 = ema12Vals[last] || closes[last];
  const curAtr = atrVals[last] || 0;
  const curStochK = stoch.k[last] || 50;
  const curAdx = adxVals[last] || 20;
  const curObv = obvVals[last] || 0;
  const prevObv = obvVals[last - 1] || 0;

  // Bollinger Band position (0=lower, 1=upper)
  const bbUpper = bb.upper[last] || closes[last] + 1;
  const bbLower = bb.lower[last] || closes[last] - 1;
  const bbPos = (bbUpper - bbLower) > 0 ? (closes[last] - bbLower) / (bbUpper - bbLower) : 0.5;

  // Signal generation
  const signals: { name: string; signal: TASignal; weight: number }[] = [];

  // RSI
  signals.push({ name: "RSI", signal: curRsi < 30 ? "BUY" : curRsi > 70 ? "SELL" : "NEUTRAL", weight: 1.5 });
  // MACD
  signals.push({ name: "MACD", signal: curMacdHist > 0 ? "BUY" : curMacdHist < 0 ? "SELL" : "NEUTRAL", weight: 1.5 });
  // SMA Cross
  signals.push({ name: "SMA20", signal: closes[last] > curSma20 ? "BUY" : "SELL", weight: 1.0 });
  // EMA Trend
  signals.push({ name: "EMA12", signal: closes[last] > curEma12 ? "BUY" : "SELL", weight: 1.0 });
  // BB
  signals.push({ name: "BB", signal: bbPos < 0.2 ? "BUY" : bbPos > 0.8 ? "SELL" : "NEUTRAL", weight: 1.0 });
  // Stoch
  signals.push({ name: "Stoch", signal: curStochK < 20 ? "BUY" : curStochK > 80 ? "SELL" : "NEUTRAL", weight: 1.0 });
  // ADX
  signals.push({ name: "ADX", signal: curAdx > 25 ? (curMacdHist > 0 ? "BUY" : "SELL") : "NEUTRAL", weight: 0.8 });
  // OBV
  signals.push({ name: "OBV", signal: curObv > prevObv ? "BUY" : curObv < prevObv ? "SELL" : "NEUTRAL", weight: 0.7 });
  // ATR Volatility
  const atrPct = closes[last] > 0 ? (curAtr / closes[last]) * 100 : 0;
  signals.push({ name: "ATR", signal: atrPct > 5 ? "SELL" : atrPct < 2 ? "BUY" : "NEUTRAL", weight: 0.5 });

  // Composite score: -1 to +1
  let totalWeight = 0;
  let weightedScore = 0;
  for (const s of signals) {
    totalWeight += s.weight;
    weightedScore += (s.signal === "BUY" ? 1 : s.signal === "SELL" ? -1 : 0) * s.weight;
  }
  const compositeScore = totalWeight > 0 ? weightedScore / totalWeight : 0;

  return {
    rsi: curRsi,
    macdHist: curMacdHist,
    sma20: curSma20,
    ema12: curEma12,
    bbPosition: bbPos,
    atr: curAtr,
    stochK: curStochK,
    adx: curAdx,
    obv: curObv,
    signals,
    compositeScore,
  };
}

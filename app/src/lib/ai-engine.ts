// ==================== AI DECISION ENGINE ====================

export interface MarketData {
  token: string;
  tokenId: number;
  price: number;
  previousPrice: number;
  volatility: number;
  trend: "up" | "down" | "sideways";
  timestamp: number;
}

export interface AIDecision {
  action: "BUY" | "SELL" | "HOLD";
  tokenId: number;
  token: string;
  amount: number;
  price: number;
  priceChange: number; // % change e.g. 2.31 or -1.5
  confidence: number;
  reasoning: string;
}

export interface AILogEntry {
  id: string;
  timestamp: number;
  marketData: MarketData;
  decision: AIDecision;
}

// ==================== MARKET CATEGORIES ====================

export type MarketCategory = "crypto" | "realestate" | "stocks" | "commodities";

export const MARKET_CATEGORIES: MarketCategory[] = ["crypto", "realestate", "stocks", "commodities"];

// Assets per category
export const CATEGORY_ASSETS: Record<MarketCategory, { id: number; name: string; vol: number; floor: number; start: number }[]> = {
  crypto: [
    { id: 0, name: "SOL",  vol: 0.05, floor: 10_000_000,  start: 100_000_000 },
    { id: 1, name: "BONK", vol: 0.08, floor: 100_000,     start: 1_000_000 },
    { id: 2, name: "JUP",  vol: 0.06, floor: 5_000_000,   start: 50_000_000 },
  ],
  realestate: [
    { id: 10, name: "NYC Apt",      vol: 0.02, floor: 300_000_000, start: 500_000_000 },
    { id: 11, name: "Dubai Villa",   vol: 0.03, floor: 600_000_000, start: 900_000_000 },
    { id: 12, name: "London Office", vol: 0.025, floor: 400_000_000, start: 700_000_000 },
  ],
  stocks: [
    { id: 20, name: "AAPL",  vol: 0.03, floor: 100_000_000, start: 175_000_000 },
    { id: 21, name: "TSLA",  vol: 0.06, floor: 50_000_000,  start: 250_000_000 },
    { id: 22, name: "NVDA",  vol: 0.05, floor: 80_000_000,  start: 130_000_000 },
  ],
  commodities: [
    { id: 30, name: "Gold",  vol: 0.02, floor: 150_000_000, start: 200_000_000 },
    { id: 31, name: "Oil",   vol: 0.04, floor: 40_000_000,  start: 80_000_000 },
    { id: 32, name: "Silver", vol: 0.03, floor: 20_000_000, start: 30_000_000 },
  ],
};

// Token name lookup (all categories)
export const TOKENS: Record<number, string> = {};
for (const cat of MARKET_CATEGORIES) {
  for (const a of CATEGORY_ASSETS[cat]) {
    TOKENS[a.id] = a.name;
  }
}

// ==================== MOCK PRICE STATE ====================

const prices: Record<number, number> = {};

export interface PricePoint {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
}

const priceHistory: Record<number, PricePoint[]> = {};
const MAX_HISTORY = 200;

export function getPriceHistory(tokenId: number): PricePoint[] {
  return priceHistory[tokenId] || [];
}

function addPricePoint(tokenId: number, prev: number, cur: number) {
  if (!priceHistory[tokenId]) priceHistory[tokenId] = [];
  const now = Math.floor(Date.now() / 1000);
  const h = priceHistory[tokenId];
  // merge into same-second candle or create new
  if (h.length > 0 && h[h.length - 1].time === now) {
    const c = h[h.length - 1];
    c.close = cur;
    c.high = Math.max(c.high, cur);
    c.low = Math.min(c.low, cur);
  } else {
    h.push({ time: now, open: prev, high: Math.max(prev, cur), low: Math.min(prev, cur), close: cur });
  }
  if (h.length > MAX_HISTORY) h.splice(0, h.length - MAX_HISTORY);
}

function randomChange(vol: number): number {
  const time = Date.now() / 10000;
  const trend = Math.sin(time) * 0.015;
  const noise = (Math.random() - 0.5) * vol;
  return trend + noise;
}

function seedHistory(category: MarketCategory) {
  const assets = CATEGORY_ASSETS[category];
  for (const a of assets) {
    if (priceHistory[a.id] && priceHistory[a.id].length > 5) continue;
    let p = a.start;
    const now = Math.floor(Date.now() / 1000);
    const pts: PricePoint[] = [];
    for (let i = 60; i >= 1; i--) {
      const prev = p;
      p = Math.max(a.floor, Math.round(p * (1 + randomChange(a.vol))));
      pts.push({
        time: now - i * 3,
        open: prev,
        high: Math.max(prev, p),
        low: Math.min(prev, p),
        close: p,
      });
    }
    priceHistory[a.id] = pts;
    prices[a.id] = p;
  }
}

function initPrices(category: MarketCategory) {
  for (const a of CATEGORY_ASSETS[category]) {
    if (prices[a.id] === undefined) {
      prices[a.id] = a.start;
    }
  }
  seedHistory(category);
}

export function getMarketData(category: MarketCategory): MarketData[] {
  initPrices(category);
  const assets = CATEGORY_ASSETS[category];

  return assets.map((a) => {
    const prev = prices[a.id];
    prices[a.id] = Math.max(a.floor, Math.round(prev * (1 + randomChange(a.vol))));
    const cur = prices[a.id];
    addPricePoint(a.id, prev, cur);
    return {
      token: a.name,
      tokenId: a.id,
      price: cur,
      previousPrice: prev,
      volatility: a.vol,
      trend: cur > prev ? "up" : cur < prev ? "down" : "sideways",
      timestamp: Date.now(),
    };
  });
}

// ==================== AI DECISION LOGIC ====================

export function makeAIDecision(
  marketData: MarketData[],
  strategy: number,
  balance: number,
  positions: { tokenId: number; amount: number; avgPrice: number }[]
): AIDecision {
  let bestSignal: MarketData | null = null;
  let maxChange = 0;

  for (const data of marketData) {
    const change = Math.abs(data.price - data.previousPrice) / data.previousPrice;
    if (change > maxChange) {
      maxChange = change;
      bestSignal = data;
    }
  }

  if (!bestSignal) {
    return {
      action: "HOLD", tokenId: 0, token: marketData[0]?.token || "?",
      amount: 0, price: marketData[0]?.price || 0, priceChange: 0, confidence: 0.5,
      reasoning: "No significant signal. Holding.",
    };
  }

  const pc = (bestSignal.price - bestSignal.previousPrice) / bestSignal.previousPrice;
  const rm = strategy === 0 ? 0.1 : strategy === 1 ? 0.25 : 0.5;
  const buyTh = strategy === 0 ? 0.02 : strategy === 1 ? 0.01 : 0.005;
  const sellTh = strategy === 0 ? -0.02 : strategy === 1 ? -0.01 : -0.005;
  const ep = positions.find((p) => p.tokenId === bestSignal!.tokenId);

  const pct = pc * 100;

  if (pc > buyTh && balance > 0) {
    const amt = Math.round(balance * rm);
    if (amt <= 0) {
      return { action: "HOLD", tokenId: bestSignal.tokenId, token: bestSignal.token,
        amount: 0, price: bestSignal.price, priceChange: pct, confidence: 0.4,
        reasoning: `${bestSignal.token} +${pct.toFixed(2)}%, but balance too low.` };
    }
    return { action: "BUY", tokenId: bestSignal.tokenId, token: bestSignal.token,
      amount: amt, price: bestSignal.price, priceChange: pct,
      confidence: Math.min(0.95, 0.5 + pc * 10),
      reasoning: `${bestSignal.token} up ${pct.toFixed(2)}% — BUY ${(rm*100).toFixed(0)}% of balance.` };
  } else if (pc < sellTh && ep && ep.amount > 0) {
    const amt = Math.round(ep.amount * rm);
    if (amt <= 0) {
      return { action: "HOLD", tokenId: bestSignal.tokenId, token: bestSignal.token,
        amount: 0, price: bestSignal.price, priceChange: pct, confidence: 0.4,
        reasoning: `${bestSignal.token} ${pct.toFixed(2)}%, position too small.` };
    }
    return { action: "SELL", tokenId: bestSignal.tokenId, token: bestSignal.token,
      amount: amt, price: bestSignal.price, priceChange: pct,
      confidence: Math.min(0.95, 0.5 + Math.abs(pc) * 10),
      reasoning: `${bestSignal.token} down ${pct.toFixed(2)}% — SELL to protect capital.` };
  } else {
    return { action: "HOLD", tokenId: bestSignal.tokenId, token: bestSignal.token,
      amount: 0, price: bestSignal.price, priceChange: pct, confidence: 0.6,
      reasoning: `${bestSignal.token} sideways (${pct.toFixed(2)}%). Waiting for signal.` };
  }
}

// ==================== HELPERS ====================

export function lamportsToSol(lamports: number): string {
  return (lamports / 1_000_000_000).toFixed(4);
}

export function formatAction(action: string): { label: string; color: string } {
  switch (action) {
    case "BUY":  return { label: "BUY",  color: "text-green-400" };
    case "SELL": return { label: "SELL", color: "text-red-400" };
    default:     return { label: "HOLD", color: "text-yellow-500" };
  }
}

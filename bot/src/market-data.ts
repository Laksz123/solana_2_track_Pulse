// ==================== MARKET DATA (CoinGecko) ====================

import { CONFIG, log } from "./config";

// ==================== TYPES ====================

export interface OHLCV {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MarketAsset {
  id: string;
  symbol: string;
  name: string;
  currentPrice: number;
  marketCap: number;
  priceChange24h: number;
  volume24h: number;
  high24h: number;
  low24h: number;
}

// ==================== RATE LIMITER ====================

const COINGECKO_BASE = "https://api.coingecko.com/api/v3";
let lastFetch = 0;
const MIN_INTERVAL_MS = 1500; // CoinGecko free tier: ~30 req/min

async function rateLimitedFetch(url: string): Promise<Response> {
  const now = Date.now();
  const wait = MIN_INTERVAL_MS - (now - lastFetch);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastFetch = Date.now();
  return fetch(url);
}

// ==================== FETCH MARKET OVERVIEW ====================

export async function fetchMarketOverview(coins: string[]): Promise<MarketAsset[]> {
  const ids = coins.join(",");
  const url = `${COINGECKO_BASE}/coins/markets?vs_currency=usd&ids=${ids}&order=market_cap_desc&sparkline=false`;

  try {
    const resp = await rateLimitedFetch(url);
    if (!resp.ok) {
      log.error("CoinGecko markets error:", resp.status);
      return [];
    }
    const data: any[] = await resp.json() as any[];
    return data.map((c: any) => ({
      id: c.id,
      symbol: (c.symbol || "").toUpperCase(),
      name: c.name,
      currentPrice: c.current_price || 0,
      marketCap: c.market_cap || 0,
      priceChange24h: c.price_change_percentage_24h || 0,
      volume24h: c.total_volume || 0,
      high24h: c.high_24h || 0,
      low24h: c.low_24h || 0,
    }));
  } catch (err) {
    log.error("CoinGecko fetch error:", err);
    return [];
  }
}

// ==================== FETCH OHLC ====================

export async function fetchOHLC(coinId: string, days: number = 7): Promise<OHLCV[]> {
  const url = `${COINGECKO_BASE}/coins/${coinId}/ohlc?vs_currency=usd&days=${days}`;

  try {
    const resp = await rateLimitedFetch(url);
    if (!resp.ok) {
      log.error(`CoinGecko OHLC error for ${coinId}:`, resp.status);
      return [];
    }
    const data = await resp.json() as number[][];
    if (!Array.isArray(data)) return [];

    return data.map((c) => ({
      timestamp: Math.floor(c[0] / 1000),
      open: c[1],
      high: c[2],
      low: c[3],
      close: c[4],
      volume: 0,
    }));
  } catch (err) {
    log.error(`CoinGecko OHLC error for ${coinId}:`, err);
    return [];
  }
}

// ==================== FETCH PRICE HISTORY ====================

export async function fetchPriceHistory(coinId: string, days: number = 7): Promise<number[][]> {
  const url = `${COINGECKO_BASE}/coins/${coinId}/market_chart?vs_currency=usd&days=${days}`;

  try {
    const resp = await rateLimitedFetch(url);
    if (!resp.ok) return [];
    const data = await resp.json() as any;
    return data.prices || [];
  } catch {
    return [];
  }
}

// ==================== BUILD OHLCV FROM PRICES ====================

export function buildOHLCVFromPrices(prices: number[][], intervalMs: number = 3600000): OHLCV[] {
  if (prices.length === 0) return [];

  const candles: OHLCV[] = [];
  let bucketStart = Math.floor(prices[0][0] / intervalMs) * intervalMs;
  let o = prices[0][1], h = o, l = o, c = o;

  for (const [ts, price] of prices) {
    if (ts >= bucketStart + intervalMs) {
      candles.push({ timestamp: Math.floor(bucketStart / 1000), open: o, high: h, low: l, close: c, volume: 0 });
      bucketStart = Math.floor(ts / intervalMs) * intervalMs;
      o = price; h = price; l = price; c = price;
    } else {
      h = Math.max(h, price);
      l = Math.min(l, price);
      c = price;
    }
  }
  candles.push({ timestamp: Math.floor(bucketStart / 1000), open: o, high: h, low: l, close: c, volume: 0 });

  return candles;
}

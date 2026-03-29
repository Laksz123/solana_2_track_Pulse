// ==================== REAL MARKET DATA FETCHER ====================
// Uses CoinGecko free API for crypto market data

export interface OHLCV {
  time: number;   // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface RealMarketAsset {
  id: string;        // coingecko id
  symbol: string;    // SOL, BTC, etc.
  name: string;
  currentPrice: number;
  priceChange24h: number;
  priceChangePercent24h: number;
  marketCap: number;
  totalVolume: number;
  high24h: number;
  low24h: number;
  circulatingSupply: number;
  sparkline7d: number[];
  ohlcHistory: OHLCV[];
  lastUpdated: number;
}

// Crypto assets to track — top coins with high liquidity
export const TRACKED_COINS = [
  { id: "solana",     symbol: "SOL",  name: "Solana" },
  { id: "bitcoin",    symbol: "BTC",  name: "Bitcoin" },
  { id: "ethereum",   symbol: "ETH",  name: "Ethereum" },
  { id: "bonk",       symbol: "BONK", name: "Bonk" },
  { id: "jupiter-exchange-solana", symbol: "JUP", name: "Jupiter" },
  { id: "raydium",    symbol: "RAY",  name: "Raydium" },
];

const BASE_URL = "https://api.coingecko.com/api/v3";

// Rate limiting: CoinGecko free tier = 10-30 calls/min
let lastCallTime = 0;
const MIN_INTERVAL_MS = 2500;

async function rateLimitedFetch(url: string): Promise<Response> {
  const now = Date.now();
  const wait = Math.max(0, MIN_INTERVAL_MS - (now - lastCallTime));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallTime = Date.now();
  
  const resp = await fetch(url, {
    headers: { "Accept": "application/json" },
    cache: "no-store",
  });
  
  if (resp.status === 429) {
    // Rate limited — wait and retry once
    await new Promise((r) => setTimeout(r, 10000));
    return fetch(url, { headers: { "Accept": "application/json" }, cache: "no-store" });
  }
  
  return resp;
}

// ==================== FETCH CURRENT PRICES + MARKET DATA ====================

export async function fetchMarketOverview(): Promise<RealMarketAsset[]> {
  const ids = TRACKED_COINS.map((c) => c.id).join(",");
  const url = `${BASE_URL}/coins/markets?vs_currency=usd&ids=${ids}&order=market_cap_desc&sparkline=true&price_change_percentage=24h`;

  try {
    const resp = await rateLimitedFetch(url);
    if (!resp.ok) throw new Error(`CoinGecko ${resp.status}`);
    const data = await resp.json();

    return data.map((coin: any) => ({
      id: coin.id,
      symbol: coin.symbol.toUpperCase(),
      name: coin.name,
      currentPrice: coin.current_price,
      priceChange24h: coin.price_change_24h || 0,
      priceChangePercent24h: coin.price_change_percentage_24h || 0,
      marketCap: coin.market_cap || 0,
      totalVolume: coin.total_volume || 0,
      high24h: coin.high_24h || coin.current_price,
      low24h: coin.low_24h || coin.current_price,
      circulatingSupply: coin.circulating_supply || 0,
      sparkline7d: coin.sparkline_in_7d?.price || [],
      ohlcHistory: [],
      lastUpdated: Date.now(),
    }));
  } catch (err) {
    console.error("fetchMarketOverview error:", err);
    return [];
  }
}

// ==================== FETCH OHLC HISTORY (for charts + TA) ====================

export async function fetchOHLC(coinId: string, days: number = 7): Promise<OHLCV[]> {
  const url = `${BASE_URL}/coins/${coinId}/ohlc?vs_currency=usd&days=${days}`;

  try {
    const resp = await rateLimitedFetch(url);
    if (!resp.ok) throw new Error(`CoinGecko OHLC ${resp.status}`);
    const data: number[][] = await resp.json();

    return data.map((candle) => ({
      time: Math.floor(candle[0] / 1000),
      open: candle[1],
      high: candle[2],
      low: candle[3],
      close: candle[4],
      volume: 0, // OHLC endpoint doesn't include volume
    }));
  } catch (err) {
    console.error(`fetchOHLC(${coinId}) error:`, err);
    return [];
  }
}

// ==================== FETCH DETAILED PRICE HISTORY (for volume) ====================

export async function fetchPriceHistory(coinId: string, days: number = 7): Promise<{ prices: number[][]; volumes: number[][] }> {
  const url = `${BASE_URL}/coins/${coinId}/market_chart?vs_currency=usd&days=${days}`;

  try {
    const resp = await rateLimitedFetch(url);
    if (!resp.ok) throw new Error(`CoinGecko chart ${resp.status}`);
    const data = await resp.json();
    return {
      prices: data.prices || [],
      volumes: data.total_volumes || [],
    };
  } catch (err) {
    console.error(`fetchPriceHistory(${coinId}) error:`, err);
    return { prices: [], volumes: [] };
  }
}

// ==================== BUILD OHLCV FROM PRICE HISTORY ====================

export function buildOHLCVFromPrices(prices: number[][], volumes: number[][], intervalMinutes: number = 60): OHLCV[] {
  if (prices.length === 0) return [];

  const intervalMs = intervalMinutes * 60 * 1000;
  const candles: OHLCV[] = [];
  let bucketStart = Math.floor(prices[0][0] / intervalMs) * intervalMs;
  let open = prices[0][1];
  let high = prices[0][1];
  let low = prices[0][1];
  let close = prices[0][1];
  let vol = 0;

  for (let i = 0; i < prices.length; i++) {
    const ts = prices[i][0];
    const price = prices[i][1];
    const v = volumes[i] ? volumes[i][1] : 0;

    if (ts >= bucketStart + intervalMs) {
      candles.push({ time: Math.floor(bucketStart / 1000), open, high, low, close, volume: vol });
      bucketStart = Math.floor(ts / intervalMs) * intervalMs;
      open = price;
      high = price;
      low = price;
      close = price;
      vol = v;
    } else {
      high = Math.max(high, price);
      low = Math.min(low, price);
      close = price;
      vol += v;
    }
  }
  candles.push({ time: Math.floor(bucketStart / 1000), open, high, low, close, volume: vol });

  return candles;
}

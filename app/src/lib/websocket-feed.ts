// ==================== BINANCE WEBSOCKET REAL-TIME FEED ====================
// Real-time price data via Binance WebSocket streams
// Supports: ticker updates, 1m/5m/1h candles, mini-ticker for all symbols
// Works in both browser and Node.js environments

import { OHLCV } from "./market-data";

// ==================== TYPES ====================

export interface WSTicker {
  symbol: string;          // BTCUSDT
  price: number;           // last price
  priceChange: number;     // 24h change
  priceChangePct: number;  // 24h change %
  high24h: number;
  low24h: number;
  volume: number;          // 24h volume in base
  quoteVolume: number;     // 24h volume in USDT
  timestamp: number;
}

export interface WSCandle {
  symbol: string;
  interval: string;
  time: number;            // open time (unix seconds)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isClosed: boolean;       // true when candle is final
}

export interface WSOrderBook {
  symbol: string;
  bestBid: number;
  bestAsk: number;
  bidQty: number;
  askQty: number;
  spread: number;          // ask - bid
  spreadPct: number;       // spread as % of mid price
  timestamp: number;
}

// Map CoinGecko IDs to Binance symbols
const COINGECKO_TO_BINANCE: Record<string, string> = {
  bitcoin: "BTCUSDT",
  ethereum: "ETHUSDT",
  solana: "SOLUSDT",
  bonk: "BONKUSDT",
  "jupiter-exchange-solana": "JUPUSDT",
  raydium: "RAYUSDT",
};

const BINANCE_TO_COINGECKO: Record<string, string> = {};
for (const [cg, bn] of Object.entries(COINGECKO_TO_BINANCE)) {
  BINANCE_TO_COINGECKO[bn.toLowerCase()] = cg;
}

export function coinIdToBinance(coinId: string): string | null {
  return COINGECKO_TO_BINANCE[coinId] || null;
}

export function binanceToCoinId(symbol: string): string | null {
  return BINANCE_TO_COINGECKO[symbol.toLowerCase()] || null;
}

// ==================== WEBSOCKET MANAGER ====================

type TickerCallback = (ticker: WSTicker) => void;
type CandleCallback = (candle: WSCandle) => void;
type BookCallback = (book: WSOrderBook) => void;
type StatusCallback = (connected: boolean) => void;

const BINANCE_WS_BASE = "wss://stream.binance.com:9443";

export class BinanceWebSocket {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private streams: string[] = [];
  private connected = false;
  private reconnectAttempts = 0;
  private maxReconnects = 50;
  private reconnectDelay = 2000;

  // Callbacks
  private onTicker: TickerCallback[] = [];
  private onCandle: CandleCallback[] = [];
  private onBook: BookCallback[] = [];
  private onStatus: StatusCallback[] = [];

  // Candle buffer for building OHLCV arrays
  private candleBuffer: Record<string, WSCandle[]> = {};
  private maxBufferSize = 500;

  // Ticker cache
  private tickerCache: Record<string, WSTicker> = {};

  // ==================== CONNECT ====================

  connect(coinIds: string[], intervals: string[] = ["1m", "5m"]): void {
    this.streams = [];

    for (const coinId of coinIds) {
      const symbol = COINGECKO_TO_BINANCE[coinId];
      if (!symbol) continue;
      const s = symbol.toLowerCase();

      // Ticker stream
      this.streams.push(`${s}@ticker`);

      // Kline (candle) streams
      for (const interval of intervals) {
        this.streams.push(`${s}@kline_${interval}`);
      }

      // Order book best bid/ask
      this.streams.push(`${s}@bookTicker`);
    }

    if (this.streams.length === 0) return;

    this.doConnect();
  }

  private doConnect(): void {
    if (this.ws) {
      try { this.ws.close(); } catch (_) {}
    }

    const url = `${BINANCE_WS_BASE}/stream?streams=${this.streams.join("/")}`;

    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      console.error("[WS] Failed to create WebSocket:", err);
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      console.log(`[WS] Connected to Binance (${this.streams.length} streams)`);
      this.onStatus.forEach((cb) => cb(true));

      // Keepalive ping every 30s
      this.pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ method: "LIST_SUBSCRIPTIONS", id: 1 }));
        }
      }, 30000);
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string);
        if (data.stream && data.data) {
          this.handleMessage(data.stream, data.data);
        }
      } catch (_) {}
    };

    this.ws.onerror = (err) => {
      console.error("[WS] Error:", err);
    };

    this.ws.onclose = () => {
      this.connected = false;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.onStatus.forEach((cb) => cb(false));
      console.log("[WS] Disconnected");
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnects) {
      console.error("[WS] Max reconnect attempts reached");
      return;
    }

    const delay = Math.min(this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;

    console.log(`[WS] Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => this.doConnect(), delay);
  }

  // ==================== MESSAGE HANDLERS ====================

  private handleMessage(stream: string, data: any): void {
    if (stream.endsWith("@ticker")) {
      this.handleTicker(data);
    } else if (stream.includes("@kline_")) {
      this.handleKline(data);
    } else if (stream.endsWith("@bookTicker")) {
      this.handleBookTicker(data);
    }
  }

  private handleTicker(d: any): void {
    const ticker: WSTicker = {
      symbol: d.s,
      price: parseFloat(d.c),
      priceChange: parseFloat(d.p),
      priceChangePct: parseFloat(d.P),
      high24h: parseFloat(d.h),
      low24h: parseFloat(d.l),
      volume: parseFloat(d.v),
      quoteVolume: parseFloat(d.q),
      timestamp: d.E || Date.now(),
    };

    this.tickerCache[d.s] = ticker;
    this.onTicker.forEach((cb) => cb(ticker));
  }

  private handleKline(d: any): void {
    const k = d.k;
    const candle: WSCandle = {
      symbol: d.s,
      interval: k.i,
      time: Math.floor(k.t / 1000),
      open: parseFloat(k.o),
      high: parseFloat(k.h),
      low: parseFloat(k.l),
      close: parseFloat(k.c),
      volume: parseFloat(k.v),
      isClosed: k.x,
    };

    // Buffer closed candles
    const key = `${candle.symbol}_${candle.interval}`;
    if (!this.candleBuffer[key]) this.candleBuffer[key] = [];

    if (candle.isClosed) {
      this.candleBuffer[key].push(candle);
      if (this.candleBuffer[key].length > this.maxBufferSize) {
        this.candleBuffer[key] = this.candleBuffer[key].slice(-this.maxBufferSize);
      }
    }

    this.onCandle.forEach((cb) => cb(candle));
  }

  private handleBookTicker(d: any): void {
    const bestBid = parseFloat(d.b);
    const bestAsk = parseFloat(d.a);
    const mid = (bestBid + bestAsk) / 2;

    const book: WSOrderBook = {
      symbol: d.s,
      bestBid,
      bestAsk,
      bidQty: parseFloat(d.B),
      askQty: parseFloat(d.A),
      spread: bestAsk - bestBid,
      spreadPct: mid > 0 ? ((bestAsk - bestBid) / mid) * 100 : 0,
      timestamp: Date.now(),
    };

    this.onBook.forEach((cb) => cb(book));
  }

  // ==================== PUBLIC API ====================

  subscribeTicker(cb: TickerCallback): () => void {
    this.onTicker.push(cb);
    return () => { this.onTicker = this.onTicker.filter((c) => c !== cb); };
  }

  subscribeCandle(cb: CandleCallback): () => void {
    this.onCandle.push(cb);
    return () => { this.onCandle = this.onCandle.filter((c) => c !== cb); };
  }

  subscribeBook(cb: BookCallback): () => void {
    this.onBook.push(cb);
    return () => { this.onBook = this.onBook.filter((c) => c !== cb); };
  }

  subscribeStatus(cb: StatusCallback): () => void {
    this.onStatus.push(cb);
    return () => { this.onStatus = this.onStatus.filter((c) => c !== cb); };
  }

  // Get cached ticker
  getTicker(binanceSymbol: string): WSTicker | null {
    return this.tickerCache[binanceSymbol] || null;
  }

  // Get all cached tickers
  getAllTickers(): Record<string, WSTicker> {
    return { ...this.tickerCache };
  }

  // Get buffered candles as OHLCV array (for TA/ML)
  getCandles(coinId: string, interval: string = "5m"): OHLCV[] {
    const symbol = COINGECKO_TO_BINANCE[coinId];
    if (!symbol) return [];
    const key = `${symbol}_${interval}`;
    const buf = this.candleBuffer[key] || [];
    return buf.map((c) => ({
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));
  }

  // Get latest price for a coin
  getPrice(coinId: string): number | null {
    const symbol = COINGECKO_TO_BINANCE[coinId];
    if (!symbol) return null;
    return this.tickerCache[symbol]?.price || null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ==================== DISCONNECT ====================

  disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.maxReconnects = 0; // prevent reconnection
    if (this.ws) {
      try { this.ws.close(); } catch (_) {}
      this.ws = null;
    }
    this.connected = false;
  }
}

// ==================== SINGLETON ====================

let _instance: BinanceWebSocket | null = null;

export function getWebSocketFeed(): BinanceWebSocket {
  if (!_instance) {
    _instance = new BinanceWebSocket();
  }
  return _instance;
}

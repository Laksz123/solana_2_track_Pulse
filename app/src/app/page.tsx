"use client";

import React, { useState, useCallback, useEffect, useRef } from "react";
import {
  Wallet,
  ArrowDown,
  ArrowUp,
  Play,
  Square,
  BarChart3,
  TrendingUp,
  TrendingDown,
  Minus,
  Zap,
  ShieldCheck,
  Crosshair,
  Globe,
  CircleDot,
  ChevronDown,
  ChevronUp,
  Info,
  X,
  CheckCircle2,
  AlertTriangle,
  Activity,
  Loader2,
  Settings,
} from "lucide-react";
import { useTelegram } from "@/components/TelegramProvider";
import { BinanceWebSocket, getWebSocketFeed, binanceToCoinId, WSTicker } from "@/lib/websocket-feed";
import { RealMarketAsset, OHLCV, TRACKED_COINS, fetchMarketOverview, fetchOHLC, fetchPriceHistory, buildOHLCVFromPrices } from "@/lib/market-data";
import { AITradeDecision, Portfolio, PortfolioPosition, analyzeAllAssets } from "@/lib/ai-model";
import { FullAnalysis, TASignal } from "@/lib/technical-analysis";
import type { ChartCandle } from "@/components/PriceChart";
import dynamic from "next/dynamic";

const PriceChart = dynamic(
  () => import("@/components/PriceChart").then((m) => m.PriceChart),
  { ssr: false, loading: () => <div className="h-[220px] bg-[#12141c] rounded-lg animate-pulse" /> }
);
import { Lang, t, getStrategyName, getActionName } from "@/lib/i18n";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { AnchorProvider } from "@coral-xyz/anchor";
import {
  getProgram, getExplorerUrl, getExplorerAccountUrl, getAgentPDA,
  createAgentOnChain, depositOnChain, withdrawOnChain, executeTradeOnChain,
  logAIDecisionOnChain, updateStrategyOnChain, fetchAgentOnChain,
  TOKEN_IDS, SOLANA_NETWORK,
} from "@/lib/solana-integration";
import { LAMPORTS_PER_SOL, VersionedTransaction } from "@solana/web3.js";
import {
  executeAITrade,
  fetchTokenBalances,
  SwapSettings,
  SwapResult,
  DEFAULT_SWAP_SETTINGS,
  COINGECKO_TO_SYMBOL,
} from "@/lib/jupiter-swap";
import {
  BacktestResult,
  BacktestConfig,
  DEFAULT_BACKTEST_CONFIG,
  fetchBacktestData,
  runBacktest,
} from "@/lib/backtest";
import { PnLTracker, PnLMetrics } from "@/lib/pnl-tracker";
import {
  TelegramSettings,
  DEFAULT_TELEGRAM_SETTINGS,
  testTelegramConnection,
  sendTradeAlert,
  sendPnLReport,
} from "@/lib/telegram-bot";
import {
  MLPredictor,
  EnsemblePredictor,
  MLConfig,
  DEFAULT_ML_CONFIG,
  MLMetrics,
  MLPrediction,
  MLTrainProgress,
} from "@/lib/ml-predictor";

// ==================== CONSTANTS ====================

const INITIAL_WALLET_USD = 10000;

function fmtUSD(v: number): string {
  if (v >= 1000) return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (v >= 1) return v.toFixed(2);
  if (v >= 0.01) return v.toFixed(4);
  return v.toFixed(6);
}

interface AgentState {
  exists: boolean;
  balanceUSD: number;
  strategy: number;
  positions: PortfolioPosition[];
  history: { action: string; symbol: string; amountUSD: number; price: number; priceChange: number; confidence: number; reasoning: string; signals: string[]; timestamp: number }[];
}

interface LogEntry {
  id: string;
  timestamp: number;
  decision: AITradeDecision;
}

// ==================== LANG TOGGLE ====================

function LangToggle({ lang, setLang }: { lang: Lang; setLang: (l: Lang) => void }) {
  return (
    <button onClick={() => setLang(lang === "en" ? "ru" : "en")}
      className="flex items-center gap-1.5 btn-secondary px-3 py-1.5 text-xs">
      <Globe className="w-3.5 h-3.5" />
      {lang === "en" ? "RU" : "EN"}
    </button>
  );
}

// ==================== MAIN ====================

export default function Home() {
  const { isTelegram, user: tgUser, haptic, platform: tgPlatform, viewportHeight } = useTelegram();

  // Auto-detect language from Telegram user or default to 'ru'
  const [lang, setLang] = useState<Lang>("ru");
  useEffect(() => {
    if (tgUser?.language_code === "en") setLang("en");
  }, [tgUser]);

  const [agent, setAgent] = useState<AgentState>({
    exists: false, balanceUSD: 0, strategy: 1, positions: [], history: [],
  });
  const [depositAmount, setDepositAmount] = useState("500");
  const [withdrawAmount, setWithdrawAmount] = useState("100");
  const [selectedStrategy, setSelectedStrategy] = useState(1);
  const [aiLog, setAiLog] = useState<LogEntry[]>([]);
  const [isAutoMode, setIsAutoMode] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [walletBalance, setWalletBalance] = useState(INITIAL_WALLET_USD);
  const autoRef = useRef<NodeJS.Timeout | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const [expandedLogs, setExpandedLogs] = useState<Set<string>>(new Set());
  const [toasts, setToasts] = useState<{ id: string; msg: string; type: "success" | "error" | "info" }[]>([]);

  // Solana wallet integration
  const { publicKey, connected, signTransaction, signAllTransactions } = useWallet();
  const { connection } = useConnection();
  const { setVisible: setWalletModalVisible } = useWalletModal();
  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [txSignatures, setTxSignatures] = useState<string[]>([]);
  const [onChainSynced, setOnChainSynced] = useState(false);

  // Get Anchor provider when wallet is connected
  const getProvider = useCallback(() => {
    if (!publicKey || !signTransaction || !signAllTransactions) return null;
    const wallet = { publicKey, signTransaction, signAllTransactions };
    return new AnchorProvider(connection, wallet as any, { commitment: "confirmed" });
  }, [publicKey, signTransaction, signAllTransactions, connection]);

  // Fetch SOL balance when wallet connects
  useEffect(() => {
    if (!publicKey || !connected) { setSolBalance(null); return; }
    const fetchBal = () => {
      connection.getBalance(publicKey).then((b) => setSolBalance(b / LAMPORTS_PER_SOL)).catch(() => {});
    };
    fetchBal();
    const iv = setInterval(fetchBal, 10000);
    return () => clearInterval(iv);
  }, [publicKey, connected, connection]);

  // Add tx signature helper
  const addTxSig = useCallback((sig: string) => {
    if (sig && sig !== "already-exists") {
      setTxSignatures((prev) => [sig, ...prev.slice(0, 19)]);
    }
  }, []);

  // Real market data
  const [assets, setAssets] = useState<RealMarketAsset[]>([]);
  const [ohlcMap, setOhlcMap] = useState<Record<string, OHLCV[]>>({});
  const [selectedCoin, setSelectedCoin] = useState<string>(TRACKED_COINS[0].id);
  const [chartCandles, setChartCandles] = useState<Record<string, ChartCandle[]>>({});
  const [dataLoading, setDataLoading] = useState(true);
  const [lastDecisions, setLastDecisions] = useState<AITradeDecision[]>([]);

  // Jupiter DEX integration
  const [swapSettings, setSwapSettings] = useState<SwapSettings>(DEFAULT_SWAP_SETTINGS);
  const [tokenBalances, setTokenBalances] = useState<Record<string, number>>({});
  const [showSwapSettings, setShowSwapSettings] = useState(false);
  const [pendingSwap, setPendingSwap] = useState<{ decision: AITradeDecision; resolve: (confirmed: boolean) => void } | null>(null);
  const [lastSwapResults, setLastSwapResults] = useState<SwapResult[]>([]);

  // Fetch token balances when wallet connects
  useEffect(() => {
    if (!publicKey || !connected) { setTokenBalances({}); return; }
    const fetchBals = () => {
      fetchTokenBalances(connection, publicKey).then(setTokenBalances).catch(() => {});
    };
    fetchBals();
    const iv = setInterval(fetchBals, 15000);
    return () => clearInterval(iv);
  }, [publicKey, connected, connection]);

  // Backtesting
  const [backtestResult, setBacktestResult] = useState<BacktestResult | null>(null);
  const [backtestRunning, setBacktestRunning] = useState(false);
  const [backtestProgress, setBacktestProgress] = useState(0);
  const [backtestConfig, setBacktestConfig] = useState<BacktestConfig>(DEFAULT_BACKTEST_CONFIG);
  const [showBacktest, setShowBacktest] = useState(false);

  // P&L Tracker
  const pnlTrackerRef = useRef(new PnLTracker(INITIAL_WALLET_USD));
  const [pnlMetrics, setPnlMetrics] = useState<PnLMetrics | null>(null);

  // Update P&L metrics periodically when agent has trades
  useEffect(() => {
    if (!agent.exists || agent.history.length === 0) return;
    const tracker = pnlTrackerRef.current;
    tracker.snapshotEquity(agent.balanceUSD, agent.positions);
    setPnlMetrics(tracker.getMetrics(agent.balanceUSD, agent.positions));
  }, [agent.exists, agent.balanceUSD, agent.positions, agent.history.length]);

  // Telegram
  const [tgSettings, setTgSettings] = useState<TelegramSettings>(DEFAULT_TELEGRAM_SETTINGS);
  const [tgTesting, setTgTesting] = useState(false);
  const [tgAlertCount, setTgAlertCount] = useState(0);
  const [tgLastSent, setTgLastSent] = useState<string | null>(null);
  const [showTgSettings, setShowTgSettings] = useState(false);
  const tgReportTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Periodic P&L report via Telegram
  useEffect(() => {
    if (tgReportTimerRef.current) clearInterval(tgReportTimerRef.current);
    if (!tgSettings.enabled || !tgSettings.sendPnLReports || tgSettings.reportIntervalMin <= 0) return;
    tgReportTimerRef.current = setInterval(() => {
      const m = pnlTrackerRef.current.getMetrics(agent.balanceUSD, agent.positions);
      sendPnLReport(tgSettings, {
        totalPnLUSD: m.totalPnLUSD,
        totalPnLPct: m.totalPnLPct,
        realizedPnLUSD: m.realizedPnLUSD,
        unrealizedPnLUSD: m.unrealizedPnLUSD,
        winRate: m.winRate,
        totalTrades: m.totalTrades,
        maxDrawdown: m.maxDrawdown,
        sharpeRatio: m.sharpeRatio,
        profitFactor: m.profitFactor,
        totalEquity: m.totalEquity,
        positions: agent.positions.map((p) => ({
          symbol: p.symbol,
          pnlPct: p.unrealizedPnLPct,
          amountUSD: p.amount * p.currentPrice,
        })),
      });
    }, tgSettings.reportIntervalMin * 60 * 1000);
    return () => { if (tgReportTimerRef.current) clearInterval(tgReportTimerRef.current); };
  }, [tgSettings.enabled, tgSettings.sendPnLReports, tgSettings.reportIntervalMin, tgSettings.botToken, tgSettings.chatId, agent.balanceUSD, agent.positions]);

  // ML Predictor
  const mlPredictorRef = useRef(new EnsemblePredictor(DEFAULT_ML_CONFIG));
  const [mlMetrics, setMlMetrics] = useState<MLMetrics | null>(null);
  const [mlPrediction, setMlPrediction] = useState<MLPrediction | null>(null);
  const [mlTraining, setMlTraining] = useState(false);
  const [mlProgress, setMlProgress] = useState<MLTrainProgress | null>(null);
  const [showMlPanel, setShowMlPanel] = useState(false);
  const [mlConfig, setMlConfig] = useState<MLConfig>(DEFAULT_ML_CONFIG);

  // ==================== TOGGLE LOG ====================

  const toggleLog = useCallback((id: string) => {
    setExpandedLogs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  // ==================== FETCH REAL MARKET DATA ====================

  const loadMarketData = useCallback(async () => {
    try {
      const overview = await fetchMarketOverview();
      if (overview.length > 0) setAssets(overview);

      // Fetch OHLC for each coin (sequentially to respect rate limits)
      const newOhlc: Record<string, OHLCV[]> = {};
      const newCandles: Record<string, ChartCandle[]> = {};
      for (const coin of TRACKED_COINS) {
        const hist = await fetchPriceHistory(coin.id, 7);
        if (hist.prices.length > 0) {
          const ohlcv = buildOHLCVFromPrices(hist.prices, hist.volumes, 60);
          newOhlc[coin.id] = ohlcv;
          newCandles[coin.id] = ohlcv.map((c) => ({
            time: c.time, open: c.open, high: c.high, low: c.low, close: c.close,
          }));
        }
      }
      setOhlcMap(newOhlc);
      setChartCandles(newCandles);
      setDataLoading(false);
    } catch (err) {
      console.error("Market data load error:", err);
      setDataLoading(false);
    }
  }, []);

  // WebSocket real-time feed
  const wsFeedRef = useRef<BinanceWebSocket | null>(null);
  const [wsConnected, setWsConnected] = useState(false);

  useEffect(() => {
    loadMarketData();

    // Start WebSocket after initial load
    const ws = getWebSocketFeed();
    wsFeedRef.current = ws;
    ws.connect(TRACKED_COINS.map((c) => c.id), ["1m", "5m"]);

    const unsubStatus = ws.subscribeStatus(setWsConnected);

    // Real-time ticker updates → merge into assets
    const unsubTicker = ws.subscribeTicker((ticker: WSTicker) => {
      const coinId = binanceToCoinId(ticker.symbol);
      if (!coinId) return;
      setAssets((prev) => prev.map((a) => {
        if (a.id !== coinId) return a;
        return {
          ...a,
          currentPrice: ticker.price,
          priceChange24h: ticker.priceChange,
          priceChangePercent24h: ticker.priceChangePct,
          high24h: ticker.high24h,
          low24h: ticker.low24h,
          totalVolume: ticker.quoteVolume,
          lastUpdated: ticker.timestamp,
        };
      }));
    });

    // Fallback: CoinGecko polling every 60s (slower since WS handles real-time)
    const iv = setInterval(() => {
      fetchMarketOverview().then((o) => { if (o.length > 0) setAssets(o); });
    }, 60000);

    return () => {
      clearInterval(iv);
      unsubStatus();
      unsubTicker();
      ws.disconnect();
    };
  }, [loadMarketData]);

  // No auto-scroll — prevents page from jumping down on every log update

  useEffect(() => {
    if (isAutoMode && agent.exists) {
      autoRef.current = setInterval(() => runAI(), 15000); // every 15s in auto mode
      return () => { if (autoRef.current) clearInterval(autoRef.current); };
    } else {
      if (autoRef.current) clearInterval(autoRef.current);
    }
  }, [isAutoMode, agent.exists]);

  // ==================== ACTIONS ====================

  const addToast = useCallback((msg: string, type: "success" | "error" | "info" = "info") => {
    const id = Date.now().toString() + Math.random().toString(36).slice(2, 5);
    setToasts((prev) => [...prev.slice(-4), { id, msg, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((tt) => tt.id !== id)), 4000);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((tt) => tt.id !== id));
  }, []);

  const handleRunBacktest = useCallback(async () => {
    setBacktestRunning(true);
    setBacktestProgress(0);
    setBacktestResult(null);

    try {
      const data = await fetchBacktestData(backtestConfig.coins, backtestConfig.days);
      if (Object.keys(data).length === 0) {
        addToast(lang === "ru" ? "Не удалось загрузить данные" : "Failed to load historical data", "error");
        setBacktestRunning(false);
        return;
      }

      const result = runBacktest(data, backtestConfig, (pct) => setBacktestProgress(pct));
      setBacktestResult(result);
      const retSign = result.metrics.totalReturn >= 0 ? "+" : "";
      addToast(
        `${t("bt.title", lang)}: ${retSign}${result.metrics.totalReturn.toFixed(2)}% | ${t("bt.win_rate", lang)}: ${result.metrics.winRate.toFixed(0)}% | ${result.metrics.totalTrades} ${t("bt.total_trades", lang).toLowerCase()}`,
        result.metrics.totalReturn >= 0 ? "success" : "error",
      );
    } catch (err) {
      console.error("Backtest error:", err);
      addToast(lang === "ru" ? "Ошибка бэктеста" : "Backtest error", "error");
    }
    setBacktestRunning(false);
  }, [backtestConfig, lang, addToast]);

  const handleTrainML = useCallback(async () => {
    setMlTraining(true);
    setMlProgress(null);
    setMlMetrics(null);
    setMlPrediction(null);

    try {
      // Fetch candle data for selected coin
      const coinId = assets.length > 0 ? assets[0].id : "bitcoin";
      const ohlcRaw = await fetchOHLC(coinId, 90);
      // Convert market-data OHLCV (time) to ML OHLCV (timestamp)
      let mlCandles = ohlcRaw.map((c) => ({ timestamp: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
      if (mlCandles.length < 30) {
        const hist = await fetchPriceHistory(coinId, 90);
        mlCandles = hist.prices.map(([ts, price]: number[]) => ({
          timestamp: Math.floor(ts / 1000), open: price, high: price * 1.001,
          low: price * 0.999, close: price, volume: 0,
        }));
      }
      if (mlCandles.length < 30) {
        addToast(lang === "ru" ? "Недостаточно данных для обучения" : "Insufficient data for training", "error");
        setMlTraining(false);
        return;
      }

      mlPredictorRef.current = new EnsemblePredictor(mlConfig);
      const metrics = await mlPredictorRef.current.train(mlCandles, (p) => setMlProgress(p));
      setMlMetrics(metrics);

      // Run prediction on latest data
      const pred = mlPredictorRef.current.predict(mlCandles);
      setMlPrediction(pred);

      addToast(
        `ML: Train ${(metrics.trainAccuracy * 100).toFixed(0)}% | Test ${(metrics.testAccuracy * 100).toFixed(0)}% | ${metrics.totalSamples} samples`,
        metrics.testAccuracy > 0.52 ? "success" : "info",
      );
    } catch (err: any) {
      console.error("ML train error:", err);
      addToast(`ML error: ${err.message || err}`, "error");
    }
    setMlTraining(false);
  }, [assets, mlConfig, lang, addToast]);

  const createAgent = useCallback(async () => {
    setIsProcessing(true);
    // Always create locally for immediate UX
    setAgent({ exists: true, balanceUSD: 0, strategy: selectedStrategy, positions: [], history: [] });
    addToast(`${t("sys.agent_created", lang)} ${getStrategyName(selectedStrategy, lang)}`, "success");
    // Fire on-chain call if wallet connected (async, non-blocking)
    const provider = getProvider();
    if (provider && publicKey) {
      try {
        const program = getProgram(provider);
        const result = await createAgentOnChain(program, publicKey, selectedStrategy);
        if (result.success) {
          addTxSig(result.signature || "");
          addToast("On-chain: Agent PDA created ✓", "success");
          setOnChainSynced(true);
        }
      } catch (e: any) {
        addToast(`On-chain: ${e.message?.slice(0, 60) || "error"}`, "info");
      }
    }
    setIsProcessing(false);
  }, [selectedStrategy, lang, addToast, getProvider, publicKey, addTxSig]);

  const handleDeposit = useCallback(async () => {
    if (!agent.exists) return;
    const usd = parseFloat(depositAmount);
    if (usd <= 0 || usd > walletBalance) { addToast(t("sys.invalid_deposit", lang), "error"); return; }
    setIsProcessing(true);
    setWalletBalance((p) => p - usd);
    setAgent((p) => ({ ...p, balanceUSD: p.balanceUSD + usd }));
    addToast(`${t("sys.deposited", lang)} $${fmtUSD(usd)}`, "success");
    // On-chain deposit
    const provider = getProvider();
    if (provider && publicKey) {
      try {
        const program = getProgram(provider);
        const lamports = Math.floor(usd * 1e6); // approximate lamports
        const result = await depositOnChain(program, publicKey, lamports);
        if (result.success) { addTxSig(result.signature || ""); addToast("On-chain: Deposit TX ✓", "success"); }
      } catch {}
    }
    setIsProcessing(false);
  }, [agent.exists, depositAmount, walletBalance, lang, addToast, getProvider, publicKey, addTxSig]);

  const handleWithdraw = useCallback(async () => {
    if (!agent.exists) return;
    const usd = parseFloat(withdrawAmount);
    if (usd <= 0 || usd > agent.balanceUSD) { addToast(t("sys.invalid_withdraw", lang), "error"); return; }
    setIsProcessing(true);
    setWalletBalance((p) => p + usd);
    setAgent((p) => ({ ...p, balanceUSD: p.balanceUSD - usd }));
    addToast(`${t("sys.withdrew", lang)} $${fmtUSD(usd)}`, "success");
    // On-chain withdraw
    const provider = getProvider();
    if (provider && publicKey) {
      try {
        const program = getProgram(provider);
        const lamports = Math.floor(usd * 1e6);
        const result = await withdrawOnChain(program, publicKey, lamports);
        if (result.success) { addTxSig(result.signature || ""); addToast("On-chain: Withdraw TX ✓", "success"); }
      } catch {}
    }
    setIsProcessing(false);
  }, [agent.exists, agent.balanceUSD, withdrawAmount, lang, addToast, getProvider, publicKey, addTxSig]);

  // ==================== AI RUN ====================

  const runAI = useCallback(async () => {
    if (!agent.exists || assets.length === 0 || Object.keys(ohlcMap).length === 0) return;
    setIsProcessing(true);

    // Build portfolio
    const portfolio: Portfolio = {
      cashUSD: agent.balanceUSD,
      positions: agent.positions,
      totalValue: agent.balanceUSD + agent.positions.reduce((s, p) => s + p.amount * p.currentPrice, 0),
    };

    // Build ML signals if ensemble is trained
    let mlSignals: Record<string, { signal: number; confidence: number; direction: "UP" | "DOWN" }> | undefined;
    if (mlPredictorRef.current.isReady()) {
      mlSignals = {};
      for (const asset of assets) {
        const candles = ohlcMap[asset.id];
        if (candles && candles.length > 20) {
          const mlCandles = candles.map((c) => ({ timestamp: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
          const sig = mlPredictorRef.current.getSignal(mlCandles);
          if (sig.confidence > 0.1) {
            mlSignals[asset.id] = sig;
          }
        }
      }
    }

    // Run AI analysis on all assets (with ML signals if available)
    const decisions = analyzeAllAssets(assets, ohlcMap, portfolio, agent.strategy, mlSignals);
    setLastDecisions(decisions);

    // Execute the top decision (first actionable one)
    // For HOLDs: rotate through coins so user sees analysis of different assets
    const actionable = decisions.find((d) => d.action !== "HOLD");
    let topDecision: AITradeDecision;
    if (actionable) {
      topDecision = actionable;
    } else if (decisions.length > 0) {
      // All HOLDs — pick a different coin each cycle based on timestamp
      const holdIdx = Math.floor(Date.now() / 1000) % decisions.length;
      topDecision = decisions[holdIdx];
    } else {
      setIsProcessing(false); return;
    }

    const ts = Math.floor(Date.now() / 1000);
    const hEntry = {
      action: topDecision.action,
      symbol: topDecision.symbol,
      amountUSD: topDecision.amountUSD,
      price: topDecision.currentPrice,
      priceChange: topDecision.analysis.overallScore * 100,
      confidence: topDecision.confidence,
      reasoning: topDecision.reasoning,
      signals: topDecision.signalsSummary,
      timestamp: ts,
    };

    // ==================== JUPITER DEX SWAP ====================
    // If wallet connected and action is BUY/SELL, execute swap via Jupiter
    let swapResult: SwapResult | null = null;
    if (connected && publicKey && signTransaction && topDecision.action !== "HOLD" && topDecision.amountUSD > 0) {
      // Get SOL price for conversion
      const solAsset = assets.find((a) => a.id === "solana");
      const solPrice = solAsset?.currentPrice || 0;

      // Confirmation dialog (if enabled and real swaps active)
      if (swapSettings.enableRealSwaps && swapSettings.confirmBeforeSwap && !isAutoMode) {
        const confirmed = await new Promise<boolean>((resolve) => {
          setPendingSwap({ decision: topDecision, resolve });
        });
        setPendingSwap(null);
        if (!confirmed) {
          addToast(lang === "ru" ? "Своп отменён пользователем" : "Swap cancelled by user", "info");
          setIsProcessing(false);
          return;
        }
      }

      // Execute swap (real or simulated)
      const signVersionedTx = signTransaction as (tx: VersionedTransaction) => Promise<VersionedTransaction>;
      swapResult = await executeAITrade(
        connection, publicKey, signVersionedTx,
        topDecision.action, topDecision.coinId, topDecision.amountUSD,
        solPrice, topDecision.currentPrice, swapSettings,
      );

      // Track result
      setLastSwapResults((prev) => [swapResult!, ...prev.slice(0, 19)]);

      if (swapResult.success) {
        const modeLabel = swapSettings.enableRealSwaps ? "Jupiter" : "Sim";
        addToast(
          `[${modeLabel}] ${topDecision.action} ${topDecision.symbol}: ${swapResult.inputAmount.toFixed(4)} ${swapResult.inputSymbol} → ${swapResult.outputAmount.toFixed(4)} ${swapResult.outputSymbol}`,
          "success",
        );
        if (swapResult.signature && !swapResult.signature.startsWith("sim_")) {
          addTxSig(swapResult.signature);
        }
      } else {
        addToast(`${t("jupiter.swap_failed", lang)}: ${swapResult.error?.slice(0, 80)}`, "error");
      }
    }

    if (topDecision.action === "BUY" && topDecision.amountUSD > 0) {
      // HARD GUARD: never spend more than we have
      const buyAmount = Math.min(topDecision.amountUSD, agent.balanceUSD);
      if (buyAmount < 1) { setIsProcessing(false); return; } // skip if not enough cash
      const units = buyAmount / topDecision.currentPrice;
      setAgent((p) => {
        // Double-check balance inside state updater
        if (p.balanceUSD < 1) return { ...p, history: [...p.history, hEntry] };
        const actualSpend = Math.min(buyAmount, p.balanceUSD);
        const actualUnits = actualSpend / topDecision.currentPrice;
        const pos = [...p.positions];
        const ex = pos.find((x) => x.coinId === topDecision.coinId);
        if (ex) {
          const newAmount = ex.amount + actualUnits;
          const newAvg = (ex.avgBuyPrice * ex.amount + topDecision.currentPrice * actualUnits) / newAmount;
          ex.amount = newAmount;
          ex.avgBuyPrice = newAvg;
          ex.currentPrice = topDecision.currentPrice;
          ex.unrealizedPnL = (topDecision.currentPrice - newAvg) * newAmount;
          ex.unrealizedPnLPct = ((topDecision.currentPrice - newAvg) / newAvg) * 100;
        } else {
          pos.push({
            symbol: topDecision.symbol, coinId: topDecision.coinId,
            amount: actualUnits, avgBuyPrice: topDecision.currentPrice,
            currentPrice: topDecision.currentPrice, unrealizedPnL: 0, unrealizedPnLPct: 0,
          });
        }
        return { ...p, balanceUSD: p.balanceUSD - actualSpend, positions: pos, history: [...p.history, hEntry] };
      });
      if (!swapResult) addToast(`BUY ${topDecision.symbol}: $${fmtUSD(buyAmount)} @ $${fmtUSD(topDecision.currentPrice)}`, "success");
      pnlTrackerRef.current.recordTrade("BUY", topDecision.symbol, topDecision.coinId, buyAmount, topDecision.currentPrice);
      sendTradeAlert(tgSettings, {
        action: "BUY", symbol: topDecision.symbol, amountUSD: buyAmount,
        price: topDecision.currentPrice, confidence: topDecision.confidence,
        reasoning: topDecision.reasoning, swapMode: swapSettings.enableRealSwaps ? "real" : "simulated",
      }).then((ok) => { if (ok) { setTgAlertCount((c) => c + 1); setTgLastSent(new Date().toLocaleTimeString()); } });
    } else if (topDecision.action === "SELL" && topDecision.amountUSD > 0) {
      const units = topDecision.amountUSD / topDecision.currentPrice;
      setAgent((p) => {
        const pos = p.positions.map((x) =>
          x.coinId === topDecision.coinId ? { ...x, amount: x.amount - units, currentPrice: topDecision.currentPrice } : x
        ).filter((x) => x.amount > 0.0001);
        return { ...p, balanceUSD: p.balanceUSD + topDecision.amountUSD, positions: pos, history: [...p.history, hEntry] };
      });
      if (!swapResult) addToast(`SELL ${topDecision.symbol}: $${fmtUSD(topDecision.amountUSD)} @ $${fmtUSD(topDecision.currentPrice)}`, "success");
      pnlTrackerRef.current.recordTrade("SELL", topDecision.symbol, topDecision.coinId, topDecision.amountUSD, topDecision.currentPrice);
      sendTradeAlert(tgSettings, {
        action: "SELL", symbol: topDecision.symbol, amountUSD: topDecision.amountUSD,
        price: topDecision.currentPrice, confidence: topDecision.confidence,
        reasoning: topDecision.reasoning, swapMode: swapSettings.enableRealSwaps ? "real" : "simulated",
      }).then((ok) => { if (ok) { setTgAlertCount((c) => c + 1); setTgLastSent(new Date().toLocaleTimeString()); } });
    } else {
      setAgent((p) => ({ ...p, history: [...p.history, hEntry] }));
    }

    // Update positions with current prices
    setAgent((p) => ({
      ...p,
      positions: p.positions.map((pos) => {
        const asset = assets.find((a) => a.id === pos.coinId);
        if (!asset) return pos;
        return {
          ...pos, currentPrice: asset.currentPrice,
          unrealizedPnL: (asset.currentPrice - pos.avgBuyPrice) * pos.amount,
          unrealizedPnLPct: ((asset.currentPrice - pos.avgBuyPrice) / pos.avgBuyPrice) * 100,
        };
      }),
    }));

    // Only add log entry for BUY/SELL, or update last HOLD in-place to avoid spam
    if (topDecision.action !== "HOLD") {
      setAiLog((prev) => [...prev.slice(-49), {
        id: Date.now().toString(), timestamp: Date.now(), decision: topDecision,
      }]);
    } else {
      setAiLog((prev) => {
        const lastIdx = prev.length - 1;
        if (lastIdx >= 0 && prev[lastIdx].decision.action === "HOLD") {
          const updated = [...prev];
          updated[lastIdx] = { ...updated[lastIdx], timestamp: Date.now(), decision: topDecision };
          return updated;
        }
        return [...prev.slice(-49), {
          id: Date.now().toString(), timestamp: Date.now(), decision: topDecision,
        }];
      });
    }

    // ==================== ON-CHAIN EXECUTION ====================
    // If wallet connected, record AI decision on Solana blockchain (PDA state)
    const provider = getProvider();
    if (provider && publicKey && topDecision.action !== "HOLD") {
      const program = getProgram(provider);
      const actionCode = topDecision.action === "BUY" ? 1 : 2;
      const tokenId = TOKEN_IDS[topDecision.coinId] ?? 0;
      const amountLamports = Math.round(topDecision.amountUSD * 1e6);
      const priceLamports = Math.round(topDecision.currentPrice * 1e6);
      const confPct = Math.round(topDecision.confidence * 100);

      // Fire-and-forget on-chain calls (don't block UI)
      (async () => {
        try {
          // 1. Execute trade on-chain (PDA state update)
          const tradeResult = await executeTradeOnChain(program, publicKey, actionCode, tokenId, amountLamports, priceLamports);
          if (tradeResult.success && tradeResult.signature) {
            addTxSig(tradeResult.signature);
            addToast(`✓ On-chain PDA: ${tradeResult.signature.slice(0, 8)}...`, "info");
          }

          // 2. Log AI reasoning on-chain (transparency)
          const logResult = await logAIDecisionOnChain(
            program, publicKey, actionCode, tokenId, amountLamports, priceLamports, confPct, topDecision.reasoning
          );
          if (logResult.success && logResult.signature) {
            addTxSig(logResult.signature);
          }
        } catch (e) {
          console.error("On-chain TX error:", e);
        }
      })();
    }

    setIsProcessing(false);
  }, [agent, assets, ohlcMap, addToast, getProvider, publicKey, addTxSig, connected, signTransaction, connection, swapSettings, isAutoMode, lang]);

  // ==================== STRATEGY SCREEN ====================

  if (!agent.exists) {
    const strategyDescs = [
      t("strategy.conservative.desc", lang),
      t("strategy.moderate.desc", lang),
      t("strategy.aggressive.desc", lang),
    ];
    const strategyIcons = [ShieldCheck, Crosshair, Zap];
    const strategyColors = [
      { gradient: "from-blue-500/20 to-cyan-500/20", text: "text-blue-400", glow: "shadow-blue-500/10" },
      { gradient: "from-amber-500/20 to-orange-500/20", text: "text-amber-400", glow: "shadow-amber-500/10" },
      { gradient: "from-red-500/20 to-pink-500/20", text: "text-red-400", glow: "shadow-red-500/10" },
    ];

    return (
      <div className="hero-gradient min-h-screen flex flex-col items-center justify-center gap-8 p-6 relative overflow-hidden">
        <div className="absolute top-6 right-6 z-10"><LangToggle lang={lang} setLang={setLang} /></div>

        {/* Hero */}
        <div className="text-center space-y-3 animate-fade-in">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 mb-4">
            <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-xs font-semibold text-emerald-400 tracking-wide">{t("data.live_coingecko", lang)}</span>
          </div>
          <h1 className="text-4xl md:text-5xl font-extrabold text-white tracking-tight leading-tight">
            {t("app.title", lang)}
          </h1>
          <p className="text-base text-[#6b7280] max-w-md mx-auto leading-relaxed">{t("app.subtitle", lang)}</p>
        </div>

        {/* Strategy picker */}
        <div className="w-full max-w-3xl animate-slide-up">
          <div className="text-center mb-6">
            <h2 className="text-lg font-bold text-white/90">{t("strategy.title", lang)}</h2>
            <p className="text-sm text-[#6b7280] mt-1">{t("strategy.desc", lang)}</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {[0, 1, 2].map((i) => {
              const Icon = strategyIcons[i];
              const active = selectedStrategy === i;
              const colors = strategyColors[i];
              return (
                <button key={i} onClick={() => setSelectedStrategy(i)}
                  className={`strategy-card group ${active ? "active" : ""}`}>
                  <div className={`w-14 h-14 mx-auto mb-4 rounded-2xl bg-gradient-to-br ${colors.gradient} flex items-center justify-center transition-transform duration-300 group-hover:scale-110 ${active ? "animate-float" : ""}`}>
                    <Icon className={`w-7 h-7 ${active ? colors.text : "text-[#6b7280]"} transition-colors`} />
                  </div>
                  <h3 className={`font-bold text-base mb-2 transition-colors ${active ? "text-white" : "text-[#9ca3af]"}`}>
                    {getStrategyName(i, lang)}
                  </h3>
                  <p className="text-xs text-[#6b7280] leading-relaxed">{strategyDescs[i]}</p>
                  {active && (
                    <div className="mt-3 inline-flex items-center gap-1 text-emerald-400 text-xs font-semibold">
                      <CheckCircle2 className="w-3.5 h-3.5" /> {lang === "ru" ? "Выбрано" : "Selected"}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* CTA */}
        <button onClick={createAgent} disabled={isProcessing}
          className="btn-primary px-10 py-3.5 text-base font-bold tracking-wide animate-slide-up animate-glow-pulse rounded-xl">
          {isProcessing ? (
            <span className="flex items-center gap-2"><Loader2 className="w-5 h-5 animate-spin" />{t("strategy.creating", lang)}</span>
          ) : t("strategy.create", lang)}
        </button>

        {/* Features */}
        <div className="flex gap-8 mt-6 animate-fade-in">
          {[
            { icon: BarChart3, title: t("feature.ai", lang), desc: t("feature.ai.desc", lang) },
            { icon: Activity, title: t("feature.ta", lang), desc: t("feature.ta.desc", lang) },
            { icon: ShieldCheck, title: t("feature.control", lang), desc: t("feature.control.desc", lang) },
          ].map((f, i) => (
            <div key={i} className="flex-1 max-w-[180px] text-center">
              <div className="w-10 h-10 mx-auto mb-2 rounded-xl bg-white/[0.03] border border-white/[0.06] flex items-center justify-center">
                <f.icon className="w-5 h-5 text-[#6b7280]" />
              </div>
              <p className="text-xs font-semibold text-[#9ca3af]">{f.title}</p>
              <p className="text-[11px] text-[#6b7280] mt-1 leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ==================== PORTFOLIO TOTAL ====================

  const totalPosValue = agent.positions.reduce((s, p) => s + p.amount * p.currentPrice, 0);
  const totalValue = agent.balanceUSD + totalPosValue;

  // ==================== DASHBOARD ====================

  return (
    <div className={`min-h-screen p-4 md:p-6 max-w-[1440px] mx-auto relative ${isTelegram ? "tg-viewport tg-app tg-safe-top tg-bottom-pad" : ""}`}>
      {/* Telegram Mini App Header */}
      {isTelegram && tgUser && (
        <div className="flex items-center justify-between mb-4 px-1">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white text-sm font-bold shadow-lg shadow-purple-500/20">
              {tgUser.first_name?.[0] || "U"}
            </div>
            <div>
              <p className="text-sm font-semibold text-white">{tgUser.first_name} {tgUser.last_name || ""}</p>
              <p className="text-[11px] text-[#6b7280]">@{tgUser.username || "user"} • {tgPlatform}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <LangToggle lang={lang} setLang={setLang} />
            {connected ? (
              <span className="tag bg-emerald-500/10 text-emerald-400 text-[10px] border border-emerald-500/20">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                {publicKey?.toBase58().slice(0, 4)}...{publicKey?.toBase58().slice(-4)}
              </span>
            ) : (
              <button onClick={() => { haptic?.impactOccurred("medium"); setWalletModalVisible(true); }}
                className="btn-primary px-4 py-2 text-xs flex items-center gap-1.5">
                <Wallet className="w-3.5 h-3.5" /> {t("tg.connect_wallet", lang)}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Toast notifications */}
      {toasts.length > 0 && (
        <div className="fixed top-5 right-5 z-50 flex flex-col gap-2.5 max-w-sm">
          {toasts.map((toast) => (
            <div key={toast.id}
              className={`flex items-start gap-3 px-4 py-3.5 rounded-xl border animate-slide-in backdrop-blur-xl ${
                toast.type === "success" ? "bg-emerald-950/80 border-emerald-500/20 shadow-lg shadow-emerald-500/10" :
                toast.type === "error" ? "bg-red-950/80 border-red-500/20 shadow-lg shadow-red-500/10" :
                "bg-blue-950/80 border-blue-500/20 shadow-lg shadow-blue-500/10"
              }`}>
              {toast.type === "success" ? <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" /> :
               toast.type === "error" ? <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" /> :
               <Info className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />}
              <p className={`text-sm flex-1 font-medium ${
                toast.type === "success" ? "text-emerald-200" :
                toast.type === "error" ? "text-red-200" : "text-blue-200"
              }`}>{toast.msg}</p>
              <button onClick={() => dismissToast(toast.id)} className="shrink-0 mt-0.5 opacity-40 hover:opacity-100 transition-opacity">
                <X className="w-3.5 h-3.5 text-white" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Swap Confirmation Modal */}
      {pendingSwap && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-md animate-fade-in">
          <div className="card p-6 max-w-sm w-full mx-4 border-amber-500/20 shadow-2xl shadow-amber-500/5 animate-slide-up">
            <div className="flex items-center gap-2.5 mb-4">
              <div className="w-9 h-9 rounded-xl bg-amber-500/10 flex items-center justify-center">
                <AlertTriangle className="w-5 h-5 text-amber-400" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-white">{t("jupiter.confirm_title", lang)}</h3>
                <p className="text-[11px] text-[#6b7280]">{t("jupiter.confirm_desc", lang)}</p>
              </div>
            </div>
            <div className="rounded-xl bg-[#0c0e16] p-4 mb-5 space-y-2.5 border border-white/[0.04]">
              <div className="flex justify-between text-xs">
                <span className="text-[#6b7280]">Action</span>
                <span className={`font-bold ${pendingSwap.decision.action === "BUY" ? "text-emerald-400" : "text-red-400"}`}>
                  {pendingSwap.decision.action} {pendingSwap.decision.symbol}
                </span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-[#6b7280]">Amount</span>
                <span className="text-white stat-value">${fmtUSD(pendingSwap.decision.amountUSD)}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-[#6b7280]">Price</span>
                <span className="text-[#9ca3af] stat-value">${fmtUSD(pendingSwap.decision.currentPrice)}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-[#6b7280]">Confidence</span>
                <span className="text-[#9ca3af]">{Math.round(pendingSwap.decision.confidence * 100)}%</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-[#6b7280]">Slippage</span>
                <span className="text-[#9ca3af]">{(swapSettings.slippageBps / 100).toFixed(1)}%</span>
              </div>
            </div>
            <div className="flex gap-3">
              <button onClick={() => pendingSwap.resolve(false)}
                className="btn-secondary flex-1 py-2.5 text-xs">{t("jupiter.confirm_no", lang)}</button>
              <button onClick={() => pendingSwap.resolve(true)}
                className="btn-primary flex-1 py-2.5 text-xs">{t("jupiter.confirm_yes", lang)}</button>
            </div>
          </div>
        </div>
      )}

      {/* Jupiter Swap Settings Overlay */}
      {showSwapSettings && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-md animate-fade-in">
          <div className="card p-6 max-w-md w-full mx-4 animate-slide-up">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-sm font-bold text-white">{t("jupiter.settings", lang)}</h3>
              <button onClick={() => setShowSwapSettings(false)} className="w-8 h-8 rounded-lg bg-white/[0.04] flex items-center justify-center hover:bg-white/[0.08] transition-colors">
                <X className="w-4 h-4 text-[#6b7280]" />
              </button>
            </div>

            {/* Real Swaps Toggle */}
            <div className={`rounded-xl p-4 mb-5 border transition-all ${swapSettings.enableRealSwaps ? "bg-red-500/5 border-red-500/20" : "bg-[#0c0e16] border-white/[0.04]"}`}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-[#e5e7eb]">{t("jupiter.real_swaps", lang)}</span>
                <button
                  onClick={() => setSwapSettings((s) => ({ ...s, enableRealSwaps: !s.enableRealSwaps }))}
                  className={`toggle-switch ${swapSettings.enableRealSwaps ? "bg-red-500" : "bg-[#2a2d3a]"}`}>
                  <div className={`toggle-thumb ${swapSettings.enableRealSwaps ? "translate-x-[18px]" : "translate-x-[2px]"}`} />
                </button>
              </div>
              <p className="text-[11px] text-[#6b7280]">
                {swapSettings.enableRealSwaps ? t("jupiter.real_desc", lang) : t("jupiter.sim_desc", lang)}
              </p>
            </div>

            <div className="space-y-4">
              <div>
                <label className="section-label">{t("jupiter.slippage", lang)}</label>
                <div className="flex gap-2 mt-2">
                  {[25, 50, 100, 200].map((bps) => (
                    <button key={bps}
                      onClick={() => setSwapSettings((s) => ({ ...s, slippageBps: bps }))}
                      className={`flex-1 px-3 py-2 rounded-lg text-xs stat-value transition-all ${swapSettings.slippageBps === bps ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shadow-sm shadow-emerald-500/10" : "bg-[#0c0e16] text-[#6b7280] border border-transparent hover:border-white/[0.06]"}`}>
                      {(bps / 100).toFixed(1)}%
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="section-label">{t("jupiter.max_impact", lang)}</label>
                <div className="flex gap-2 mt-2">
                  {[0.5, 1.0, 2.0, 5.0].map((pct) => (
                    <button key={pct}
                      onClick={() => setSwapSettings((s) => ({ ...s, maxPriceImpactPct: pct }))}
                      className={`flex-1 px-3 py-2 rounded-lg text-xs stat-value transition-all ${swapSettings.maxPriceImpactPct === pct ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shadow-sm shadow-emerald-500/10" : "bg-[#0c0e16] text-[#6b7280] border border-transparent hover:border-white/[0.06]"}`}>
                      {pct}%
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="section-label">{t("jupiter.max_trade", lang)}</label>
                <div className="flex gap-2 mt-2">
                  {[50, 100, 250, 500].map((usd) => (
                    <button key={usd}
                      onClick={() => setSwapSettings((s) => ({ ...s, maxTradeUSD: usd }))}
                      className={`flex-1 px-3 py-2 rounded-lg text-xs stat-value transition-all ${swapSettings.maxTradeUSD === usd ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shadow-sm shadow-emerald-500/10" : "bg-[#0c0e16] text-[#6b7280] border border-transparent hover:border-white/[0.06]"}`}>
                      ${usd}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-between py-1">
                <span className="text-xs text-[#9ca3af]">{lang === "ru" ? "Подтверждение перед свопом" : "Confirm before swap"}</span>
                <button
                  onClick={() => setSwapSettings((s) => ({ ...s, confirmBeforeSwap: !s.confirmBeforeSwap }))}
                  className={`toggle-switch ${swapSettings.confirmBeforeSwap ? "bg-emerald-500" : "bg-[#2a2d3a]"}`}>
                  <div className={`toggle-thumb ${swapSettings.confirmBeforeSwap ? "translate-x-[18px]" : "translate-x-[2px]"}`} />
                </button>
              </div>
            </div>

            <button onClick={() => setShowSwapSettings(false)} className="btn-primary w-full py-2.5 text-sm mt-5">
              {lang === "ru" ? "Сохранить" : "Save"}
            </button>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="flex items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-extrabold text-white tracking-tight">{t("app.title", lang)}</h1>
          <div className="flex items-center gap-1 bg-[#0c0e16] rounded-xl p-1 border border-white/[0.04]">
            {[0, 1, 2].map((s) => {
              const active = agent.strategy === s;
              const colors = s === 0 ? "bg-blue-500/15 text-blue-400 shadow-blue-500/10" : s === 1 ? "bg-amber-500/15 text-amber-400 shadow-amber-500/10" : "bg-red-500/15 text-red-400 shadow-red-500/10";
              return (
                <button key={s} onClick={() => setAgent((p) => ({ ...p, strategy: s }))}
                  className={`px-3 py-1.5 text-[11px] font-bold rounded-lg transition-all ${active ? `${colors} shadow-sm` : "text-[#4b5563] hover:text-[#9ca3af]"}`}>
                  {getStrategyName(s, lang)}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-500/8 border border-blue-500/15">
            <div className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
            <span className="text-[11px] font-semibold text-blue-400">{t("data.live_badge", lang)}</span>
          </div>
          {wsConnected && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/8 border border-emerald-500/15">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-[11px] font-semibold text-emerald-400">WebSocket</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2.5">
          {connected && publicKey ? (
            <div className="flex items-center gap-2.5 px-4 py-2 rounded-xl bg-[#0c0e16] border border-white/[0.04]">
              <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span className="stat-value text-xs text-emerald-400">{publicKey.toBase58().slice(0, 4)}...{publicKey.toBase58().slice(-4)}</span>
              {solBalance !== null && <span className="text-[11px] text-[#6b7280] stat-value">{solBalance.toFixed(2)} SOL</span>}
              <a href={getExplorerAccountUrl(publicKey.toBase58())} target="_blank" rel="noopener noreferrer"
                className="text-[10px] text-blue-400 hover:text-blue-300 font-medium">Explorer</a>
            </div>
          ) : (
            <button onClick={() => setWalletModalVisible(true)}
              className="btn-secondary px-4 py-2 text-xs flex items-center gap-2">
              <Wallet className="w-3.5 h-3.5" />
              Connect Wallet
            </button>
          )}
          <div className="flex items-center gap-2.5 px-4 py-2 rounded-xl bg-[#0c0e16] border border-white/[0.04]">
            <Wallet className="w-3.5 h-3.5 text-[#4b5563]" />
            <span className="stat-value text-xs text-[#e5e7eb]">${fmtUSD(walletBalance)}</span>
            <span className="text-[10px] text-[#4b5563] font-medium">({t("app.demo", lang)})</span>
          </div>
          <LangToggle lang={lang} setLang={setLang} />
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">

        {/* LEFT — Balance + Controls + Positions */}
        <div className="lg:col-span-3 space-y-4">
          {/* Balance Card */}
          <div className="card p-5 relative overflow-hidden">
            <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-bl from-emerald-500/5 to-transparent rounded-bl-full pointer-events-none" />
            <p className="section-label mb-2">{t("dash.balance", lang)}</p>
            <p className="text-3xl font-extrabold text-white stat-value tracking-tight animate-count-up">${fmtUSD(agent.balanceUSD)}</p>
            <div className="mt-3 space-y-1.5">
              <div className="flex justify-between text-xs">
                <span className="text-[#6b7280]">{t("dash.portfolio", lang)}</span>
                <span className="stat-value text-[#e5e7eb] font-semibold">${fmtUSD(totalValue)}</span>
              </div>
              {totalPosValue > 0 && (
                <div className="flex justify-between text-xs">
                  <span className="text-[#6b7280]">{t("dash.in_positions", lang)}</span>
                  <span className="stat-value text-emerald-400 font-semibold">${fmtUSD(totalPosValue)}</span>
                </div>
              )}
            </div>
            {/* Mini allocation bar */}
            {totalValue > 0 && (
              <div className="mt-3">
                <div className="h-1.5 rounded-full bg-[#0c0e16] overflow-hidden flex">
                  <div className="h-full bg-gradient-to-r from-blue-500 to-blue-400 transition-all duration-500" style={{ width: `${((agent.balanceUSD / totalValue) * 100)}%` }} />
                  <div className="h-full bg-gradient-to-r from-emerald-500 to-emerald-400 transition-all duration-500" style={{ width: `${((totalPosValue / totalValue) * 100)}%` }} />
                </div>
              </div>
            )}
          </div>

          {/* Deposit & Withdraw */}
          <div className="card p-5 space-y-4">
            <div>
              <p className="section-label mb-2.5">{t("dash.deposit", lang)}</p>
              <div className="flex gap-2">
                <input type="number" step="50" value={depositAmount}
                  onChange={(e) => setDepositAmount(e.target.value)}
                  className="input-field flex-1" placeholder="USD" />
                <button onClick={handleDeposit} disabled={isProcessing}
                  className="btn-primary px-4 py-2.5 text-xs flex items-center gap-1.5 shrink-0">
                  <ArrowDown className="w-3.5 h-3.5" />{t("dash.deposit", lang)}
                </button>
              </div>
            </div>
            <div className="border-t border-white/[0.04] pt-4">
              <p className="section-label mb-2.5">{t("dash.withdraw", lang)}</p>
              <div className="flex gap-2">
                <input type="number" step="50" value={withdrawAmount}
                  onChange={(e) => setWithdrawAmount(e.target.value)}
                  className="input-field flex-1" placeholder="USD" />
                <button onClick={handleWithdraw} disabled={isProcessing}
                  className="btn-danger px-4 py-2.5 text-xs flex items-center gap-1.5 shrink-0">
                  <ArrowUp className="w-3.5 h-3.5" />{t("dash.withdraw", lang)}
                </button>
              </div>
            </div>
          </div>

          {/* Positions */}
          <div className="card p-5">
            <div className="flex items-center justify-between mb-3">
              <p className="section-label">{t("dash.positions", lang)}</p>
              {agent.positions.length > 0 && (
                <span className="text-[11px] text-emerald-400 stat-value font-semibold">{agent.positions.length}</span>
              )}
            </div>
            {agent.positions.length === 0 ? (
              <div className="text-center py-6">
                <div className="w-10 h-10 mx-auto mb-2 rounded-xl bg-white/[0.03] flex items-center justify-center">
                  <BarChart3 className="w-5 h-5 text-[#3d4254]" />
                </div>
                <p className="text-xs text-[#4b5563]">{t("dash.no_positions", lang)}</p>
              </div>
            ) : (
              <div className="space-y-2">
                {agent.positions.map((pos, i) => (
                  <button key={i} onClick={() => setSelectedCoin(pos.coinId)}
                    className={`position-card w-full text-left ${selectedCoin === pos.coinId ? "active" : ""}`}>
                    <div className="flex justify-between items-center">
                      <span className="stat-value text-sm text-[#e5e7eb] font-bold">{pos.symbol}</span>
                      <span className="stat-value text-sm text-[#e5e7eb]">${fmtUSD(pos.amount * pos.currentPrice)}</span>
                    </div>
                    <div className="flex justify-between items-center text-[11px] mt-1.5">
                      <span className="text-[#6b7280]">{pos.amount.toFixed(4)} @ ${fmtUSD(pos.avgBuyPrice)}</span>
                      <span className={`stat-value font-bold ${pos.unrealizedPnLPct >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                        {pos.unrealizedPnLPct >= 0 ? "+" : ""}{pos.unrealizedPnLPct.toFixed(2)}%
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* CENTER — Chart + AI Engine + Market + History */}
        <div className="lg:col-span-5 space-y-4">
          {/* Price Chart */}
          <div className="card p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <p className="section-label">{t("chart.title", lang)}</p>
                <span className="text-sm font-bold text-white">
                  {TRACKED_COINS.find((c) => c.id === selectedCoin)?.symbol || ""}
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-[10px] text-emerald-400 font-medium">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                CoinGecko
              </div>
            </div>
            {/* Coin tabs */}
            <div className="flex gap-1.5 mb-3 overflow-x-auto pb-1">
              {TRACKED_COINS.map((coin) => {
                const active = selectedCoin === coin.id;
                const asset = assets.find((a) => a.id === coin.id);
                const ch = asset?.priceChangePercent24h || 0;
                return (
                  <button key={coin.id} onClick={() => setSelectedCoin(coin.id)}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg text-[11px] shrink-0 transition-all border ${
                      active ? "bg-emerald-500/8 text-emerald-400 font-semibold border-emerald-500/20" : "bg-[#0c0e16] text-[#6b7280] border-transparent hover:border-white/[0.06] hover:text-[#9ca3af]"
                    }`}>
                    <span className="font-semibold">{coin.symbol}</span>
                    <span className={`stat-value text-[10px] ${ch > 0 ? "text-emerald-400" : ch < 0 ? "text-red-400" : "text-[#4b5563]"}`}>
                      {ch > 0 ? "+" : ""}{ch.toFixed(2)}%
                    </span>
                  </button>
                );
              })}
            </div>
            {dataLoading ? (
              <div className="h-[280px] bg-[#0c0e16] rounded-xl flex items-center justify-center border border-white/[0.03]">
                <Loader2 className="w-6 h-6 text-[#3d4254] animate-spin" />
              </div>
            ) : chartCandles[selectedCoin] ? (
              <div className="rounded-xl overflow-hidden border border-white/[0.03]">
                <PriceChart data={chartCandles[selectedCoin]} token={selectedCoin} height={280} />
              </div>
            ) : (
              <div className="h-[280px] bg-[#0c0e16] rounded-xl flex items-center justify-center text-xs text-[#4b5563] border border-white/[0.03]">
                {t("data.no_data", lang)}
              </div>
            )}
          </div>

          {/* AI Engine */}
          <div className="card p-5 relative overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-emerald-500/30 via-blue-500/30 to-purple-500/30" />
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-500/20 to-blue-500/20 flex items-center justify-center">
                  <Zap className="w-4 h-4 text-emerald-400" />
                </div>
                <div>
                  <p className="text-sm font-bold text-white">{t("ai.engine", lang)}</p>
                  <p className="text-[10px] text-[#6b7280]">{t("ta.indicators", lang)}</p>
                </div>
                {isAutoMode && (
                  <span className="tag bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[10px]">
                    <CircleDot className="w-3 h-3 animate-pulse" /> AUTO
                  </span>
                )}
              </div>
            </div>
            <div className="flex gap-3">
              <button onClick={runAI} disabled={isProcessing || agent.balanceUSD === 0 || dataLoading}
                className="btn-primary flex-1 py-3 text-sm font-bold flex items-center justify-center gap-2">
                {isProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                {t("ai.run", lang)}
              </button>
              <button onClick={() => setIsAutoMode(!isAutoMode)} disabled={agent.balanceUSD === 0 || dataLoading}
                className={`px-5 py-3 text-sm font-bold rounded-lg transition-all ${isAutoMode ? "btn-danger" : "btn-secondary"}`}>
                {isAutoMode ? (
                  <span className="flex items-center gap-2"><Square className="w-4 h-4" />{t("ai.stop", lang)}</span>
                ) : t("ai.auto", lang)}
              </button>
            </div>
            {agent.balanceUSD === 0 && (
              <p className="text-amber-500/80 text-[11px] mt-3 text-center font-medium">{t("ai.need_deposit", lang)}</p>
            )}
          </div>

          {/* Live Market */}
          <div className="card p-5">
            <div className="flex items-center justify-between mb-3">
              <p className="section-label">{t("market.title", lang)}</p>
              <div className="flex items-center gap-1.5 text-[10px] text-emerald-400 font-medium">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                {t("data.live_prices", lang)}
              </div>
            </div>
            <div className="space-y-1">
              {assets.length === 0 ? (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="w-5 h-5 text-[#3d4254] animate-spin" />
                </div>
              ) : assets.map((asset) => {
                const ch = asset.priceChangePercent24h;
                const up = ch > 0;
                return (
                  <button key={asset.id} onClick={() => setSelectedCoin(asset.id)}
                    className={`market-row w-full text-left ${selectedCoin === asset.id ? "active" : ""}`}>
                    <div className="flex items-center gap-2.5">
                      <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${up ? "bg-emerald-500/10" : ch < 0 ? "bg-red-500/10" : "bg-white/[0.03]"}`}>
                        {up ? <TrendingUp className="w-3.5 h-3.5 text-emerald-400" /> :
                         ch < 0 ? <TrendingDown className="w-3.5 h-3.5 text-red-400" /> :
                         <Minus className="w-3.5 h-3.5 text-[#4b5563]" />}
                      </div>
                      <div>
                        <span className="stat-value text-sm text-[#e5e7eb] font-semibold">{asset.symbol}</span>
                        <span className="text-[10px] text-[#4b5563] ml-2">{asset.name}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <span className="stat-value text-xs text-[#e5e7eb]">${fmtUSD(asset.currentPrice)}</span>
                      <span className={`stat-value text-xs min-w-[52px] text-right font-semibold ${up ? "text-emerald-400" : ch < 0 ? "text-red-400" : "text-[#4b5563]"}`}>
                        {ch > 0 ? "+" : ""}{ch.toFixed(2)}%
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* History */}
          <div className="card p-5 max-h-80 overflow-y-auto">
            <div className="flex items-center justify-between mb-3">
              <p className="section-label">{t("history.title", lang)}</p>
              {agent.history.length > 0 && (
                <span className="text-[11px] text-[#6b7280] stat-value">{agent.history.length} {t("history.total", lang)}</span>
              )}
            </div>
            {agent.history.length === 0 ? (
              <div className="text-center py-6">
                <p className="text-xs text-[#4b5563]">{t("history.empty", lang)}</p>
              </div>
            ) : (
              <>
                {(() => {
                  const buys = agent.history.filter((h) => h.action === "BUY");
                  const sells = agent.history.filter((h) => h.action === "SELL");
                  const holds = agent.history.filter((h) => h.action === "HOLD");
                  const totalVol = [...buys, ...sells].reduce((s, h) => s + h.amountUSD, 0);
                  return (
                    <div className="grid grid-cols-4 gap-2 mb-4">
                      <div className="data-cell">
                        <p className="text-[10px] text-[#6b7280] mb-0.5">{t("history.buys", lang)}</p>
                        <p className="text-sm font-bold text-emerald-400 stat-value">{buys.length}</p>
                      </div>
                      <div className="data-cell">
                        <p className="text-[10px] text-[#6b7280] mb-0.5">{t("history.sells", lang)}</p>
                        <p className="text-sm font-bold text-red-400 stat-value">{sells.length}</p>
                      </div>
                      <div className="data-cell">
                        <p className="text-[10px] text-[#6b7280] mb-0.5">{t("history.holds", lang)}</p>
                        <p className="text-sm font-bold text-amber-400 stat-value">{holds.length}</p>
                      </div>
                      <div className="data-cell">
                        <p className="text-[10px] text-[#6b7280] mb-0.5">{t("history.volume", lang)}</p>
                        <p className="text-sm font-bold text-[#e5e7eb] stat-value">${fmtUSD(totalVol)}</p>
                      </div>
                    </div>
                  );
                })()}
                <div className="space-y-1.5">
                  {agent.history.slice().reverse().map((h, i) => (
                    <div key={i} className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg bg-[#0c0e16] border border-transparent hover:border-white/[0.04] transition-all">
                      <span className={`text-[9px] font-bold uppercase px-2 py-1 rounded-md min-w-[44px] text-center ${
                        h.action === "BUY" ? "bg-emerald-500/12 text-emerald-400" :
                        h.action === "SELL" ? "bg-red-500/12 text-red-400" :
                        "bg-amber-500/10 text-amber-400"
                      }`}>{h.action}</span>
                      <span className="text-xs stat-value text-[#e5e7eb] font-semibold min-w-[40px]">{h.symbol}</span>
                      <span className="text-[11px] stat-value text-[#9ca3af] flex-1 text-right">
                        {h.amountUSD > 0 ? `$${fmtUSD(h.amountUSD)}` : "-"}
                      </span>
                      <span className={`text-[10px] stat-value min-w-[36px] text-right font-semibold ${
                        h.confidence >= 0.6 ? "text-emerald-400" : h.confidence >= 0.4 ? "text-amber-400" : "text-[#4b5563]"
                      }`}>{Math.round(h.confidence * 100)}%</span>
                      <span className="text-[10px] text-[#3d4254] min-w-[55px] text-right stat-value">
                        {new Date(h.timestamp * 1000).toLocaleTimeString()}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>

        {/* RIGHT — AI Log with TA details */}
        <div className="lg:col-span-4 card p-5 flex flex-col max-h-[calc(100vh-100px)]">
          <div className="flex items-center justify-between mb-4">
            <p className="section-label">{t("log.title", lang)}</p>
            <span className="text-[11px] text-[#6b7280] stat-value">{aiLog.length} {t("log.entries", lang)}</span>
          </div>

          <div className="flex-1 overflow-y-auto space-y-2.5 min-h-0">
            {aiLog.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-32 text-[#3d4254]">
                <BarChart3 className="w-8 h-8 mb-2 opacity-30" />
                <p className="text-xs">{t("log.empty", lang)}</p>
              </div>
            ) : (
              aiLog.map((entry) => {
                const d = entry.decision;
                const confPct = Math.round(d.confidence * 100);
                const confGradient = confPct >= 60 ? "from-emerald-500 to-emerald-400" : confPct >= 40 ? "from-amber-500 to-amber-400" : "from-red-500 to-red-400";
                const confTextColor = confPct >= 60 ? "text-emerald-400" : confPct >= 40 ? "text-amber-400" : "text-red-400";
                const expanded = expandedLogs.has(entry.id);
                const a = d.analysis;

                const summaryText = d.action === "BUY"
                  ? `${t("log.summary_buy", lang)} ${d.symbol} — $${fmtUSD(d.amountUSD)}`
                  : d.action === "SELL"
                  ? `${t("log.summary_sell", lang)} ${d.symbol} — $${fmtUSD(d.amountUSD)}`
                  : `${t("log.summary_hold", lang)} — ${d.symbol}`;

                const confExplain = confPct >= 60 ? t("log.conf_high", lang)
                  : confPct >= 40 ? t("log.conf_medium", lang)
                  : t("log.conf_low", lang);

                return (
                  <div key={entry.id} className="log-entry">
                    <button onClick={() => toggleLog(entry.id)}
                      className="w-full flex items-center justify-between px-3.5 py-3 hover:bg-white/[0.02] transition-colors text-left">
                      <div className="flex items-center gap-2.5 flex-1 min-w-0">
                        <span className={`text-[10px] font-bold uppercase px-2 py-1 rounded-md shrink-0 ${
                          d.action === "BUY" ? "bg-emerald-500/12 text-emerald-400" :
                          d.action === "SELL" ? "bg-red-500/12 text-red-400" :
                          "bg-amber-500/10 text-amber-400"
                        }`}>{d.action}</span>
                        <span className="text-xs text-[#e5e7eb] truncate font-medium">{summaryText}</span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0 ml-2">
                        <span className="text-[10px] text-[#3d4254] stat-value">{new Date(entry.timestamp).toLocaleTimeString()}</span>
                        {expanded ? <ChevronUp className="w-3.5 h-3.5 text-[#4b5563]" /> : <ChevronDown className="w-3.5 h-3.5 text-[#4b5563]" />}
                      </div>
                    </button>

                    {expanded && (
                      <div className="px-3.5 pb-4 border-t border-white/[0.04] animate-slide-up">
                        {/* Recommendation + Score */}
                        <div className="mt-3 flex items-center gap-2 flex-wrap">
                          <span className={`text-[10px] font-bold uppercase px-2.5 py-1 rounded-md ${
                            a.recommendation.includes("BUY") ? "bg-emerald-500/12 text-emerald-400" :
                            a.recommendation.includes("SELL") ? "bg-red-500/12 text-red-400" :
                            "bg-amber-500/10 text-amber-400"
                          }`}>{a.recommendation}</span>
                          <span className="text-[10px] text-[#6b7280]">
                            Score: <span className={`font-semibold ${a.overallScore > 0 ? "text-emerald-400" : a.overallScore < 0 ? "text-red-400" : "text-[#9ca3af]"}`}>
                              {(a.overallScore * 100).toFixed(0)}%
                            </span>
                          </span>
                          <span className={`text-[10px] px-2 py-0.5 rounded-md font-medium ${
                            d.riskLevel === "low" ? "bg-emerald-500/8 text-emerald-400" :
                            d.riskLevel === "high" ? "bg-red-500/8 text-red-400" :
                            "bg-amber-500/8 text-amber-400"
                          }`}>{d.riskLevel} risk</span>
                        </div>

                        {/* TA Indicators */}
                        <div className="mt-3 grid grid-cols-3 gap-2">
                          {[
                            { label: "RSI", value: a.rsi.toFixed(1), color: a.rsi < 30 ? "text-emerald-400" : a.rsi > 70 ? "text-red-400" : "text-[#e5e7eb]" },
                            { label: "MACD", value: a.macd.histogram.toFixed(4), color: a.macd.histogram > 0 ? "text-emerald-400" : "text-red-400" },
                            { label: "ADX", value: a.adx.toFixed(1), color: a.adx > 25 ? "text-emerald-400" : "text-[#6b7280]" },
                            { label: "BB %B", value: `${(a.bollinger.percentB * 100).toFixed(0)}%`, color: a.bollinger.percentB < 0.2 ? "text-emerald-400" : a.bollinger.percentB > 0.8 ? "text-red-400" : "text-[#e5e7eb]" },
                            { label: "Stoch %K", value: a.stochastic.k.toFixed(0), color: a.stochastic.k < 20 ? "text-emerald-400" : a.stochastic.k > 80 ? "text-red-400" : "text-[#e5e7eb]" },
                            { label: t("ta.trend", lang), value: a.trend.trend.replace("_", " "), color: a.trend.trend.includes("up") ? "text-emerald-400" : a.trend.trend.includes("down") ? "text-red-400" : "text-[#6b7280]" },
                          ].map((ind) => (
                            <div key={ind.label} className="data-cell">
                              <p className="text-[9px] text-[#4b5563] mb-0.5">{ind.label}</p>
                              <p className={`text-xs stat-value font-bold ${ind.color}`}>{ind.value}</p>
                            </div>
                          ))}
                        </div>

                        {/* Signals list */}
                        {d.signalsSummary.length > 0 && (
                          <div className="mt-3 space-y-1.5">
                            <p className="text-[10px] text-[#4b5563] font-semibold">{t("ta.signals", lang)}</p>
                            {d.signalsSummary.slice(0, 5).map((sig, si) => (
                              <div key={si} className="text-[10px] text-[#9ca3af] flex items-start gap-2">
                                <span className={`shrink-0 mt-1 w-1.5 h-1.5 rounded-full ${
                                  sig.includes("BUY") ? "bg-emerald-400" : sig.includes("SELL") ? "bg-red-400" : "bg-[#4b5563]"
                                }`} />
                                <span>{sig}</span>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Confidence bar */}
                        <div className="mt-3">
                          <div className="flex items-center justify-between mb-1.5">
                            <p className="text-[10px] text-[#4b5563] font-semibold">{t("log.confidence", lang)}</p>
                            <span className={`text-xs font-bold stat-value ${confTextColor}`}>{confPct}%</span>
                          </div>
                          <div className="progress-track">
                            <div className={`progress-fill bg-gradient-to-r ${confGradient}`} style={{ width: `${confPct}%` }} />
                          </div>
                          <p className={`text-[10px] mt-1.5 font-medium ${confTextColor}`}>{confExplain}</p>
                        </div>

                        {/* Reasoning */}
                        <div className="mt-3 pt-3 border-t border-white/[0.04]">
                          <p className="text-[10px] text-[#4b5563] font-semibold mb-1">{t("ta.reasoning", lang)}</p>
                          <p className="text-[11px] text-[#9ca3af] leading-relaxed">{d.reasoning}</p>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            )}
            <div ref={logEndRef} />
          </div>
        </div>
      </div>

      {/* P&L PERFORMANCE PANEL */}
      {pnlMetrics && agent.history.length > 0 && (
        <div className="card p-5 mt-4 relative overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-emerald-500/20 via-blue-500/20 to-purple-500/20" />
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2.5">
              <p className="section-label">{t("pnl.title", lang)}</p>
              <span className={`tag text-[10px] border ${pnlMetrics.totalPnLUSD >= 0 ? "bg-emerald-500/8 text-emerald-400 border-emerald-500/20" : "bg-red-500/8 text-red-400 border-red-500/20"}`}>
                {pnlMetrics.totalPnLUSD >= 0 ? "+" : ""}{pnlMetrics.totalPnLPct.toFixed(2)}%
              </span>
            </div>
            <span className="text-[11px] text-[#6b7280] stat-value">{pnlMetrics.totalTrades} {t("pnl.trades", lang).toLowerCase()}</span>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2">
            {[
              { label: t("pnl.total", lang), value: `${pnlMetrics.totalPnLUSD >= 0 ? "+" : ""}$${fmtUSD(Math.abs(pnlMetrics.totalPnLUSD))}`, color: pnlMetrics.totalPnLUSD >= 0 ? "text-emerald-400" : "text-red-400" },
              { label: t("pnl.realized", lang), value: `${pnlMetrics.realizedPnLUSD >= 0 ? "+" : ""}$${fmtUSD(Math.abs(pnlMetrics.realizedPnLUSD))}`, color: pnlMetrics.realizedPnLUSD >= 0 ? "text-emerald-400" : "text-red-400" },
              { label: t("pnl.unrealized", lang), value: `${pnlMetrics.unrealizedPnLUSD >= 0 ? "+" : ""}$${fmtUSD(Math.abs(pnlMetrics.unrealizedPnLUSD))}`, color: pnlMetrics.unrealizedPnLUSD >= 0 ? "text-emerald-400" : "text-red-400" },
              { label: t("pnl.win_rate", lang), value: pnlMetrics.totalTrades > 0 ? `${pnlMetrics.winRate.toFixed(0)}%` : "—", color: pnlMetrics.winRate >= 50 ? "text-emerald-400" : pnlMetrics.totalTrades === 0 ? "text-[#6b7280]" : "text-red-400", sub: pnlMetrics.totalTrades > 0 ? `${pnlMetrics.winningTrades}${t("pnl.wins", lang)}/${pnlMetrics.losingTrades}${t("pnl.losses", lang)}` : undefined },
              { label: t("pnl.profit_factor", lang), value: pnlMetrics.totalTrades > 0 ? (pnlMetrics.profitFactor === Infinity ? "∞" : pnlMetrics.profitFactor.toFixed(2)) : "—", color: pnlMetrics.profitFactor >= 1.5 ? "text-emerald-400" : pnlMetrics.profitFactor >= 1 ? "text-amber-400" : pnlMetrics.totalTrades === 0 ? "text-[#6b7280]" : "text-red-400" },
              { label: t("pnl.max_dd", lang), value: pnlMetrics.maxDrawdown > 0 ? `-${pnlMetrics.maxDrawdown.toFixed(1)}%` : "0%", color: "text-red-400" },
              { label: t("pnl.sharpe", lang), value: pnlMetrics.sharpeRatio.toFixed(2), color: pnlMetrics.sharpeRatio >= 1 ? "text-emerald-400" : pnlMetrics.sharpeRatio >= 0 ? "text-amber-400" : "text-red-400" },
              { label: t("pnl.streak", lang), value: pnlMetrics.currentStreak > 0 ? `+${pnlMetrics.currentStreak}` : pnlMetrics.currentStreak === 0 ? "—" : `${pnlMetrics.currentStreak}`, color: pnlMetrics.currentStreak > 0 ? "text-emerald-400" : pnlMetrics.currentStreak < 0 ? "text-red-400" : "text-[#6b7280]", sub: (pnlMetrics.longestWinStreak > 0 || pnlMetrics.longestLossStreak > 0) ? `${pnlMetrics.longestWinStreak}${t("pnl.wins", lang)} / ${pnlMetrics.longestLossStreak}${t("pnl.losses", lang)}` : undefined },
            ].map((m) => (
              <div key={m.label} className="data-cell">
                <p className="text-[9px] text-[#4b5563] uppercase mb-0.5">{m.label}</p>
                <p className={`text-sm font-bold stat-value ${m.color}`}>{m.value}</p>
                {(m as any).sub && <p className="text-[9px] text-[#4b5563] mt-0.5">{(m as any).sub}</p>}
              </div>
            ))}
          </div>

          {/* Equity allocation bar */}
          <div className="mt-4 flex items-center gap-4">
            <div className="flex-1">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[9px] text-[#4b5563] uppercase font-semibold">{t("pnl.equity", lang)}</span>
                <span className="text-[11px] stat-value text-[#e5e7eb] font-semibold">${fmtUSD(pnlMetrics.totalEquity)}</span>
              </div>
              <div className="h-2 bg-[#0c0e16] rounded-full overflow-hidden flex">
                <div className="h-full bg-gradient-to-r from-blue-500 to-blue-400 transition-all duration-500" style={{ width: `${pnlMetrics.cashPct}%` }} />
                <div className="h-full bg-gradient-to-r from-emerald-500 to-emerald-400 transition-all duration-500" style={{ width: `${pnlMetrics.positionsPct}%` }} />
              </div>
              <div className="flex justify-between mt-1">
                <span className="text-[9px] text-blue-400 font-medium">{t("pnl.cash_pct", lang)} {pnlMetrics.cashPct.toFixed(0)}%</span>
                <span className="text-[9px] text-emerald-400 font-medium">{t("pnl.pos_pct", lang)} {pnlMetrics.positionsPct.toFixed(0)}%</span>
              </div>
            </div>
            {pnlMetrics.totalTrades > 0 && (
              <div className="text-right shrink-0 pl-4 border-l border-white/[0.04]">
                <p className="text-[9px] text-[#4b5563] uppercase font-semibold">{t("pnl.expectancy", lang)}</p>
                <p className={`text-sm stat-value font-bold ${pnlMetrics.expectancy >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {pnlMetrics.expectancy >= 0 ? "+" : ""}${fmtUSD(Math.abs(pnlMetrics.expectancy))}
                </p>
                <p className="text-[9px] text-[#3d4254]">{t("pnl.per_trade", lang)}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* JUPITER DEX + ON-CHAIN */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">

        {/* Jupiter DEX Status */}
        <div className="card p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <p className="section-label">{t("jupiter.title", lang)}</p>
              <span className={`tag text-[10px] border ${swapSettings.enableRealSwaps ? "bg-red-500/8 text-red-400 border-red-500/20" : "bg-emerald-500/8 text-emerald-400 border-emerald-500/20"}`}>
                {swapSettings.enableRealSwaps ? "LIVE" : t("jupiter.simulation", lang)}
              </span>
            </div>
            <button onClick={() => setShowSwapSettings(true)}
              className="btn-secondary px-3 py-1.5 text-[10px]">
              {t("jupiter.settings", lang)}
            </button>
          </div>

          <div className="space-y-2 text-xs">
            {[
              { label: t("jupiter.slippage", lang), value: `${(swapSettings.slippageBps / 100).toFixed(1)}%` },
              { label: t("jupiter.max_trade", lang), value: `$${swapSettings.maxTradeUSD}` },
              { label: t("jupiter.max_impact", lang), value: `${swapSettings.maxPriceImpactPct}%` },
            ].map((row) => (
              <div key={row.label} className="flex justify-between">
                <span className="text-[#6b7280]">{row.label}</span>
                <span className="stat-value text-[#e5e7eb]">{row.value}</span>
              </div>
            ))}
          </div>

          {lastSwapResults.length > 0 && (
            <div className="mt-4 pt-3 border-t border-white/[0.04]">
              <p className="text-[10px] text-[#4b5563] font-semibold mb-2">{lang === "ru" ? "Последние свопы" : "Recent Swaps"}</p>
              <div className="space-y-1.5">
                {lastSwapResults.slice(0, 4).map((sr, i) => (
                  <div key={i} className={`flex items-center justify-between rounded-lg px-3 py-2 bg-[#0c0e16] border border-white/[0.03] ${sr.success ? "" : "opacity-40"}`}>
                    <span className="text-[10px] stat-value text-[#9ca3af]">
                      {sr.inputAmount.toFixed(3)} {sr.inputSymbol} → {sr.outputAmount.toFixed(3)} {sr.outputSymbol}
                    </span>
                    {sr.success
                      ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                      : <AlertTriangle className="w-3.5 h-3.5 text-red-400" />}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Token Balances */}
        <div className="card p-5">
          <p className="section-label mb-3">{t("jupiter.balances", lang)}</p>
          {!connected ? (
            <div className="text-center py-6">
              <Wallet className="w-8 h-8 mx-auto mb-2 text-[#3d4254]" />
              <p className="text-xs text-[#4b5563]">{t("jupiter.no_wallet", lang)}</p>
            </div>
          ) : Object.keys(tokenBalances).length === 0 ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="w-5 h-5 text-[#3d4254] animate-spin" />
            </div>
          ) : (
            <div className="space-y-1.5">
              {Object.entries(tokenBalances)
                .filter(([, bal]) => bal > 0.000001)
                .sort(([, a], [, b]) => b - a)
                .map(([sym, bal]) => {
                  const asset = assets.find((a) => COINGECKO_TO_SYMBOL[a.id] === sym);
                  const usdVal = asset ? bal * asset.currentPrice : 0;
                  return (
                    <div key={sym} className="flex items-center justify-between rounded-lg px-3 py-2.5 bg-[#0c0e16] border border-white/[0.03]">
                      <div className="flex items-center gap-2">
                        <span className="stat-value text-xs text-[#e5e7eb] font-semibold">{sym}</span>
                        <span className="text-[10px] text-[#4b5563] stat-value">{bal < 0.01 ? bal.toFixed(6) : bal < 1 ? bal.toFixed(4) : bal.toFixed(2)}</span>
                      </div>
                      {usdVal > 0.01 && (
                        <span className="stat-value text-[10px] text-[#6b7280]">${fmtUSD(usdVal)}</span>
                      )}
                    </div>
                  );
                })}
            </div>
          )}
        </div>

        {/* On-Chain Transactions */}
        <div className="card p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <p className="section-label">On-Chain TX</p>
              <span className="tag bg-purple-500/8 text-purple-400 text-[10px] border border-purple-500/20">{SOLANA_NETWORK}</span>
              {connected && <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />}
            </div>
            {!connected && (
              <button onClick={() => setWalletModalVisible(true)}
                className="btn-secondary px-3 py-1.5 text-[10px] flex items-center gap-1.5">
                <Wallet className="w-3 h-3" /> Connect
              </button>
            )}
          </div>

          {!connected ? (
            <div className="text-center py-6">
              <div className="w-10 h-10 mx-auto mb-2 rounded-xl bg-purple-500/8 flex items-center justify-center">
                <Wallet className="w-5 h-5 text-purple-400/50" />
              </div>
              <p className="text-xs text-[#4b5563]">
                {lang === "ru"
                  ? "Подключи Phantom для записи в блокчейн"
                  : "Connect Phantom for on-chain recording"}
              </p>
            </div>
          ) : (
            <div className="space-y-1.5">
              {txSignatures.length === 0 ? (
                <div className="text-center py-4">
                  <p className="text-xs text-[#4b5563]">
                    {lang === "ru"
                      ? "Запусти ИИ — BUY/SELL запишется on-chain"
                      : "Run AI — BUY/SELL will be recorded on-chain"}
                  </p>
                </div>
              ) : (
                txSignatures.slice(0, 6).map((sig, i) => (
                  <div key={sig + i} className="flex items-center justify-between rounded-lg px-3 py-2.5 bg-[#0c0e16] border border-white/[0.03]">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                      <span className="stat-value text-[10px] text-[#9ca3af]">{sig.slice(0, 12)}...{sig.slice(-6)}</span>
                    </div>
                    <a href={getExplorerUrl(sig)} target="_blank" rel="noopener noreferrer"
                      className="text-[10px] text-blue-400 hover:text-blue-300 font-medium transition-colors">
                      Explorer →
                    </a>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      {/* TELEGRAM ALERTS */}
      <div className="card p-5 mt-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2.5">
            <p className="section-label">{t("tg.title", lang)}</p>
            <span className={`tag text-[10px] border ${tgSettings.enabled ? "bg-emerald-500/8 text-emerald-400 border-emerald-500/20" : "bg-white/[0.03] text-[#4b5563] border-white/[0.06]"}`}>
              {tgSettings.enabled ? t("tg.enabled", lang) : t("tg.disabled", lang)}
            </span>
            {tgAlertCount > 0 && (
              <span className="text-[11px] text-[#6b7280] stat-value">{tgAlertCount} {t("tg.alerts_sent", lang)}</span>
            )}
          </div>
          <button onClick={() => setShowTgSettings((v) => !v)}
            className="btn-secondary px-3 py-1.5 text-[10px] flex items-center gap-1.5">
            {showTgSettings ? <ChevronUp className="w-3 h-3" /> : <Settings className="w-3 h-3" />}
            {showTgSettings ? (lang === "ru" ? "Скрыть" : "Hide") : (lang === "ru" ? "Настройки" : "Settings")}
          </button>
        </div>

        {tgSettings.enabled && tgLastSent && (
          <p className="text-[10px] text-[#4b5563] mb-3">{t("tg.last_sent", lang)}: {tgLastSent}</p>
        )}

        {showTgSettings && (
          <div className="space-y-4 mt-3 animate-slide-up">
            <p className="text-[11px] text-[#6b7280]">{t("tg.setup_hint", lang)}</p>

            <div>
              <label className="section-label">{t("tg.bot_token", lang)}</label>
              <input type="password" value={tgSettings.botToken}
                onChange={(e) => setTgSettings((s) => ({ ...s, botToken: e.target.value }))}
                placeholder="123456:ABC-DEF..."
                className="input-field w-full mt-1.5 text-xs stat-value" />
            </div>

            <div>
              <label className="section-label">{t("tg.chat_id", lang)}</label>
              <input type="text" value={tgSettings.chatId}
                onChange={(e) => setTgSettings((s) => ({ ...s, chatId: e.target.value }))}
                placeholder="-1001234567890"
                className="input-field w-full mt-1.5 text-xs stat-value" />
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <button onClick={() => setTgSettings((s) => ({ ...s, enabled: !s.enabled }))}
                className={`px-3 py-2 rounded-lg text-xs font-semibold flex items-center gap-2 justify-center transition-all border ${
                  tgSettings.enabled ? "bg-emerald-500/8 text-emerald-400 border-emerald-500/20" : "bg-[#0c0e16] text-[#4b5563] border-white/[0.04]"
                }`}>
                <div className={`w-2 h-2 rounded-full ${tgSettings.enabled ? "bg-emerald-400" : "bg-[#4b5563]"}`} />
                {tgSettings.enabled ? t("tg.enabled", lang) : t("tg.disabled", lang)}
              </button>
              <button onClick={() => setTgSettings((s) => ({ ...s, sendTradeAlerts: !s.sendTradeAlerts }))}
                className={`px-3 py-2 rounded-lg text-xs font-semibold flex items-center gap-2 justify-center transition-all border ${
                  tgSettings.sendTradeAlerts ? "bg-blue-500/8 text-blue-400 border-blue-500/20" : "bg-[#0c0e16] text-[#4b5563] border-white/[0.04]"
                }`}>
                {t("tg.trade_alerts", lang)}
              </button>
              <button onClick={() => setTgSettings((s) => ({ ...s, sendPnLReports: !s.sendPnLReports }))}
                className={`px-3 py-2 rounded-lg text-xs font-semibold flex items-center gap-2 justify-center transition-all border ${
                  tgSettings.sendPnLReports ? "bg-purple-500/8 text-purple-400 border-purple-500/20" : "bg-[#0c0e16] text-[#4b5563] border-white/[0.04]"
                }`}>
                {t("tg.pnl_reports", lang)}
              </button>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-[#4b5563] shrink-0">{t("tg.report_interval", lang)}</span>
                <select value={tgSettings.reportIntervalMin}
                  onChange={(e) => setTgSettings((s) => ({ ...s, reportIntervalMin: Number(e.target.value) }))}
                  className="bg-[#0c0e16] border border-white/[0.06] rounded-lg px-2 py-1.5 text-xs text-[#e5e7eb] focus:outline-none focus:border-emerald-500/30 transition-colors">
                  <option value={15}>15{t("tg.minutes", lang)}</option>
                  <option value={30}>30{t("tg.minutes", lang)}</option>
                  <option value={60}>60{t("tg.minutes", lang)}</option>
                  <option value={0}>Off</option>
                </select>
              </div>
            </div>

            <button
              onClick={async () => {
                setTgTesting(true);
                const result = await testTelegramConnection(tgSettings.botToken, tgSettings.chatId);
                if (result.success) { addToast(t("tg.test_ok", lang), "success"); }
                else { addToast(`${t("tg.test_fail", lang)}: ${result.error || ""}`, "error"); }
                setTgTesting(false);
              }}
              disabled={tgTesting || !tgSettings.botToken || !tgSettings.chatId}
              className="btn-primary px-4 py-2.5 text-xs w-full flex items-center justify-center gap-2 disabled:opacity-40">
              {tgTesting ? (
                <><Loader2 className="w-3.5 h-3.5 animate-spin" />{t("tg.testing", lang)}</>
              ) : t("tg.test", lang)}
            </button>
          </div>
        )}
      </div>

      {/* ML PREDICTOR */}
      <div className="card p-5 mt-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2.5">
            <p className="section-label">{t("ml.title", lang)}</p>
            {mlMetrics && (
              <span className={`tag text-[10px] border ${mlMetrics.testAccuracy > 0.52 ? "bg-emerald-500/8 text-emerald-400 border-emerald-500/20" : "bg-amber-500/8 text-amber-400 border-amber-500/20"}`}>
                Test: {(mlMetrics.testAccuracy * 100).toFixed(0)}%
              </span>
            )}
            {mlPrediction && (
              <span className={`tag text-[10px] border ${mlPrediction.direction === "UP" ? "bg-emerald-500/8 text-emerald-400 border-emerald-500/20" : "bg-red-500/8 text-red-400 border-red-500/20"}`}>
                {mlPrediction.direction === "UP" ? "↑" : "↓"} {t(mlPrediction.direction === "UP" ? "ml.up" : "ml.down", lang)} {(mlPrediction.confidence * 100).toFixed(0)}%
              </span>
            )}
          </div>
          <button onClick={() => setShowMlPanel((v) => !v)}
            className="btn-secondary px-3 py-1.5 text-[10px] flex items-center gap-1.5">
            {showMlPanel ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {showMlPanel ? (lang === "ru" ? "Скрыть" : "Hide") : (lang === "ru" ? "Подробнее" : "Details")}
          </button>
        </div>

        {showMlPanel && (
          <div className="space-y-4 mt-3 animate-slide-up">
            {/* Config row */}
            <div className="grid grid-cols-4 gap-3">
              {[
                { label: t("ml.hidden_size", lang), value: mlConfig.hiddenSize, setter: (v: number) => setMlConfig((c) => ({ ...c, hiddenSize: v })), options: [16, 32, 64] },
                { label: t("ml.epochs", lang), value: mlConfig.epochs, setter: (v: number) => setMlConfig((c) => ({ ...c, epochs: v })), options: [50, 100, 200] },
                { label: t("ml.lookback", lang), value: mlConfig.lookback, setter: (v: number) => setMlConfig((c) => ({ ...c, lookback: v })), options: [7, 14, 21] },
              ].map((cfg) => (
                <div key={cfg.label}>
                  <label className="section-label">{cfg.label}</label>
                  <select value={cfg.value} onChange={(e) => cfg.setter(Number(e.target.value))}
                    className="w-full mt-1.5 bg-[#0c0e16] border border-white/[0.06] rounded-lg px-2.5 py-2 text-xs text-[#e5e7eb] focus:outline-none focus:border-emerald-500/30 transition-colors">
                    {cfg.options.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
              ))}
              <div className="flex items-end">
                <button onClick={handleTrainML} disabled={mlTraining}
                  className="btn-primary px-4 py-2 text-xs w-full flex items-center justify-center gap-1.5 disabled:opacity-40">
                  {mlTraining ? (
                    <><Loader2 className="w-3.5 h-3.5 animate-spin" />{mlProgress ? `${mlProgress.epoch}/${mlProgress.totalEpochs}` : t("ml.training", lang)}</>
                  ) : t("ml.train", lang)}
                </button>
              </div>
            </div>

            {/* Training progress */}
            {mlTraining && mlProgress && (
              <div>
                <div className="flex justify-between text-[10px] text-[#6b7280] mb-1.5">
                  <span>{t("ml.progress", lang)}: {mlProgress.epoch}/{mlProgress.totalEpochs}</span>
                  <span className="stat-value">Loss: {mlProgress.trainLoss.toFixed(4)} | Train: {(mlProgress.trainAcc * 100).toFixed(0)}% | Test: {(mlProgress.testAcc * 100).toFixed(0)}%</span>
                </div>
                <div className="progress-track">
                  <div className="progress-fill bg-gradient-to-r from-blue-500 to-cyan-400" style={{ width: `${(mlProgress.epoch / mlProgress.totalEpochs) * 100}%` }} />
                </div>
              </div>
            )}

            {/* Results */}
            {mlMetrics && (
              <div className="space-y-4">
                <div className="grid grid-cols-5 gap-2">
                  {[
                    { label: t("ml.train_acc", lang), value: `${(mlMetrics.trainAccuracy * 100).toFixed(1)}%`, color: mlMetrics.trainAccuracy > 0.55 ? "text-emerald-400" : "text-amber-400" },
                    { label: t("ml.test_acc", lang), value: `${(mlMetrics.testAccuracy * 100).toFixed(1)}%`, color: mlMetrics.testAccuracy > 0.52 ? "text-emerald-400" : "text-red-400" },
                    { label: t("ml.samples", lang), value: `${mlMetrics.totalSamples}`, color: "text-[#e5e7eb]" },
                    { label: t("ml.epochs", lang), value: `${mlMetrics.epochsRun}`, color: "text-[#e5e7eb]" },
                    { label: t("ml.loss", lang), value: mlMetrics.trainLoss.toFixed(4), color: "text-[#e5e7eb]" },
                  ].map((m) => (
                    <div key={m.label} className="data-cell">
                      <p className="text-[9px] text-[#4b5563] uppercase mb-0.5">{m.label}</p>
                      <p className={`text-sm font-bold stat-value ${m.color}`}>{m.value}</p>
                    </div>
                  ))}
                </div>

                {/* Current prediction */}
                {mlPrediction && (
                  <div className={`rounded-xl p-4 border ${mlPrediction.direction === "UP" ? "bg-emerald-500/5 border-emerald-500/15" : "bg-red-500/5 border-red-500/15"}`}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className={`text-xl font-extrabold ${mlPrediction.direction === "UP" ? "text-emerald-400" : "text-red-400"}`}>
                          {mlPrediction.direction === "UP" ? "↑" : "↓"} {t(mlPrediction.direction === "UP" ? "ml.up" : "ml.down", lang)}
                        </span>
                        <span className="text-xs text-[#6b7280]">
                          {t("ml.confidence", lang)}: <span className="font-semibold text-[#e5e7eb]">{(mlPrediction.confidence * 100).toFixed(0)}%</span>
                        </span>
                      </div>
                      <div className="text-right">
                        <p className="text-[9px] text-[#4b5563] uppercase">{t("ml.target", lang)}</p>
                        <p className="text-sm stat-value text-[#e5e7eb] font-bold">${fmtUSD(mlPrediction.priceTarget)}</p>
                      </div>
                    </div>
                  </div>
                )}

                {/* Ensemble model votes */}
                {mlMetrics.modelVotes && mlMetrics.modelVotes.length > 0 && (
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-[10px] text-[#4b5563] font-semibold uppercase">Ensemble Models</p>
                      {mlMetrics.ensembleAccuracy !== undefined && (
                        <span className={`text-[10px] font-semibold ${mlMetrics.ensembleAccuracy > 0.52 ? "text-emerald-400" : "text-amber-400"}`}>
                          Ensemble: {(mlMetrics.ensembleAccuracy * 100).toFixed(0)}%
                        </span>
                      )}
                    </div>
                    <div className="grid grid-cols-4 gap-2">
                      {mlMetrics.modelVotes.map((mv) => (
                        <div key={mv.model} className="data-cell">
                          <p className="text-[10px] text-[#6b7280] truncate">{mv.model}</p>
                          <p className={`text-xs font-bold stat-value ${mv.accuracy > 0.52 ? "text-emerald-400" : mv.accuracy > 0.48 ? "text-amber-400" : "text-red-400"}`}>
                            {(mv.accuracy * 100).toFixed(0)}%
                          </p>
                          <div className="w-full bg-[#0c0e16] rounded-full h-1 mt-1.5">
                            <div className="bg-blue-500/50 rounded-full h-1 transition-all" style={{ width: `${mv.weight * 100}%` }} />
                          </div>
                          <p className="text-[9px] text-[#3d4254] mt-0.5">w: {(mv.weight * 100).toFixed(0)}%</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Ensemble vote breakdown */}
                {mlPrediction?.ensemble && (
                  <div className="grid grid-cols-4 gap-2">
                    {[
                      { label: "NN", value: mlPrediction.ensemble.nnVote },
                      { label: "Momentum", value: mlPrediction.ensemble.momentumVote },
                      { label: "Mean Rev", value: mlPrediction.ensemble.meanRevVote },
                      { label: "Trend", value: mlPrediction.ensemble.trendVote },
                    ].map((v) => (
                      <div key={v.label} className="flex items-center gap-1.5">
                        <span className="text-[9px] text-[#4b5563] w-14 shrink-0 font-medium">{v.label}</span>
                        <div className="flex-1 bg-[#0c0e16] rounded-full h-2 relative overflow-hidden">
                          <div className={`absolute top-0 h-2 rounded-full transition-all ${v.value > 0.5 ? "bg-emerald-500/40" : "bg-red-500/40"}`}
                            style={{ width: `${Math.abs(v.value - 0.5) * 200}%`, left: v.value > 0.5 ? "50%" : `${v.value * 100}%` }} />
                        </div>
                        <span className={`text-[9px] w-6 text-right font-bold ${v.value > 0.5 ? "text-emerald-400" : "text-red-400"}`}>
                          {v.value > 0.5 ? "↑" : "↓"}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Feature importance */}
                <div>
                  <p className="text-[10px] text-[#4b5563] font-semibold uppercase mb-2">{t("ml.features", lang)}</p>
                  <div className="grid grid-cols-2 gap-1.5">
                    {mlMetrics.featureImportance.slice(0, 8).map((f) => (
                      <div key={f.name} className="flex items-center gap-2">
                        <div className="flex-1 bg-[#0c0e16] rounded-full h-1.5 overflow-hidden">
                          <div className="bg-gradient-to-r from-blue-500/50 to-cyan-400/50 rounded-full h-1.5 transition-all" style={{ width: `${f.importance * 100}%` }} />
                        </div>
                        <span className="text-[10px] text-[#6b7280] w-20 shrink-0">{f.name}</span>
                        <span className="text-[10px] text-[#9ca3af] stat-value w-8 text-right">{(f.importance * 100).toFixed(0)}%</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Test predictions */}
                {mlMetrics.predictions.length > 0 && (
                  <div>
                    <p className="text-[10px] text-[#4b5563] font-semibold uppercase mb-2">{t("ml.predictions", lang)} ({mlMetrics.predictions.filter((p) => p.actual === p.predicted).length}/{mlMetrics.predictions.length})</p>
                    <div className="flex gap-1 flex-wrap">
                      {mlMetrics.predictions.slice(-30).map((p, i) => (
                        <div key={i} className={`w-3.5 h-3.5 rounded ${p.actual === p.predicted ? "bg-emerald-500/30" : "bg-red-500/30"}`}
                          title={`${p.predicted} ${p.actual === p.predicted ? "✓" : "✗"} (${(p.confidence * 100).toFixed(0)}%)`} />
                      ))}
                    </div>
                    <div className="flex gap-4 mt-2">
                      <span className="text-[10px] text-[#4b5563] flex items-center gap-1.5">
                        <div className="w-2.5 h-2.5 rounded bg-emerald-500/30" /> {t("ml.correct", lang)}
                      </span>
                      <span className="text-[10px] text-[#4b5563] flex items-center gap-1.5">
                        <div className="w-2.5 h-2.5 rounded bg-red-500/30" /> {t("ml.wrong", lang)}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {!mlMetrics && !mlTraining && (
              <div className="text-center py-6">
                <p className="text-xs text-[#4b5563]">{t("ml.not_trained", lang)}</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* BACKTESTING SECTION */}
      <div className="card p-5 mt-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2.5">
            <p className="section-label">{t("bt.title", lang)}</p>
            <span className="tag bg-amber-500/8 text-amber-400 text-[10px] border border-amber-500/20">
              {lang === "ru" ? "Тест стратегии" : "Strategy Test"}
            </span>
          </div>
          <button onClick={() => setShowBacktest((v) => !v)}
            className="btn-secondary px-3 py-1.5 text-[10px] flex items-center gap-1.5">
            {showBacktest ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {showBacktest ? (lang === "ru" ? "Скрыть" : "Hide") : (lang === "ru" ? "Показать" : "Show")}
          </button>
        </div>

        {showBacktest && (
          <div className="space-y-4 animate-slide-up">
            {/* Config controls */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div>
                <label className="section-label">{t("bt.period", lang)}</label>
                <div className="flex gap-1.5 mt-2">
                  {[30, 60, 90].map((d) => (
                    <button key={d}
                      onClick={() => setBacktestConfig((c) => ({ ...c, days: d }))}
                      className={`flex-1 px-2.5 py-2 rounded-lg text-xs stat-value transition-all border ${backtestConfig.days === d ? "bg-amber-500/10 text-amber-400 border-amber-500/20 shadow-sm shadow-amber-500/10" : "bg-[#0c0e16] text-[#6b7280] border-transparent hover:border-white/[0.06]"}`}>
                      {d}{t("bt.days", lang).charAt(0)}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="section-label">{t("bt.capital", lang)}</label>
                <div className="flex gap-1.5 mt-2">
                  {[1000, 5000, 10000].map((c) => (
                    <button key={c}
                      onClick={() => setBacktestConfig((cfg) => ({ ...cfg, initialCapital: c }))}
                      className={`flex-1 px-2.5 py-2 rounded-lg text-xs stat-value transition-all border ${backtestConfig.initialCapital === c ? "bg-amber-500/10 text-amber-400 border-amber-500/20 shadow-sm shadow-amber-500/10" : "bg-[#0c0e16] text-[#6b7280] border-transparent hover:border-white/[0.06]"}`}>
                      ${c >= 1000 ? `${c / 1000}k` : c}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="section-label">{t("bt.strategy_label", lang)}</label>
                <div className="flex gap-1.5 mt-2">
                  {[0, 1, 2].map((s) => (
                    <button key={s}
                      onClick={() => setBacktestConfig((c) => ({ ...c, strategy: s }))}
                      className={`flex-1 px-2.5 py-2 rounded-lg text-xs transition-all border ${backtestConfig.strategy === s ? "bg-amber-500/10 text-amber-400 border-amber-500/20 shadow-sm shadow-amber-500/10" : "bg-[#0c0e16] text-[#6b7280] border-transparent hover:border-white/[0.06]"}`}>
                      {getStrategyName(s, lang)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex items-end">
                <button onClick={handleRunBacktest} disabled={backtestRunning}
                  className="btn-primary px-4 py-2 text-xs w-full flex items-center justify-center gap-2 disabled:opacity-40">
                  {backtestRunning ? (
                    <><Loader2 className="w-3.5 h-3.5 animate-spin" />{t("bt.running", lang)} {backtestProgress}%</>
                  ) : (
                    <><BarChart3 className="w-3.5 h-3.5" />{t("bt.run", lang)}</>
                  )}
                </button>
              </div>
            </div>

            {/* Progress bar */}
            {backtestRunning && (
              <div className="progress-track">
                <div className="progress-fill bg-gradient-to-r from-amber-500 to-orange-400" style={{ width: `${backtestProgress}%` }} />
              </div>
            )}

            {/* Results */}
            {backtestResult && (
              <div className="space-y-4">
                {/* Key metrics grid */}
                <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2">
                  {[
                    { label: t("bt.total_return", lang), value: `${backtestResult.metrics.totalReturn >= 0 ? "+" : ""}${backtestResult.metrics.totalReturn.toFixed(2)}%`, color: backtestResult.metrics.totalReturn >= 0 ? "text-emerald-400" : "text-red-400", sub: `${backtestResult.metrics.totalReturnUSD >= 0 ? "+" : ""}$${fmtUSD(Math.abs(backtestResult.metrics.totalReturnUSD))}` },
                    { label: t("bt.win_rate", lang), value: `${backtestResult.metrics.winRate.toFixed(1)}%`, color: backtestResult.metrics.winRate >= 50 ? "text-emerald-400" : "text-red-400", sub: `${backtestResult.metrics.winningTrades}W / ${backtestResult.metrics.losingTrades}L` },
                    { label: t("bt.max_drawdown", lang), value: `-${backtestResult.metrics.maxDrawdown.toFixed(2)}%`, color: "text-red-400", sub: `-$${fmtUSD(backtestResult.metrics.maxDrawdownUSD)}` },
                    { label: t("bt.sharpe", lang), value: backtestResult.metrics.sharpeRatio.toFixed(2), color: backtestResult.metrics.sharpeRatio >= 1 ? "text-emerald-400" : backtestResult.metrics.sharpeRatio >= 0 ? "text-amber-400" : "text-red-400", sub: backtestResult.metrics.sharpeRatio >= 2 ? "Excellent" : backtestResult.metrics.sharpeRatio >= 1 ? "Good" : backtestResult.metrics.sharpeRatio >= 0 ? "OK" : "Poor" },
                    { label: t("bt.profit_factor", lang), value: backtestResult.metrics.profitFactor === Infinity ? "∞" : backtestResult.metrics.profitFactor.toFixed(2), color: backtestResult.metrics.profitFactor >= 1.5 ? "text-emerald-400" : backtestResult.metrics.profitFactor >= 1 ? "text-amber-400" : "text-red-400", sub: `${t("bt.total_trades", lang)}: ${backtestResult.metrics.totalTrades}` },
                    { label: t("bt.final_capital", lang), value: `$${fmtUSD(backtestResult.finalCapital)}`, color: "text-white", sub: `${backtestResult.durationDays} ${t("bt.days", lang)}` },
                  ].map((m) => (
                    <div key={m.label} className="data-cell">
                      <p className="text-[9px] text-[#4b5563] uppercase mb-0.5">{m.label}</p>
                      <p className={`text-lg font-extrabold stat-value ${m.color}`}>{m.value}</p>
                      <p className="text-[10px] text-[#4b5563] mt-0.5">{m.sub}</p>
                    </div>
                  ))}
                </div>

                {/* Secondary metrics */}
                <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
                  {[
                    { label: t("bt.annual_return", lang), value: `${backtestResult.metrics.annualizedReturn >= 0 ? "+" : ""}${backtestResult.metrics.annualizedReturn.toFixed(1)}%`, color: backtestResult.metrics.annualizedReturn >= 0 ? "text-emerald-400" : "text-red-400" },
                    { label: t("bt.sortino", lang), value: backtestResult.metrics.sortinoRatio.toFixed(2), color: backtestResult.metrics.sortinoRatio >= 1 ? "text-emerald-400" : "text-amber-400" },
                    { label: t("bt.avg_win", lang), value: `$${fmtUSD(backtestResult.metrics.avgWinUSD)}`, color: "text-emerald-400" },
                    { label: t("bt.avg_loss", lang), value: `$${fmtUSD(backtestResult.metrics.avgLossUSD)}`, color: "text-red-400" },
                    { label: t("bt.best_trade", lang), value: `+${backtestResult.metrics.bestTrade.toFixed(1)}%`, color: "text-emerald-400" },
                    { label: t("bt.worst_trade", lang), value: `${backtestResult.metrics.worstTrade.toFixed(1)}%`, color: "text-red-400" },
                  ].map((m) => (
                    <div key={m.label} className="data-cell">
                      <p className="text-[9px] text-[#4b5563] mb-0.5">{m.label}</p>
                      <p className={`text-xs font-bold stat-value ${m.color}`}>{m.value}</p>
                    </div>
                  ))}
                </div>

                {/* Equity Curve */}
                {backtestResult.equityCurve.length > 0 && (
                  <div className="rounded-xl bg-[#0c0e16] border border-white/[0.03] p-4">
                    <p className="text-[10px] text-[#4b5563] font-semibold uppercase mb-3">{t("bt.equity_curve", lang)}</p>
                    <div className="flex items-end gap-px h-28">
                      {(() => {
                        const curve = backtestResult.equityCurve;
                        const step = Math.max(1, Math.floor(curve.length / 80));
                        const sampled = curve.filter((_, i) => i % step === 0);
                        const minEq = Math.min(...sampled.map((p) => p.equity));
                        const maxEq = Math.max(...sampled.map((p) => p.equity));
                        const range = maxEq - minEq || 1;

                        return sampled.map((pt, i) => {
                          const h = ((pt.equity - minEq) / range) * 100;
                          const isProfit = pt.equity >= backtestResult.initialCapital;
                          return (
                            <div key={i}
                              className={`flex-1 min-w-[1px] rounded-t transition-all ${isProfit ? "bg-emerald-500/50" : "bg-red-500/50"}`}
                              style={{ height: `${Math.max(2, h)}%` }}
                              title={`$${pt.equity.toFixed(0)} | ${new Date(pt.timestamp * 1000).toLocaleDateString()}`}
                            />
                          );
                        });
                      })()}
                    </div>
                    <div className="flex justify-between mt-2">
                      <span className="text-[9px] text-[#3d4254] stat-value">{backtestResult.startDate.toLocaleDateString()}</span>
                      <span className="text-[9px] text-[#3d4254] stat-value">{backtestResult.endDate.toLocaleDateString()}</span>
                    </div>
                  </div>
                )}

                {/* Trade Log */}
                {backtestResult.trades.length > 0 && (
                  <div>
                    <p className="text-[10px] text-[#4b5563] font-semibold uppercase mb-2">{t("bt.trade_log", lang)} ({backtestResult.trades.length})</p>
                    <div className="max-h-44 overflow-y-auto space-y-1.5">
                      {backtestResult.trades.slice(-20).reverse().map((tr, i) => (
                        <div key={i} className="flex items-center gap-2.5 rounded-lg px-3 py-2.5 bg-[#0c0e16] border border-transparent hover:border-white/[0.04] transition-all">
                          <span className={`text-[9px] font-bold uppercase px-2 py-1 rounded-md min-w-[40px] text-center ${
                            tr.action === "BUY" ? "bg-emerald-500/12 text-emerald-400" : "bg-red-500/12 text-red-400"
                          }`}>{tr.action}</span>
                          <span className="text-xs stat-value text-[#e5e7eb] font-semibold min-w-[40px]">{tr.symbol}</span>
                          <span className="text-[10px] stat-value text-[#9ca3af] flex-1">
                            ${fmtUSD(tr.amountUSD)} @ ${fmtUSD(tr.price)}
                          </span>
                          <span className={`text-[10px] stat-value font-semibold ${tr.confidence >= 0.5 ? "text-emerald-400" : "text-amber-400"}`}>
                            {Math.round(tr.confidence * 100)}%
                          </span>
                          <span className="text-[10px] text-[#3d4254] stat-value">
                            {new Date(tr.timestamp * 1000).toLocaleDateString()}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* No results state */}
            {!backtestResult && !backtestRunning && (
              <div className="text-center py-8">
                <BarChart3 className="w-10 h-10 mx-auto mb-3 text-[#3d4254] opacity-30" />
                <p className="text-xs text-[#4b5563]">{t("bt.no_data", lang)}</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

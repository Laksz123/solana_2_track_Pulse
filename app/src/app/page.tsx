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

  useEffect(() => {
    loadMarketData();
    const iv = setInterval(() => {
      fetchMarketOverview().then((o) => { if (o.length > 0) setAssets(o); });
    }, 30000); // refresh prices every 30s
    return () => clearInterval(iv);
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

    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-6 p-4">
        <div className="absolute top-4 right-4"><LangToggle lang={lang} setLang={setLang} /></div>

        <div className="text-center space-y-2">
          <h1 className="text-3xl font-bold text-white tracking-tight">{t("app.title", lang)}</h1>
          <p className="text-sm text-gray-500">{t("app.subtitle", lang)}</p>
          <div className="flex items-center justify-center gap-2 mt-1">
            <Activity className="w-4 h-4 text-green-400" />
            <span className="text-xs text-green-400 font-medium">
              {t("data.live_coingecko", lang)}
            </span>
          </div>
        </div>

        <h2 className="text-lg text-gray-300 font-medium mt-4">{t("strategy.title", lang)}</h2>
        <p className="text-sm text-gray-500 -mt-4">{t("strategy.desc", lang)}</p>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-2xl w-full">
          {[0, 1, 2].map((i) => {
            const Icon = strategyIcons[i];
            const active = selectedStrategy === i;
            return (
              <button key={i} onClick={() => setSelectedStrategy(i)}
                className={`card-hover p-5 text-center transition-all ${active ? "!border-green-500 bg-green-500/5" : ""}`}>
                <Icon className={`w-8 h-8 mx-auto mb-2 ${active ? "text-green-400" : "text-gray-600"}`} />
                <h3 className={`font-semibold text-sm ${active ? "text-white" : "text-gray-400"}`}>{getStrategyName(i, lang)}</h3>
                <p className="text-xs text-gray-600 mt-1">{strategyDescs[i]}</p>
              </button>
            );
          })}
        </div>

        <button onClick={createAgent} disabled={isProcessing} className="btn-primary px-8 py-2.5 text-sm mt-2">
          {isProcessing ? t("strategy.creating", lang) : t("strategy.create", lang)}
        </button>

        <div className="flex gap-6 mt-8 text-center">
          {[
            { icon: BarChart3, title: t("feature.ai", lang), desc: t("feature.ai.desc", lang) },
            { icon: Activity, title: t("feature.ta", lang), desc: t("feature.ta.desc", lang) },
            { icon: ShieldCheck, title: t("feature.control", lang), desc: t("feature.control.desc", lang) },
          ].map((f, i) => (
            <div key={i} className="flex-1 max-w-[160px]">
              <f.icon className="w-5 h-5 mx-auto mb-1.5 text-gray-600" />
              <p className="text-xs font-medium text-gray-400">{f.title}</p>
              <p className="text-[10px] text-gray-600 mt-0.5">{f.desc}</p>
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
    <div className={`min-h-screen p-3 md:p-5 max-w-[1400px] mx-auto relative ${isTelegram ? "tg-viewport tg-app tg-safe-top tg-bottom-pad" : ""}`}>
      {/* Telegram Mini App Header */}
      {isTelegram && tgUser && (
        <div className="flex items-center justify-between mb-3 px-1">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white text-xs font-bold">
              {tgUser.first_name?.[0] || "U"}
            </div>
            <div>
              <p className="text-xs font-medium text-gray-200">{tgUser.first_name} {tgUser.last_name || ""}</p>
              <p className="text-[10px] text-gray-500">@{tgUser.username || "user"} • {tgPlatform}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <LangToggle lang={lang} setLang={setLang} />
            {connected ? (
              <span className="tag bg-green-500/10 text-green-400 text-[10px]">🔗 {publicKey?.toBase58().slice(0, 4)}...{publicKey?.toBase58().slice(-4)}</span>
            ) : (
              <button onClick={() => { haptic?.impactOccurred("medium"); setWalletModalVisible(true); }}
                className="btn-primary px-3 py-1.5 text-[10px] flex items-center gap-1">
                <Wallet className="w-3 h-3" /> {t("tg.connect_wallet", lang)}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Toast notifications */}
      {toasts.length > 0 && (
        <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
          {toasts.map((toast) => (
            <div key={toast.id}
              className={`flex items-start gap-2.5 px-4 py-3 rounded-lg shadow-lg border animate-slide-in ${
                toast.type === "success" ? "bg-green-950/90 border-green-800/50" :
                toast.type === "error" ? "bg-red-950/90 border-red-800/50" :
                "bg-blue-950/90 border-blue-800/50"
              }`}>
              {toast.type === "success" ? <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0 mt-0.5" /> :
               toast.type === "error" ? <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" /> :
               <Info className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />}
              <p className={`text-sm flex-1 ${
                toast.type === "success" ? "text-green-200" :
                toast.type === "error" ? "text-red-200" : "text-blue-200"
              }`}>{toast.msg}</p>
              <button onClick={() => dismissToast(toast.id)} className="shrink-0 mt-0.5">
                <X className={`w-3.5 h-3.5 ${
                  toast.type === "success" ? "text-green-600 hover:text-green-400" :
                  toast.type === "error" ? "text-red-600 hover:text-red-400" :
                  "text-blue-600 hover:text-blue-400"
                }`} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Swap Confirmation Modal */}
      {pendingSwap && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="card p-6 max-w-sm w-full mx-4 border-yellow-500/30">
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle className="w-5 h-5 text-yellow-400" />
              <h3 className="text-sm font-bold text-white">{t("jupiter.confirm_title", lang)}</h3>
            </div>
            <p className="text-xs text-gray-400 mb-4">{t("jupiter.confirm_desc", lang)}</p>
            <div className="bg-[#12141c] rounded-lg p-3 mb-4 space-y-1.5">
              <div className="flex justify-between text-xs">
                <span className="text-gray-500">Action</span>
                <span className={pendingSwap.decision.action === "BUY" ? "text-green-400 font-bold" : "text-red-400 font-bold"}>
                  {pendingSwap.decision.action} {pendingSwap.decision.symbol}
                </span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-gray-500">Amount</span>
                <span className="text-white font-mono">${fmtUSD(pendingSwap.decision.amountUSD)}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-gray-500">Price</span>
                <span className="text-gray-300 font-mono">${fmtUSD(pendingSwap.decision.currentPrice)}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-gray-500">Confidence</span>
                <span className="text-gray-300">{Math.round(pendingSwap.decision.confidence * 100)}%</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-gray-500">Slippage</span>
                <span className="text-gray-300">{(swapSettings.slippageBps / 100).toFixed(1)}%</span>
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => pendingSwap.resolve(false)}
                className="btn-secondary flex-1 py-2 text-xs">{t("jupiter.confirm_no", lang)}</button>
              <button onClick={() => pendingSwap.resolve(true)}
                className="btn-primary flex-1 py-2 text-xs">{t("jupiter.confirm_yes", lang)}</button>
            </div>
          </div>
        </div>
      )}

      {/* Jupiter Swap Settings Overlay */}
      {showSwapSettings && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="card p-6 max-w-md w-full mx-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-bold text-white">{t("jupiter.settings", lang)}</h3>
              <button onClick={() => setShowSwapSettings(false)}><X className="w-4 h-4 text-gray-500 hover:text-white" /></button>
            </div>

            {/* Real Swaps Toggle */}
            <div className={`rounded-lg p-3 mb-4 border ${swapSettings.enableRealSwaps ? "bg-red-950/30 border-red-500/30" : "bg-[#12141c] border-gray-800/50"}`}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-gray-300">{t("jupiter.real_swaps", lang)}</span>
                <button
                  onClick={() => setSwapSettings((s) => ({ ...s, enableRealSwaps: !s.enableRealSwaps }))}
                  className={`relative w-10 h-5 rounded-full transition-colors ${swapSettings.enableRealSwaps ? "bg-red-500" : "bg-gray-700"}`}>
                  <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${swapSettings.enableRealSwaps ? "translate-x-5" : "translate-x-0.5"}`} />
                </button>
              </div>
              <p className="text-[10px] text-gray-500">
                {swapSettings.enableRealSwaps ? t("jupiter.real_desc", lang) : t("jupiter.sim_desc", lang)}
              </p>
            </div>

            {/* Slippage */}
            <div className="space-y-3">
              <div>
                <label className="text-[10px] text-gray-500 uppercase tracking-wide">{t("jupiter.slippage", lang)}</label>
                <div className="flex gap-1.5 mt-1">
                  {[25, 50, 100, 200].map((bps) => (
                    <button key={bps}
                      onClick={() => setSwapSettings((s) => ({ ...s, slippageBps: bps }))}
                      className={`px-2.5 py-1 rounded text-xs font-mono ${swapSettings.slippageBps === bps ? "bg-green-500/20 text-green-400 border border-green-500/30" : "bg-[#12141c] text-gray-500 hover:text-gray-300"}`}>
                      {(bps / 100).toFixed(1)}%
                    </button>
                  ))}
                </div>
              </div>

              {/* Max Price Impact */}
              <div>
                <label className="text-[10px] text-gray-500 uppercase tracking-wide">{t("jupiter.max_impact", lang)}</label>
                <div className="flex gap-1.5 mt-1">
                  {[0.5, 1.0, 2.0, 5.0].map((pct) => (
                    <button key={pct}
                      onClick={() => setSwapSettings((s) => ({ ...s, maxPriceImpactPct: pct }))}
                      className={`px-2.5 py-1 rounded text-xs font-mono ${swapSettings.maxPriceImpactPct === pct ? "bg-green-500/20 text-green-400 border border-green-500/30" : "bg-[#12141c] text-gray-500 hover:text-gray-300"}`}>
                      {pct}%
                    </button>
                  ))}
                </div>
              </div>

              {/* Max Trade Size */}
              <div>
                <label className="text-[10px] text-gray-500 uppercase tracking-wide">{t("jupiter.max_trade", lang)}</label>
                <div className="flex gap-1.5 mt-1">
                  {[50, 100, 250, 500].map((usd) => (
                    <button key={usd}
                      onClick={() => setSwapSettings((s) => ({ ...s, maxTradeUSD: usd }))}
                      className={`px-2.5 py-1 rounded text-xs font-mono ${swapSettings.maxTradeUSD === usd ? "bg-green-500/20 text-green-400 border border-green-500/30" : "bg-[#12141c] text-gray-500 hover:text-gray-300"}`}>
                      ${usd}
                    </button>
                  ))}
                </div>
              </div>

              {/* Confirm Before Swap */}
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-400">{lang === "ru" ? "Подтверждение перед свопом" : "Confirm before swap"}</span>
                <button
                  onClick={() => setSwapSettings((s) => ({ ...s, confirmBeforeSwap: !s.confirmBeforeSwap }))}
                  className={`relative w-10 h-5 rounded-full transition-colors ${swapSettings.confirmBeforeSwap ? "bg-green-500" : "bg-gray-700"}`}>
                  <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${swapSettings.confirmBeforeSwap ? "translate-x-5" : "translate-x-0.5"}`} />
                </button>
              </div>
            </div>

            <button onClick={() => setShowSwapSettings(false)} className="btn-primary w-full py-2 text-xs mt-4">
              {lang === "ru" ? "Сохранить" : "Save"}
            </button>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="flex items-center justify-between gap-3 mb-5">
        <div className="flex items-center gap-2.5">
          <h1 className="text-lg font-bold text-white">{t("app.title", lang)}</h1>
          <div className="flex items-center gap-0.5 bg-[#12141c] rounded-lg p-0.5">
            {[0, 1, 2].map((s) => {
              const active = agent.strategy === s;
              const colors = s === 0 ? "bg-blue-500/20 text-blue-400" : s === 1 ? "bg-yellow-500/20 text-yellow-400" : "bg-red-500/20 text-red-400";
              return (
                <button key={s} onClick={() => setAgent((p) => ({ ...p, strategy: s }))}
                  className={`px-2 py-1 text-[10px] font-semibold rounded-md transition-all ${active ? colors : "text-gray-600 hover:text-gray-400"}`}>
                  {getStrategyName(s, lang)}
                </button>
              );
            })}
          </div>
          <span className="tag bg-blue-500/10 text-blue-400 flex items-center gap-1">
            <Activity className="w-3 h-3" />
            {t("data.live_badge", lang)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {connected && publicKey ? (
            <div className="card px-3 py-1.5 flex items-center gap-2 text-xs">
              <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
              <span className="font-mono text-green-400">{publicKey.toBase58().slice(0, 4)}...{publicKey.toBase58().slice(-4)}</span>
              {solBalance !== null && <span className="text-gray-500">{solBalance.toFixed(2)} SOL</span>}
              <a href={getExplorerAccountUrl(publicKey.toBase58())} target="_blank" rel="noopener noreferrer"
                className="text-blue-400 hover:text-blue-300 text-[10px] underline">Explorer</a>
            </div>
          ) : (
            <button onClick={() => setWalletModalVisible(true)}
              className="btn-secondary px-3 py-1.5 text-xs flex items-center gap-1.5">
              <Wallet className="w-3.5 h-3.5" />
              Connect Wallet
            </button>
          )}
          <div className="card px-3 py-1.5 flex items-center gap-2 text-xs">
            <Wallet className="w-3.5 h-3.5 text-gray-500" />
            <span className="font-mono text-gray-300">${fmtUSD(walletBalance)}</span>
            <span className="text-gray-600">({t("app.demo", lang)})</span>
          </div>
          <LangToggle lang={lang} setLang={setLang} />
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">

        {/* LEFT — Balance + Controls + Positions */}
        <div className="lg:col-span-3 space-y-3">
          {/* Balance */}
          <div className="card p-4">
            <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">{t("dash.balance", lang)}</p>
            <p className="text-2xl font-bold text-white font-mono">${fmtUSD(agent.balanceUSD)}</p>
            <div className="flex justify-between mt-2 text-[11px]">
              <span className="text-gray-600">{t("dash.portfolio", lang)}</span>
              <span className="font-mono text-gray-400">${fmtUSD(totalValue)}</span>
            </div>
            {totalPosValue > 0 && (
              <div className="flex justify-between text-[11px]">
                <span className="text-gray-600">{t("dash.in_positions", lang)}</span>
                <span className="font-mono text-gray-400">${fmtUSD(totalPosValue)}</span>
              </div>
            )}
          </div>

          {/* Deposit */}
          <div className="card p-4">
            <p className="text-xs text-gray-500 uppercase tracking-wide mb-2">{t("dash.deposit", lang)}</p>
            <div className="flex gap-2">
              <input type="number" step="50" value={depositAmount}
                onChange={(e) => setDepositAmount(e.target.value)}
                className="input-field flex-1 text-sm" placeholder="USD" />
              <button onClick={handleDeposit} disabled={isProcessing}
                className="btn-primary px-3 py-2 text-xs flex items-center gap-1">
                <ArrowDown className="w-3.5 h-3.5" />{t("dash.deposit", lang)}
              </button>
            </div>
          </div>

          {/* Withdraw */}
          <div className="card p-4">
            <p className="text-xs text-gray-500 uppercase tracking-wide mb-2">{t("dash.withdraw", lang)}</p>
            <div className="flex gap-2">
              <input type="number" step="50" value={withdrawAmount}
                onChange={(e) => setWithdrawAmount(e.target.value)}
                className="input-field flex-1 text-sm" placeholder="USD" />
              <button onClick={handleWithdraw} disabled={isProcessing}
                className="btn-danger px-3 py-2 text-xs flex items-center gap-1">
                <ArrowUp className="w-3.5 h-3.5" />{t("dash.withdraw", lang)}
              </button>
            </div>
          </div>

          {/* Positions */}
          <div className="card p-4">
            <p className="text-xs text-gray-500 uppercase tracking-wide mb-2">{t("dash.positions", lang)}</p>
            {agent.positions.length === 0 ? (
              <p className="text-xs text-gray-600">{t("dash.no_positions", lang)}</p>
            ) : (
              <div className="space-y-1.5">
                {agent.positions.map((pos, i) => (
                  <button key={i} onClick={() => setSelectedCoin(pos.coinId)}
                    className={`w-full text-left px-2.5 py-2 rounded-lg transition-colors ${
                      selectedCoin === pos.coinId ? "bg-green-500/10 border border-green-500/30" : "bg-[#12141c] hover:bg-[#161822]"
                    }`}>
                    <div className="flex justify-between items-center text-sm">
                      <span className="font-mono text-gray-300 font-medium">{pos.symbol}</span>
                      <span className="font-mono text-gray-400">${fmtUSD(pos.amount * pos.currentPrice)}</span>
                    </div>
                    <div className="flex justify-between items-center text-[10px] mt-0.5">
                      <span className="text-gray-600">{pos.amount.toFixed(4)} @ ${fmtUSD(pos.avgBuyPrice)}</span>
                      <span className={pos.unrealizedPnLPct >= 0 ? "text-green-400" : "text-red-400"}>
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
        <div className="lg:col-span-5 space-y-3">
          {/* Price Chart */}
          <div className="card p-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs text-gray-500 uppercase tracking-wide font-semibold">
                {t("chart.title", lang)}
                <span className="text-gray-300 ml-2 normal-case">
                  {TRACKED_COINS.find((c) => c.id === selectedCoin)?.symbol || ""}
                </span>
              </p>
              <span className="text-[10px] text-green-500 flex items-center gap-1">
                <Activity className="w-3 h-3" /> CoinGecko
              </span>
            </div>
            {/* Coin tabs */}
            <div className="flex gap-1 mb-2 overflow-x-auto">
              {TRACKED_COINS.map((coin) => {
                const active = selectedCoin === coin.id;
                const asset = assets.find((a) => a.id === coin.id);
                const ch = asset?.priceChangePercent24h || 0;
                return (
                  <button key={coin.id} onClick={() => setSelectedCoin(coin.id)}
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] shrink-0 transition-all ${
                      active ? "bg-green-500/10 text-green-400 font-medium border border-green-500/30" : "bg-[#12141c] text-gray-500 hover:text-gray-300"
                    }`}>
                    <span>{coin.symbol}</span>
                    <span className={`font-mono text-[10px] ${ch > 0 ? "text-green-400" : ch < 0 ? "text-red-400" : "text-gray-600"}`}>
                      {ch > 0 ? "+" : ""}{ch.toFixed(2)}%
                    </span>
                  </button>
                );
              })}
            </div>
            {dataLoading ? (
              <div className="h-[260px] bg-[#12141c] rounded-lg flex items-center justify-center">
                <Loader2 className="w-6 h-6 text-gray-600 animate-spin" />
              </div>
            ) : chartCandles[selectedCoin] ? (
              <PriceChart data={chartCandles[selectedCoin]} token={selectedCoin} height={260} />
            ) : (
              <div className="h-[260px] bg-[#12141c] rounded-lg flex items-center justify-center text-xs text-gray-600">
                {t("data.no_data", lang)}
              </div>
            )}
          </div>

          {/* AI Engine */}
          <div className="card p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <p className="text-xs text-gray-500 uppercase tracking-wide font-semibold">{t("ai.engine", lang)}</p>
                {isAutoMode && <CircleDot className="w-3 h-3 text-green-400 animate-pulse" />}
              </div>
              <span className="text-[10px] text-gray-600">
                {t("ta.indicators", lang)}
              </span>
            </div>
            <div className="flex gap-2">
              <button onClick={runAI} disabled={isProcessing || agent.balanceUSD === 0 || dataLoading}
                className="btn-primary flex-1 py-2.5 text-sm flex items-center justify-center gap-2">
                {isProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                {t("ai.run", lang)}
              </button>
              <button onClick={() => setIsAutoMode(!isAutoMode)} disabled={agent.balanceUSD === 0 || dataLoading}
                className={`px-4 py-2.5 text-sm font-semibold rounded-lg transition-colors ${isAutoMode ? "btn-danger" : "btn-secondary"}`}>
                {isAutoMode ? (
                  <span className="flex items-center gap-1.5"><Square className="w-3.5 h-3.5" />{t("ai.stop", lang)}</span>
                ) : t("ai.auto", lang)}
              </button>
            </div>
            {agent.balanceUSD === 0 && (
              <p className="text-yellow-600 text-[11px] mt-2 text-center">{t("ai.need_deposit", lang)}</p>
            )}
          </div>

          {/* Live Market */}
          <div className="card p-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs text-gray-500 uppercase tracking-wide font-semibold">{t("market.title", lang)}</p>
              <span className="text-[10px] text-green-500">{t("data.live_prices", lang)}</span>
            </div>
            <div className="space-y-1.5">
              {assets.length === 0 ? (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="w-4 h-4 text-gray-600 animate-spin" />
                </div>
              ) : assets.map((asset) => {
                const ch = asset.priceChangePercent24h;
                const up = ch > 0;
                return (
                  <button key={asset.id} onClick={() => setSelectedCoin(asset.id)}
                    className={`flex items-center justify-between py-1.5 px-2 rounded-lg w-full text-left transition-colors ${
                      selectedCoin === asset.id ? "bg-green-500/10" : "bg-[#12141c] hover:bg-[#161822]"
                    }`}>
                    <div className="flex items-center gap-2">
                      {up ? <TrendingUp className="w-3.5 h-3.5 text-green-400" /> :
                       ch < 0 ? <TrendingDown className="w-3.5 h-3.5 text-red-400" /> :
                       <Minus className="w-3.5 h-3.5 text-gray-600" />}
                      <div>
                        <span className="font-mono text-sm text-gray-300">{asset.symbol}</span>
                        <span className="text-[10px] text-gray-600 ml-1.5">{asset.name}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-xs text-gray-400">${fmtUSD(asset.currentPrice)}</span>
                      <span className={`font-mono text-xs min-w-[52px] text-right ${up ? "text-green-400" : ch < 0 ? "text-red-400" : "text-gray-600"}`}>
                        {ch > 0 ? "+" : ""}{ch.toFixed(2)}%
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* History */}
          <div className="card p-4 max-h-72 overflow-y-auto">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs text-gray-500 uppercase tracking-wide font-semibold">{t("history.title", lang)}</p>
              {agent.history.length > 0 && (
                <span className="text-[10px] text-gray-600">{agent.history.length} {t("history.total", lang)}</span>
              )}
            </div>
            {agent.history.length === 0 ? (
              <p className="text-xs text-gray-600">{t("history.empty", lang)}</p>
            ) : (
              <>
                {(() => {
                  const buys = agent.history.filter((h) => h.action === "BUY");
                  const sells = agent.history.filter((h) => h.action === "SELL");
                  const holds = agent.history.filter((h) => h.action === "HOLD");
                  const totalVol = [...buys, ...sells].reduce((s, h) => s + h.amountUSD, 0);
                  return (
                    <div className="grid grid-cols-4 gap-1.5 mb-3">
                      <div className="bg-[#12141c] rounded-md px-2 py-1.5 text-center">
                        <p className="text-[10px] text-gray-600">{t("history.buys", lang)}</p>
                        <p className="text-sm font-bold text-green-400">{buys.length}</p>
                      </div>
                      <div className="bg-[#12141c] rounded-md px-2 py-1.5 text-center">
                        <p className="text-[10px] text-gray-600">{t("history.sells", lang)}</p>
                        <p className="text-sm font-bold text-red-400">{sells.length}</p>
                      </div>
                      <div className="bg-[#12141c] rounded-md px-2 py-1.5 text-center">
                        <p className="text-[10px] text-gray-600">{t("history.holds", lang)}</p>
                        <p className="text-sm font-bold text-yellow-500">{holds.length}</p>
                      </div>
                      <div className="bg-[#12141c] rounded-md px-2 py-1.5 text-center">
                        <p className="text-[10px] text-gray-600">{t("history.volume", lang)}</p>
                        <p className="text-sm font-bold text-gray-300">${fmtUSD(totalVol)}</p>
                      </div>
                    </div>
                  );
                })()}
                <div className="space-y-1.5">
                  {agent.history.slice().reverse().map((h, i) => (
                    <div key={i} className="bg-[#12141c] rounded-lg px-2.5 py-2 flex items-center gap-2">
                      <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded min-w-[42px] text-center ${
                        h.action === "BUY" ? "bg-green-500/15 text-green-400" :
                        h.action === "SELL" ? "bg-red-500/15 text-red-400" :
                        "bg-yellow-500/10 text-yellow-500"
                      }`}>{h.action}</span>
                      <span className="text-xs font-mono text-gray-300 min-w-[36px]">{h.symbol}</span>
                      <span className="text-[11px] font-mono text-gray-400 flex-1 text-right">
                        {h.amountUSD > 0 ? `$${fmtUSD(h.amountUSD)}` : "-"}
                      </span>
                      <span className={`text-[10px] font-mono min-w-[40px] text-right ${
                        h.confidence >= 0.6 ? "text-green-400" : h.confidence >= 0.4 ? "text-yellow-400" : "text-gray-600"
                      }`}>{Math.round(h.confidence * 100)}%</span>
                      <span className="text-[10px] text-gray-700 min-w-[55px] text-right">
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
        <div className="lg:col-span-4 card p-4 flex flex-col max-h-[calc(100vh-100px)]">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs text-gray-500 uppercase tracking-wide font-semibold">{t("log.title", lang)}</p>
            <span className="text-[10px] text-gray-600">{aiLog.length} {t("log.entries", lang)}</span>
          </div>

          <div className="flex-1 overflow-y-auto space-y-2 min-h-0">
            {aiLog.length === 0 ? (
              <div className="flex items-center justify-center h-24 text-gray-700">
                <p className="text-xs">{t("log.empty", lang)}</p>
              </div>
            ) : (
              aiLog.map((entry) => {
                const d = entry.decision;
                const confPct = Math.round(d.confidence * 100);
                const confColor = confPct >= 60 ? "bg-green-500" : confPct >= 40 ? "bg-yellow-500" : "bg-red-500";
                const confTextColor = confPct >= 60 ? "text-green-400" : confPct >= 40 ? "text-yellow-400" : "text-red-400";
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
                  <div key={entry.id} className="rounded-lg bg-[#12141c] overflow-hidden">
                    <button onClick={() => toggleLog(entry.id)}
                      className="w-full flex items-center justify-between px-3 py-2 hover:bg-[#161822] transition-colors text-left">
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded shrink-0 ${
                          d.action === "BUY" ? "bg-green-500/15 text-green-400" :
                          d.action === "SELL" ? "bg-red-500/15 text-red-400" :
                          "bg-yellow-500/10 text-yellow-500"
                        }`}>{d.action}</span>
                        <span className="text-xs text-gray-300 truncate">{summaryText}</span>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0 ml-2">
                        <span className="text-[10px] text-gray-700">{new Date(entry.timestamp).toLocaleTimeString()}</span>
                        {expanded ? <ChevronUp className="w-3.5 h-3.5 text-gray-600" /> : <ChevronDown className="w-3.5 h-3.5 text-gray-600" />}
                      </div>
                    </button>

                    {expanded && (
                      <div className="px-3 pb-3 border-t border-gray-800/50">
                        {/* Recommendation + Score */}
                        <div className="mt-2.5 flex items-center gap-2">
                          <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded ${
                            a.recommendation.includes("BUY") ? "bg-green-500/15 text-green-400" :
                            a.recommendation.includes("SELL") ? "bg-red-500/15 text-red-400" :
                            "bg-yellow-500/10 text-yellow-500"
                          }`}>{a.recommendation}</span>
                          <span className="text-[10px] text-gray-600">
                            Score: <span className={a.overallScore > 0 ? "text-green-400" : a.overallScore < 0 ? "text-red-400" : "text-gray-400"}>
                              {(a.overallScore * 100).toFixed(0)}%
                            </span>
                          </span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                            d.riskLevel === "low" ? "bg-green-500/10 text-green-400" :
                            d.riskLevel === "high" ? "bg-red-500/10 text-red-400" :
                            "bg-yellow-500/10 text-yellow-500"
                          }`}>{d.riskLevel} risk</span>
                        </div>

                        {/* TA Indicators */}
                        <div className="mt-2.5 grid grid-cols-3 gap-1.5">
                          <div className="bg-[#0f1117] rounded px-2 py-1.5 text-center">
                            <p className="text-[9px] text-gray-600">RSI</p>
                            <p className={`text-xs font-mono font-bold ${a.rsi < 30 ? "text-green-400" : a.rsi > 70 ? "text-red-400" : "text-gray-300"}`}>
                              {a.rsi.toFixed(1)}
                            </p>
                          </div>
                          <div className="bg-[#0f1117] rounded px-2 py-1.5 text-center">
                            <p className="text-[9px] text-gray-600">MACD</p>
                            <p className={`text-xs font-mono font-bold ${a.macd.histogram > 0 ? "text-green-400" : "text-red-400"}`}>
                              {a.macd.histogram.toFixed(4)}
                            </p>
                          </div>
                          <div className="bg-[#0f1117] rounded px-2 py-1.5 text-center">
                            <p className="text-[9px] text-gray-600">ADX</p>
                            <p className={`text-xs font-mono font-bold ${a.adx > 25 ? "text-green-400" : "text-gray-500"}`}>
                              {a.adx.toFixed(1)}
                            </p>
                          </div>
                          <div className="bg-[#0f1117] rounded px-2 py-1.5 text-center">
                            <p className="text-[9px] text-gray-600">BB %B</p>
                            <p className={`text-xs font-mono font-bold ${a.bollinger.percentB < 0.2 ? "text-green-400" : a.bollinger.percentB > 0.8 ? "text-red-400" : "text-gray-300"}`}>
                              {(a.bollinger.percentB * 100).toFixed(0)}%
                            </p>
                          </div>
                          <div className="bg-[#0f1117] rounded px-2 py-1.5 text-center">
                            <p className="text-[9px] text-gray-600">Stoch %K</p>
                            <p className={`text-xs font-mono font-bold ${a.stochastic.k < 20 ? "text-green-400" : a.stochastic.k > 80 ? "text-red-400" : "text-gray-300"}`}>
                              {a.stochastic.k.toFixed(0)}
                            </p>
                          </div>
                          <div className="bg-[#0f1117] rounded px-2 py-1.5 text-center">
                            <p className="text-[9px] text-gray-600">{t("ta.trend", lang)}</p>
                            <p className={`text-[10px] font-bold ${
                              a.trend.trend.includes("up") ? "text-green-400" :
                              a.trend.trend.includes("down") ? "text-red-400" : "text-gray-500"
                            }`}>{a.trend.trend.replace("_", " ")}</p>
                          </div>
                        </div>

                        {/* Signals list */}
                        {d.signalsSummary.length > 0 && (
                          <div className="mt-2.5 space-y-1">
                            <p className="text-[10px] text-gray-600">{t("ta.signals", lang)}</p>
                            {d.signalsSummary.slice(0, 5).map((sig, si) => (
                              <div key={si} className="text-[10px] text-gray-500 flex items-start gap-1.5">
                                <span className={`shrink-0 mt-0.5 w-1.5 h-1.5 rounded-full ${
                                  sig.includes("BUY") ? "bg-green-400" : sig.includes("SELL") ? "bg-red-400" : "bg-gray-600"
                                }`} />
                                <span>{sig}</span>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Confidence bar */}
                        <div className="mt-2.5">
                          <p className="text-[10px] text-gray-600 mb-1">{t("log.confidence", lang)}</p>
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-2 bg-gray-800 rounded-full overflow-hidden">
                              <div className={`h-full rounded-full transition-all ${confColor}`} style={{ width: `${confPct}%` }} />
                            </div>
                            <span className={`text-xs font-semibold ${confTextColor}`}>{confPct}%</span>
                          </div>
                          <p className={`text-[10px] mt-1 ${confTextColor}`}>{confExplain}</p>
                        </div>

                        {/* Reasoning */}
                        <div className="mt-2.5 border-t border-gray-800/50 pt-2">
                          <p className="text-[10px] text-gray-600 mb-0.5">{t("ta.reasoning", lang)}</p>
                          <p className="text-[11px] text-gray-500 leading-relaxed">{d.reasoning}</p>
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
        <div className="card p-4 mt-3">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <p className="text-xs text-gray-500 uppercase tracking-wide font-semibold">{t("pnl.title", lang)}</p>
              <span className={`tag text-[10px] ${pnlMetrics.totalPnLUSD >= 0 ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400"}`}>
                {pnlMetrics.totalPnLUSD >= 0 ? "+" : ""}{pnlMetrics.totalPnLPct.toFixed(2)}%
              </span>
            </div>
            <span className="text-[10px] text-gray-600">{pnlMetrics.totalTrades} {t("pnl.trades", lang).toLowerCase()}</span>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2">
            {/* Total P&L */}
            <div className="bg-[#12141c] rounded-lg p-2 text-center">
              <p className="text-[9px] text-gray-600 uppercase">{t("pnl.total", lang)}</p>
              <p className={`text-sm font-bold font-mono ${pnlMetrics.totalPnLUSD >= 0 ? "text-green-400" : "text-red-400"}`}>
                {pnlMetrics.totalPnLUSD >= 0 ? "+" : ""}${fmtUSD(Math.abs(pnlMetrics.totalPnLUSD))}
              </p>
            </div>
            {/* Realized */}
            <div className="bg-[#12141c] rounded-lg p-2 text-center">
              <p className="text-[9px] text-gray-600 uppercase">{t("pnl.realized", lang)}</p>
              <p className={`text-sm font-bold font-mono ${pnlMetrics.realizedPnLUSD >= 0 ? "text-green-400" : "text-red-400"}`}>
                {pnlMetrics.realizedPnLUSD >= 0 ? "+" : ""}${fmtUSD(Math.abs(pnlMetrics.realizedPnLUSD))}
              </p>
            </div>
            {/* Unrealized */}
            <div className="bg-[#12141c] rounded-lg p-2 text-center">
              <p className="text-[9px] text-gray-600 uppercase">{t("pnl.unrealized", lang)}</p>
              <p className={`text-sm font-bold font-mono ${pnlMetrics.unrealizedPnLUSD >= 0 ? "text-green-400" : "text-red-400"}`}>
                {pnlMetrics.unrealizedPnLUSD >= 0 ? "+" : ""}${fmtUSD(Math.abs(pnlMetrics.unrealizedPnLUSD))}
              </p>
            </div>
            {/* Win Rate */}
            <div className="bg-[#12141c] rounded-lg p-2 text-center">
              <p className="text-[9px] text-gray-600 uppercase">{t("pnl.win_rate", lang)}</p>
              <p className={`text-sm font-bold font-mono ${pnlMetrics.winRate >= 50 ? "text-green-400" : pnlMetrics.totalTrades === 0 ? "text-gray-500" : "text-red-400"}`}>
                {pnlMetrics.totalTrades > 0 ? `${pnlMetrics.winRate.toFixed(0)}%` : "—"}
              </p>
              {pnlMetrics.totalTrades > 0 && (
                <p className="text-[9px] text-gray-600">{pnlMetrics.winningTrades}{t("pnl.wins", lang)}/{pnlMetrics.losingTrades}{t("pnl.losses", lang)}</p>
              )}
            </div>
            {/* Profit Factor */}
            <div className="bg-[#12141c] rounded-lg p-2 text-center">
              <p className="text-[9px] text-gray-600 uppercase">{t("pnl.profit_factor", lang)}</p>
              <p className={`text-sm font-bold font-mono ${pnlMetrics.profitFactor >= 1.5 ? "text-green-400" : pnlMetrics.profitFactor >= 1 ? "text-yellow-400" : pnlMetrics.totalTrades === 0 ? "text-gray-500" : "text-red-400"}`}>
                {pnlMetrics.totalTrades > 0 ? (pnlMetrics.profitFactor === Infinity ? "∞" : pnlMetrics.profitFactor.toFixed(2)) : "—"}
              </p>
            </div>
            {/* Max Drawdown */}
            <div className="bg-[#12141c] rounded-lg p-2 text-center">
              <p className="text-[9px] text-gray-600 uppercase">{t("pnl.max_dd", lang)}</p>
              <p className="text-sm font-bold font-mono text-red-400">
                {pnlMetrics.maxDrawdown > 0 ? `-${pnlMetrics.maxDrawdown.toFixed(1)}%` : "0%"}
              </p>
            </div>
            {/* Sharpe */}
            <div className="bg-[#12141c] rounded-lg p-2 text-center">
              <p className="text-[9px] text-gray-600 uppercase">{t("pnl.sharpe", lang)}</p>
              <p className={`text-sm font-bold font-mono ${pnlMetrics.sharpeRatio >= 1 ? "text-green-400" : pnlMetrics.sharpeRatio >= 0 ? "text-yellow-400" : "text-red-400"}`}>
                {pnlMetrics.sharpeRatio.toFixed(2)}
              </p>
            </div>
            {/* Streak */}
            <div className="bg-[#12141c] rounded-lg p-2 text-center">
              <p className="text-[9px] text-gray-600 uppercase">{t("pnl.streak", lang)}</p>
              <p className={`text-sm font-bold font-mono ${pnlMetrics.currentStreak > 0 ? "text-green-400" : pnlMetrics.currentStreak < 0 ? "text-red-400" : "text-gray-500"}`}>
                {pnlMetrics.currentStreak > 0 ? `+${pnlMetrics.currentStreak}` : pnlMetrics.currentStreak === 0 ? "—" : pnlMetrics.currentStreak}
              </p>
              {(pnlMetrics.longestWinStreak > 0 || pnlMetrics.longestLossStreak > 0) && (
                <p className="text-[9px] text-gray-600">
                  <span className="text-green-600">{pnlMetrics.longestWinStreak}{t("pnl.wins", lang)}</span>
                  {" / "}
                  <span className="text-red-600">{pnlMetrics.longestLossStreak}{t("pnl.losses", lang)}</span>
                </p>
              )}
            </div>
          </div>

          {/* Equity mini-bar + allocation */}
          <div className="mt-3 flex items-center gap-3">
            <div className="flex-1">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[9px] text-gray-600 uppercase">{t("pnl.equity", lang)}</span>
                <span className="text-[10px] font-mono text-gray-400">${fmtUSD(pnlMetrics.totalEquity)}</span>
              </div>
              <div className="h-2 bg-gray-800 rounded-full overflow-hidden flex">
                <div className="h-full bg-blue-500/60 transition-all" style={{ width: `${pnlMetrics.cashPct}%` }}
                  title={`${t("pnl.cash_pct", lang)}: ${pnlMetrics.cashPct.toFixed(0)}%`} />
                <div className="h-full bg-green-500/60 transition-all" style={{ width: `${pnlMetrics.positionsPct}%` }}
                  title={`${t("pnl.pos_pct", lang)}: ${pnlMetrics.positionsPct.toFixed(0)}%`} />
              </div>
              <div className="flex justify-between mt-0.5">
                <span className="text-[9px] text-blue-400">{t("pnl.cash_pct", lang)} {pnlMetrics.cashPct.toFixed(0)}%</span>
                <span className="text-[9px] text-green-400">{t("pnl.pos_pct", lang)} {pnlMetrics.positionsPct.toFixed(0)}%</span>
              </div>
            </div>
            {pnlMetrics.totalTrades > 0 && (
              <div className="text-right shrink-0">
                <p className="text-[9px] text-gray-600">{t("pnl.expectancy", lang)}</p>
                <p className={`text-xs font-mono font-bold ${pnlMetrics.expectancy >= 0 ? "text-green-400" : "text-red-400"}`}>
                  {pnlMetrics.expectancy >= 0 ? "+" : ""}${fmtUSD(Math.abs(pnlMetrics.expectancy))}
                </p>
                <p className="text-[9px] text-gray-700">{t("pnl.per_trade", lang)}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* JUPITER DEX + ON-CHAIN */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mt-3">

        {/* Jupiter DEX Status */}
        <div className="card p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <p className="text-xs text-gray-500 uppercase tracking-wide font-semibold">{t("jupiter.title", lang)}</p>
              <span className={`tag text-[10px] ${swapSettings.enableRealSwaps ? "bg-red-500/10 text-red-400" : "bg-green-500/10 text-green-400"}`}>
                {swapSettings.enableRealSwaps ? "LIVE" : t("jupiter.simulation", lang)}
              </span>
            </div>
            <button onClick={() => setShowSwapSettings(true)}
              className="btn-secondary px-2 py-1 text-[10px]">
              {t("jupiter.settings", lang)}
            </button>
          </div>

          <div className="space-y-1.5 text-[11px]">
            <div className="flex justify-between">
              <span className="text-gray-600">{t("jupiter.slippage", lang)}</span>
              <span className="text-gray-400 font-mono">{(swapSettings.slippageBps / 100).toFixed(1)}%</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">{t("jupiter.max_trade", lang)}</span>
              <span className="text-gray-400 font-mono">${swapSettings.maxTradeUSD}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">{t("jupiter.max_impact", lang)}</span>
              <span className="text-gray-400 font-mono">{swapSettings.maxPriceImpactPct}%</span>
            </div>
          </div>

          {/* Last swap results */}
          {lastSwapResults.length > 0 && (
            <div className="mt-3 border-t border-gray-800/50 pt-2">
              <p className="text-[10px] text-gray-600 mb-1.5">{lang === "ru" ? "Последние свопы" : "Recent Swaps"}</p>
              <div className="space-y-1">
                {lastSwapResults.slice(0, 4).map((sr, i) => (
                  <div key={i} className={`flex items-center justify-between bg-[#12141c] rounded px-2 py-1 ${sr.success ? "" : "opacity-50"}`}>
                    <span className="text-[10px] font-mono text-gray-400">
                      {sr.inputAmount.toFixed(3)} {sr.inputSymbol} → {sr.outputAmount.toFixed(3)} {sr.outputSymbol}
                    </span>
                    {sr.success
                      ? <CheckCircle2 className="w-3 h-3 text-green-400" />
                      : <AlertTriangle className="w-3 h-3 text-red-400" />}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Token Balances */}
        <div className="card p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wide font-semibold mb-2">{t("jupiter.balances", lang)}</p>
          {!connected ? (
            <p className="text-xs text-gray-600 text-center py-4">{t("jupiter.no_wallet", lang)}</p>
          ) : Object.keys(tokenBalances).length === 0 ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="w-4 h-4 text-gray-600 animate-spin" />
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
                    <div key={sym} className="flex items-center justify-between bg-[#12141c] rounded-lg px-2.5 py-1.5">
                      <div>
                        <span className="font-mono text-xs text-gray-300 font-medium">{sym}</span>
                        <span className="text-[10px] text-gray-600 ml-1.5">{bal < 0.01 ? bal.toFixed(6) : bal < 1 ? bal.toFixed(4) : bal.toFixed(2)}</span>
                      </div>
                      {usdVal > 0.01 && (
                        <span className="font-mono text-[10px] text-gray-500">${fmtUSD(usdVal)}</span>
                      )}
                    </div>
                  );
                })}
            </div>
          )}
        </div>

        {/* On-Chain Transactions */}
        <div className="card p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <p className="text-xs text-gray-500 uppercase tracking-wide font-semibold">On-Chain TX</p>
              <span className="tag bg-purple-500/10 text-purple-400 text-[10px]">{SOLANA_NETWORK}</span>
              {connected && <div className="w-2 h-2 rounded-full bg-green-400" />}
            </div>
            {!connected && (
              <button onClick={() => setWalletModalVisible(true)}
                className="btn-secondary px-2 py-1 text-[10px] flex items-center gap-1">
                <Wallet className="w-3 h-3" /> Connect
              </button>
            )}
          </div>

          {!connected ? (
            <p className="text-xs text-gray-600 text-center py-4">
              {lang === "ru"
                ? "Подключи Phantom для записи в блокчейн"
                : "Connect Phantom for on-chain recording"}
            </p>
          ) : (
            <div className="space-y-1.5">
              {txSignatures.length === 0 ? (
                <p className="text-xs text-gray-600 text-center py-2">
                  {lang === "ru"
                    ? "Запусти ИИ — BUY/SELL запишется on-chain"
                    : "Run AI — BUY/SELL will be recorded on-chain"}
                </p>
              ) : (
                txSignatures.slice(0, 6).map((sig, i) => (
                  <div key={sig + i} className="flex items-center justify-between bg-[#12141c] rounded px-2.5 py-1.5">
                    <div className="flex items-center gap-1.5">
                      <CheckCircle2 className="w-3 h-3 text-green-400" />
                      <span className="font-mono text-[10px] text-gray-400">{sig.slice(0, 12)}...{sig.slice(-6)}</span>
                    </div>
                    <a href={getExplorerUrl(sig)} target="_blank" rel="noopener noreferrer"
                      className="text-[10px] text-blue-400 hover:text-blue-300 underline">
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
      <div className="card p-4 mt-3">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <p className="text-xs text-gray-500 uppercase tracking-wide font-semibold">{t("tg.title", lang)}</p>
            <span className={`tag text-[10px] ${tgSettings.enabled ? "bg-green-500/10 text-green-400" : "bg-gray-500/10 text-gray-500"}`}>
              {tgSettings.enabled ? t("tg.enabled", lang) : t("tg.disabled", lang)}
            </span>
            {tgAlertCount > 0 && (
              <span className="text-[10px] text-gray-600">{tgAlertCount} {t("tg.alerts_sent", lang)}</span>
            )}
          </div>
          <button onClick={() => setShowTgSettings((v) => !v)}
            className="btn-secondary px-2.5 py-1 text-[10px] flex items-center gap-1">
            {showTgSettings ? <ChevronUp className="w-3 h-3" /> : <Settings className="w-3 h-3" />}
            {showTgSettings ? (lang === "ru" ? "Скрыть" : "Hide") : (lang === "ru" ? "Настройки" : "Settings")}
          </button>
        </div>

        {/* Status line */}
        {tgSettings.enabled && tgLastSent && (
          <p className="text-[10px] text-gray-600 mb-2">{t("tg.last_sent", lang)}: {tgLastSent}</p>
        )}

        {showTgSettings && (
          <div className="space-y-3 mt-2">
            <p className="text-[10px] text-gray-600">{t("tg.setup_hint", lang)}</p>

            {/* Bot Token */}
            <div>
              <label className="text-[10px] text-gray-500 uppercase tracking-wide">{t("tg.bot_token", lang)}</label>
              <input
                type="password"
                value={tgSettings.botToken}
                onChange={(e) => setTgSettings((s) => ({ ...s, botToken: e.target.value }))}
                placeholder="123456:ABC-DEF..."
                className="w-full mt-1 px-2.5 py-1.5 bg-[#12141c] border border-gray-800 rounded text-xs font-mono text-gray-300 focus:border-blue-500 focus:outline-none"
              />
            </div>

            {/* Chat ID */}
            <div>
              <label className="text-[10px] text-gray-500 uppercase tracking-wide">{t("tg.chat_id", lang)}</label>
              <input
                type="text"
                value={tgSettings.chatId}
                onChange={(e) => setTgSettings((s) => ({ ...s, chatId: e.target.value }))}
                placeholder="-1001234567890"
                className="w-full mt-1 px-2.5 py-1.5 bg-[#12141c] border border-gray-800 rounded text-xs font-mono text-gray-300 focus:border-blue-500 focus:outline-none"
              />
            </div>

            {/* Toggles */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {/* Enable */}
              <button
                onClick={() => setTgSettings((s) => ({ ...s, enabled: !s.enabled }))}
                className={`px-2.5 py-1.5 rounded text-xs font-medium flex items-center gap-1.5 justify-center ${
                  tgSettings.enabled ? "bg-green-500/15 text-green-400 border border-green-500/30" : "bg-[#12141c] text-gray-500 border border-gray-800"
                }`}>
                <div className={`w-2 h-2 rounded-full ${tgSettings.enabled ? "bg-green-400" : "bg-gray-600"}`} />
                {tgSettings.enabled ? t("tg.enabled", lang) : t("tg.disabled", lang)}
              </button>
              {/* Trade Alerts */}
              <button
                onClick={() => setTgSettings((s) => ({ ...s, sendTradeAlerts: !s.sendTradeAlerts }))}
                className={`px-2.5 py-1.5 rounded text-xs flex items-center gap-1.5 justify-center ${
                  tgSettings.sendTradeAlerts ? "bg-blue-500/15 text-blue-400 border border-blue-500/30" : "bg-[#12141c] text-gray-500 border border-gray-800"
                }`}>
                {t("tg.trade_alerts", lang)}
              </button>
              {/* P&L Reports */}
              <button
                onClick={() => setTgSettings((s) => ({ ...s, sendPnLReports: !s.sendPnLReports }))}
                className={`px-2.5 py-1.5 rounded text-xs flex items-center gap-1.5 justify-center ${
                  tgSettings.sendPnLReports ? "bg-purple-500/15 text-purple-400 border border-purple-500/30" : "bg-[#12141c] text-gray-500 border border-gray-800"
                }`}>
                {t("tg.pnl_reports", lang)}
              </button>
              {/* Report Interval */}
              <div className="flex items-center gap-1">
                <span className="text-[10px] text-gray-500 shrink-0">{t("tg.report_interval", lang)}</span>
                <select
                  value={tgSettings.reportIntervalMin}
                  onChange={(e) => setTgSettings((s) => ({ ...s, reportIntervalMin: Number(e.target.value) }))}
                  className="bg-[#12141c] border border-gray-800 rounded px-1.5 py-1 text-xs text-gray-300 focus:outline-none">
                  <option value={15}>15{t("tg.minutes", lang)}</option>
                  <option value={30}>30{t("tg.minutes", lang)}</option>
                  <option value={60}>60{t("tg.minutes", lang)}</option>
                  <option value={0}>Off</option>
                </select>
              </div>
            </div>

            {/* Test button */}
            <button
              onClick={async () => {
                setTgTesting(true);
                const result = await testTelegramConnection(tgSettings.botToken, tgSettings.chatId);
                if (result.success) {
                  addToast(t("tg.test_ok", lang), "success");
                } else {
                  addToast(`${t("tg.test_fail", lang)}: ${result.error || ""}`, "error");
                }
                setTgTesting(false);
              }}
              disabled={tgTesting || !tgSettings.botToken || !tgSettings.chatId}
              className="btn-primary px-4 py-1.5 text-xs w-full flex items-center justify-center gap-1.5 disabled:opacity-50">
              {tgTesting ? (
                <><Loader2 className="w-3.5 h-3.5 animate-spin" />{t("tg.testing", lang)}</>
              ) : (
                <>{t("tg.test", lang)}</>
              )}
            </button>
          </div>
        )}
      </div>

      {/* ML PREDICTOR */}
      <div className="card p-4 mt-3">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <p className="text-xs text-gray-500 uppercase tracking-wide font-semibold">{t("ml.title", lang)}</p>
            {mlMetrics && (
              <span className={`tag text-[10px] ${mlMetrics.testAccuracy > 0.52 ? "bg-green-500/10 text-green-400" : "bg-yellow-500/10 text-yellow-400"}`}>
                Test: {(mlMetrics.testAccuracy * 100).toFixed(0)}%
              </span>
            )}
            {mlPrediction && (
              <span className={`tag text-[10px] ${mlPrediction.direction === "UP" ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400"}`}>
                {mlPrediction.direction === "UP" ? "↑" : "↓"} {t(mlPrediction.direction === "UP" ? "ml.up" : "ml.down", lang)} {(mlPrediction.confidence * 100).toFixed(0)}%
              </span>
            )}
          </div>
          <button onClick={() => setShowMlPanel((v) => !v)}
            className="btn-secondary px-2.5 py-1 text-[10px] flex items-center gap-1">
            {showMlPanel ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {showMlPanel ? (lang === "ru" ? "Скрыть" : "Hide") : (lang === "ru" ? "Подробнее" : "Details")}
          </button>
        </div>

        {showMlPanel && (
          <div className="space-y-3 mt-2">
            {/* Config row */}
            <div className="grid grid-cols-4 gap-2">
              <div>
                <label className="text-[10px] text-gray-500 uppercase">{t("ml.hidden_size", lang)}</label>
                <select value={mlConfig.hiddenSize} onChange={(e) => setMlConfig((c) => ({ ...c, hiddenSize: Number(e.target.value) }))}
                  className="w-full mt-0.5 bg-[#12141c] border border-gray-800 rounded px-1.5 py-1 text-xs text-gray-300 focus:outline-none">
                  <option value={16}>16</option><option value={32}>32</option><option value={64}>64</option>
                </select>
              </div>
              <div>
                <label className="text-[10px] text-gray-500 uppercase">{t("ml.epochs", lang)}</label>
                <select value={mlConfig.epochs} onChange={(e) => setMlConfig((c) => ({ ...c, epochs: Number(e.target.value) }))}
                  className="w-full mt-0.5 bg-[#12141c] border border-gray-800 rounded px-1.5 py-1 text-xs text-gray-300 focus:outline-none">
                  <option value={50}>50</option><option value={100}>100</option><option value={200}>200</option>
                </select>
              </div>
              <div>
                <label className="text-[10px] text-gray-500 uppercase">{t("ml.lookback", lang)}</label>
                <select value={mlConfig.lookback} onChange={(e) => setMlConfig((c) => ({ ...c, lookback: Number(e.target.value) }))}
                  className="w-full mt-0.5 bg-[#12141c] border border-gray-800 rounded px-1.5 py-1 text-xs text-gray-300 focus:outline-none">
                  <option value={7}>7</option><option value={14}>14</option><option value={21}>21</option>
                </select>
              </div>
              <div className="flex items-end">
                <button onClick={handleTrainML} disabled={mlTraining}
                  className="btn-primary px-3 py-1.5 text-xs w-full flex items-center justify-center gap-1 disabled:opacity-50">
                  {mlTraining ? (
                    <><Loader2 className="w-3.5 h-3.5 animate-spin" />{mlProgress ? `${mlProgress.epoch}/${mlProgress.totalEpochs}` : t("ml.training", lang)}</>
                  ) : (
                    <>{t("ml.train", lang)}</>
                  )}
                </button>
              </div>
            </div>

            {/* Training progress */}
            {mlTraining && mlProgress && (
              <div>
                <div className="flex justify-between text-[10px] text-gray-500 mb-1">
                  <span>{t("ml.progress", lang)}: {mlProgress.epoch}/{mlProgress.totalEpochs}</span>
                  <span>Loss: {mlProgress.trainLoss.toFixed(4)} | Train: {(mlProgress.trainAcc * 100).toFixed(0)}% | Test: {(mlProgress.testAcc * 100).toFixed(0)}%</span>
                </div>
                <div className="w-full bg-[#12141c] rounded-full h-1.5">
                  <div className="bg-blue-500 rounded-full h-1.5 transition-all" style={{ width: `${(mlProgress.epoch / mlProgress.totalEpochs) * 100}%` }} />
                </div>
              </div>
            )}

            {/* Results */}
            {mlMetrics && (
              <div className="space-y-3">
                {/* Metrics grid */}
                <div className="grid grid-cols-5 gap-2">
                  <div className="bg-[#12141c] rounded-lg p-2 text-center">
                    <p className="text-[10px] text-gray-500 uppercase">{t("ml.train_acc", lang)}</p>
                    <p className={`text-sm font-bold ${mlMetrics.trainAccuracy > 0.55 ? "text-green-400" : "text-yellow-400"}`}>
                      {(mlMetrics.trainAccuracy * 100).toFixed(1)}%
                    </p>
                  </div>
                  <div className="bg-[#12141c] rounded-lg p-2 text-center">
                    <p className="text-[10px] text-gray-500 uppercase">{t("ml.test_acc", lang)}</p>
                    <p className={`text-sm font-bold ${mlMetrics.testAccuracy > 0.52 ? "text-green-400" : "text-red-400"}`}>
                      {(mlMetrics.testAccuracy * 100).toFixed(1)}%
                    </p>
                  </div>
                  <div className="bg-[#12141c] rounded-lg p-2 text-center">
                    <p className="text-[10px] text-gray-500 uppercase">{t("ml.samples", lang)}</p>
                    <p className="text-sm font-bold text-gray-200">{mlMetrics.totalSamples}</p>
                  </div>
                  <div className="bg-[#12141c] rounded-lg p-2 text-center">
                    <p className="text-[10px] text-gray-500 uppercase">{t("ml.epochs", lang)}</p>
                    <p className="text-sm font-bold text-gray-200">{mlMetrics.epochsRun}</p>
                  </div>
                  <div className="bg-[#12141c] rounded-lg p-2 text-center">
                    <p className="text-[10px] text-gray-500 uppercase">{t("ml.loss", lang)}</p>
                    <p className="text-sm font-bold text-gray-200">{mlMetrics.trainLoss.toFixed(4)}</p>
                  </div>
                </div>

                {/* Current prediction */}
                {mlPrediction && (
                  <div className={`rounded-lg p-3 border ${mlPrediction.direction === "UP" ? "bg-green-500/5 border-green-500/20" : "bg-red-500/5 border-red-500/20"}`}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className={`text-lg font-bold ${mlPrediction.direction === "UP" ? "text-green-400" : "text-red-400"}`}>
                          {mlPrediction.direction === "UP" ? "↑" : "↓"} {t(mlPrediction.direction === "UP" ? "ml.up" : "ml.down", lang)}
                        </span>
                        <span className="text-xs text-gray-400">
                          {t("ml.confidence", lang)}: {(mlPrediction.confidence * 100).toFixed(0)}%
                        </span>
                      </div>
                      <div className="text-right">
                        <p className="text-[10px] text-gray-500 uppercase">{t("ml.target", lang)}</p>
                        <p className="text-sm font-mono text-gray-200">${fmtUSD(mlPrediction.priceTarget)}</p>
                      </div>
                    </div>
                  </div>
                )}

                {/* Ensemble model votes */}
                {mlMetrics.modelVotes && mlMetrics.modelVotes.length > 0 && (
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <p className="text-[10px] text-gray-500 uppercase">Ensemble Models</p>
                      {mlMetrics.ensembleAccuracy !== undefined && (
                        <span className={`text-[10px] font-medium ${mlMetrics.ensembleAccuracy > 0.52 ? "text-green-400" : "text-yellow-400"}`}>
                          Ensemble: {(mlMetrics.ensembleAccuracy * 100).toFixed(0)}%
                        </span>
                      )}
                    </div>
                    <div className="grid grid-cols-4 gap-1.5">
                      {mlMetrics.modelVotes.map((mv) => (
                        <div key={mv.model} className="bg-[#12141c] rounded-lg p-2 text-center">
                          <p className="text-[10px] text-gray-500 truncate">{mv.model}</p>
                          <p className={`text-xs font-bold ${mv.accuracy > 0.52 ? "text-green-400" : mv.accuracy > 0.48 ? "text-yellow-400" : "text-red-400"}`}>
                            {(mv.accuracy * 100).toFixed(0)}%
                          </p>
                          <div className="w-full bg-gray-800 rounded-full h-1 mt-1">
                            <div className="bg-blue-500/60 rounded-full h-1" style={{ width: `${mv.weight * 100}%` }} />
                          </div>
                          <p className="text-[9px] text-gray-600 mt-0.5">w: {(mv.weight * 100).toFixed(0)}%</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Ensemble vote breakdown for current prediction */}
                {mlPrediction?.ensemble && (
                  <div className="grid grid-cols-4 gap-1.5">
                    {[
                      { label: "NN", value: mlPrediction.ensemble.nnVote },
                      { label: "Momentum", value: mlPrediction.ensemble.momentumVote },
                      { label: "Mean Rev", value: mlPrediction.ensemble.meanRevVote },
                      { label: "Trend", value: mlPrediction.ensemble.trendVote },
                    ].map((v) => (
                      <div key={v.label} className="flex items-center gap-1">
                        <span className="text-[9px] text-gray-600 w-14 shrink-0">{v.label}</span>
                        <div className="flex-1 bg-gray-800 rounded-full h-1.5 relative">
                          <div className={`absolute top-0 h-1.5 rounded-full ${v.value > 0.5 ? "bg-green-500/50" : "bg-red-500/50"}`}
                            style={{ width: `${Math.abs(v.value - 0.5) * 200}%`, left: v.value > 0.5 ? "50%" : `${v.value * 100}%` }} />
                        </div>
                        <span className={`text-[9px] w-6 text-right ${v.value > 0.5 ? "text-green-400" : "text-red-400"}`}>
                          {v.value > 0.5 ? "↑" : "↓"}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Feature importance */}
                <div>
                  <p className="text-[10px] text-gray-500 uppercase mb-1.5">{t("ml.features", lang)}</p>
                  <div className="grid grid-cols-2 gap-1">
                    {mlMetrics.featureImportance.slice(0, 8).map((f) => (
                      <div key={f.name} className="flex items-center gap-1.5">
                        <div className="flex-1 bg-[#12141c] rounded-full h-1.5">
                          <div className="bg-blue-500/60 rounded-full h-1.5" style={{ width: `${f.importance * 100}%` }} />
                        </div>
                        <span className="text-[10px] text-gray-500 w-20 shrink-0">{f.name}</span>
                        <span className="text-[10px] text-gray-400 w-8 text-right">{(f.importance * 100).toFixed(0)}%</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Test predictions (last 10) */}
                {mlMetrics.predictions.length > 0 && (
                  <div>
                    <p className="text-[10px] text-gray-500 uppercase mb-1.5">{t("ml.predictions", lang)} ({mlMetrics.predictions.filter((p) => p.actual === p.predicted).length}/{mlMetrics.predictions.length})</p>
                    <div className="flex gap-0.5 flex-wrap">
                      {mlMetrics.predictions.slice(-30).map((p, i) => (
                        <div key={i} className={`w-3 h-3 rounded-sm ${p.actual === p.predicted ? "bg-green-500/40" : "bg-red-500/40"}`}
                          title={`${p.predicted} ${p.actual === p.predicted ? "✓" : "✗"} (${(p.confidence * 100).toFixed(0)}%)`} />
                      ))}
                    </div>
                    <div className="flex gap-3 mt-1">
                      <span className="text-[10px] text-gray-600 flex items-center gap-1">
                        <div className="w-2 h-2 rounded-sm bg-green-500/40" /> {t("ml.correct", lang)}
                      </span>
                      <span className="text-[10px] text-gray-600 flex items-center gap-1">
                        <div className="w-2 h-2 rounded-sm bg-red-500/40" /> {t("ml.wrong", lang)}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {!mlMetrics && !mlTraining && (
              <p className="text-xs text-gray-600 text-center py-2">{t("ml.not_trained", lang)}</p>
            )}
          </div>
        )}
      </div>

      {/* BACKTESTING SECTION */}
      <div className="card p-4 mt-3">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <p className="text-xs text-gray-500 uppercase tracking-wide font-semibold">{t("bt.title", lang)}</p>
            <span className="tag bg-orange-500/10 text-orange-400 text-[10px]">
              {lang === "ru" ? "Тест стратегии" : "Strategy Test"}
            </span>
          </div>
          <button onClick={() => setShowBacktest((v) => !v)}
            className="btn-secondary px-2.5 py-1 text-[10px] flex items-center gap-1">
            {showBacktest ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {showBacktest ? (lang === "ru" ? "Скрыть" : "Hide") : (lang === "ru" ? "Показать" : "Show")}
          </button>
        </div>

        {showBacktest && (
          <div className="space-y-4">
            {/* Config controls */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div>
                <label className="text-[10px] text-gray-500 uppercase tracking-wide">{t("bt.period", lang)}</label>
                <div className="flex gap-1 mt-1">
                  {[30, 60, 90].map((d) => (
                    <button key={d}
                      onClick={() => setBacktestConfig((c) => ({ ...c, days: d }))}
                      className={`px-2 py-1 rounded text-xs font-mono ${backtestConfig.days === d ? "bg-orange-500/20 text-orange-400 border border-orange-500/30" : "bg-[#12141c] text-gray-500 hover:text-gray-300"}`}>
                      {d}{t("bt.days", lang).charAt(0)}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-[10px] text-gray-500 uppercase tracking-wide">{t("bt.capital", lang)}</label>
                <div className="flex gap-1 mt-1">
                  {[1000, 5000, 10000].map((c) => (
                    <button key={c}
                      onClick={() => setBacktestConfig((cfg) => ({ ...cfg, initialCapital: c }))}
                      className={`px-2 py-1 rounded text-xs font-mono ${backtestConfig.initialCapital === c ? "bg-orange-500/20 text-orange-400 border border-orange-500/30" : "bg-[#12141c] text-gray-500 hover:text-gray-300"}`}>
                      ${c >= 1000 ? `${c / 1000}k` : c}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-[10px] text-gray-500 uppercase tracking-wide">{t("bt.strategy_label", lang)}</label>
                <div className="flex gap-1 mt-1">
                  {[0, 1, 2].map((s) => (
                    <button key={s}
                      onClick={() => setBacktestConfig((c) => ({ ...c, strategy: s }))}
                      className={`px-2 py-1 rounded text-xs ${backtestConfig.strategy === s ? "bg-orange-500/20 text-orange-400 border border-orange-500/30" : "bg-[#12141c] text-gray-500 hover:text-gray-300"}`}>
                      {getStrategyName(s, lang)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex items-end">
                <button onClick={handleRunBacktest} disabled={backtestRunning}
                  className="btn-primary px-4 py-1.5 text-xs w-full flex items-center justify-center gap-1.5 disabled:opacity-50">
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
              <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                <div className="h-full bg-orange-500 rounded-full transition-all duration-300" style={{ width: `${backtestProgress}%` }} />
              </div>
            )}

            {/* Results */}
            {backtestResult && (
              <div className="space-y-3">
                {/* Key metrics grid */}
                <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2">
                  {/* Total Return */}
                  <div className="bg-[#12141c] rounded-lg p-2.5 text-center">
                    <p className="text-[9px] text-gray-600 uppercase">{t("bt.total_return", lang)}</p>
                    <p className={`text-lg font-bold font-mono ${backtestResult.metrics.totalReturn >= 0 ? "text-green-400" : "text-red-400"}`}>
                      {backtestResult.metrics.totalReturn >= 0 ? "+" : ""}{backtestResult.metrics.totalReturn.toFixed(2)}%
                    </p>
                    <p className={`text-[10px] font-mono ${backtestResult.metrics.totalReturnUSD >= 0 ? "text-green-600" : "text-red-600"}`}>
                      {backtestResult.metrics.totalReturnUSD >= 0 ? "+" : ""}${fmtUSD(Math.abs(backtestResult.metrics.totalReturnUSD))}
                    </p>
                  </div>
                  {/* Win Rate */}
                  <div className="bg-[#12141c] rounded-lg p-2.5 text-center">
                    <p className="text-[9px] text-gray-600 uppercase">{t("bt.win_rate", lang)}</p>
                    <p className={`text-lg font-bold font-mono ${backtestResult.metrics.winRate >= 50 ? "text-green-400" : "text-red-400"}`}>
                      {backtestResult.metrics.winRate.toFixed(1)}%
                    </p>
                    <p className="text-[10px] text-gray-600">
                      {backtestResult.metrics.winningTrades}W / {backtestResult.metrics.losingTrades}L
                    </p>
                  </div>
                  {/* Max Drawdown */}
                  <div className="bg-[#12141c] rounded-lg p-2.5 text-center">
                    <p className="text-[9px] text-gray-600 uppercase">{t("bt.max_drawdown", lang)}</p>
                    <p className="text-lg font-bold font-mono text-red-400">
                      -{backtestResult.metrics.maxDrawdown.toFixed(2)}%
                    </p>
                    <p className="text-[10px] text-red-600 font-mono">
                      -${fmtUSD(backtestResult.metrics.maxDrawdownUSD)}
                    </p>
                  </div>
                  {/* Sharpe */}
                  <div className="bg-[#12141c] rounded-lg p-2.5 text-center">
                    <p className="text-[9px] text-gray-600 uppercase">{t("bt.sharpe", lang)}</p>
                    <p className={`text-lg font-bold font-mono ${backtestResult.metrics.sharpeRatio >= 1 ? "text-green-400" : backtestResult.metrics.sharpeRatio >= 0 ? "text-yellow-400" : "text-red-400"}`}>
                      {backtestResult.metrics.sharpeRatio.toFixed(2)}
                    </p>
                    <p className="text-[10px] text-gray-600">
                      {backtestResult.metrics.sharpeRatio >= 2 ? "Excellent" : backtestResult.metrics.sharpeRatio >= 1 ? "Good" : backtestResult.metrics.sharpeRatio >= 0 ? "OK" : "Poor"}
                    </p>
                  </div>
                  {/* Profit Factor */}
                  <div className="bg-[#12141c] rounded-lg p-2.5 text-center">
                    <p className="text-[9px] text-gray-600 uppercase">{t("bt.profit_factor", lang)}</p>
                    <p className={`text-lg font-bold font-mono ${backtestResult.metrics.profitFactor >= 1.5 ? "text-green-400" : backtestResult.metrics.profitFactor >= 1 ? "text-yellow-400" : "text-red-400"}`}>
                      {backtestResult.metrics.profitFactor === Infinity ? "∞" : backtestResult.metrics.profitFactor.toFixed(2)}
                    </p>
                    <p className="text-[10px] text-gray-600">{t("bt.total_trades", lang)}: {backtestResult.metrics.totalTrades}</p>
                  </div>
                  {/* Final Capital */}
                  <div className="bg-[#12141c] rounded-lg p-2.5 text-center">
                    <p className="text-[9px] text-gray-600 uppercase">{t("bt.final_capital", lang)}</p>
                    <p className="text-lg font-bold font-mono text-white">
                      ${fmtUSD(backtestResult.finalCapital)}
                    </p>
                    <p className="text-[10px] text-gray-600">
                      {backtestResult.durationDays} {t("bt.days", lang)}
                    </p>
                  </div>
                </div>

                {/* Secondary metrics */}
                <div className="grid grid-cols-3 md:grid-cols-6 gap-1.5">
                  <div className="bg-[#12141c] rounded px-2 py-1.5 text-center">
                    <p className="text-[9px] text-gray-600">{t("bt.annual_return", lang)}</p>
                    <p className={`text-xs font-mono font-bold ${backtestResult.metrics.annualizedReturn >= 0 ? "text-green-400" : "text-red-400"}`}>
                      {backtestResult.metrics.annualizedReturn >= 0 ? "+" : ""}{backtestResult.metrics.annualizedReturn.toFixed(1)}%
                    </p>
                  </div>
                  <div className="bg-[#12141c] rounded px-2 py-1.5 text-center">
                    <p className="text-[9px] text-gray-600">{t("bt.sortino", lang)}</p>
                    <p className={`text-xs font-mono font-bold ${backtestResult.metrics.sortinoRatio >= 1 ? "text-green-400" : "text-yellow-400"}`}>
                      {backtestResult.metrics.sortinoRatio.toFixed(2)}
                    </p>
                  </div>
                  <div className="bg-[#12141c] rounded px-2 py-1.5 text-center">
                    <p className="text-[9px] text-gray-600">{t("bt.avg_win", lang)}</p>
                    <p className="text-xs font-mono font-bold text-green-400">${fmtUSD(backtestResult.metrics.avgWinUSD)}</p>
                  </div>
                  <div className="bg-[#12141c] rounded px-2 py-1.5 text-center">
                    <p className="text-[9px] text-gray-600">{t("bt.avg_loss", lang)}</p>
                    <p className="text-xs font-mono font-bold text-red-400">${fmtUSD(backtestResult.metrics.avgLossUSD)}</p>
                  </div>
                  <div className="bg-[#12141c] rounded px-2 py-1.5 text-center">
                    <p className="text-[9px] text-gray-600">{t("bt.best_trade", lang)}</p>
                    <p className="text-xs font-mono font-bold text-green-400">+{backtestResult.metrics.bestTrade.toFixed(1)}%</p>
                  </div>
                  <div className="bg-[#12141c] rounded px-2 py-1.5 text-center">
                    <p className="text-[9px] text-gray-600">{t("bt.worst_trade", lang)}</p>
                    <p className="text-xs font-mono font-bold text-red-400">{backtestResult.metrics.worstTrade.toFixed(1)}%</p>
                  </div>
                </div>

                {/* Equity Curve (simple text-based visualization) */}
                {backtestResult.equityCurve.length > 0 && (
                  <div className="bg-[#12141c] rounded-lg p-3">
                    <p className="text-[10px] text-gray-500 uppercase tracking-wide mb-2">{t("bt.equity_curve", lang)}</p>
                    <div className="flex items-end gap-px h-24">
                      {(() => {
                        const curve = backtestResult.equityCurve;
                        // Sample ~80 points for display
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
                              className={`flex-1 min-w-[1px] rounded-t-sm ${isProfit ? "bg-green-500/60" : "bg-red-500/60"}`}
                              style={{ height: `${Math.max(2, h)}%` }}
                              title={`$${pt.equity.toFixed(0)} | ${new Date(pt.timestamp * 1000).toLocaleDateString()}`}
                            />
                          );
                        });
                      })()}
                    </div>
                    <div className="flex justify-between mt-1">
                      <span className="text-[9px] text-gray-700">{backtestResult.startDate.toLocaleDateString()}</span>
                      <span className="text-[9px] text-gray-700">{backtestResult.endDate.toLocaleDateString()}</span>
                    </div>
                  </div>
                )}

                {/* Trade Log */}
                {backtestResult.trades.length > 0 && (
                  <div>
                    <p className="text-[10px] text-gray-500 uppercase tracking-wide mb-1.5">{t("bt.trade_log", lang)} ({backtestResult.trades.length})</p>
                    <div className="max-h-40 overflow-y-auto space-y-1">
                      {backtestResult.trades.slice(-20).reverse().map((tr, i) => (
                        <div key={i} className="flex items-center gap-2 bg-[#12141c] rounded px-2.5 py-1.5">
                          <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded min-w-[36px] text-center ${
                            tr.action === "BUY" ? "bg-green-500/15 text-green-400" : "bg-red-500/15 text-red-400"
                          }`}>{tr.action}</span>
                          <span className="text-xs font-mono text-gray-300 min-w-[36px]">{tr.symbol}</span>
                          <span className="text-[10px] font-mono text-gray-400 flex-1">
                            ${fmtUSD(tr.amountUSD)} @ ${fmtUSD(tr.price)}
                          </span>
                          <span className={`text-[10px] font-mono ${tr.confidence >= 0.5 ? "text-green-400" : "text-yellow-400"}`}>
                            {Math.round(tr.confidence * 100)}%
                          </span>
                          <span className="text-[10px] text-gray-700">
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
              <p className="text-xs text-gray-600 text-center py-4">{t("bt.no_data", lang)}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ==================== ML PRICE PREDICTOR ====================
// Lightweight neural network for price direction prediction
// Runs entirely in-browser — no external ML libraries needed
// Architecture: Feedforward NN with 1 hidden layer (configurable)
// Features: TA indicators normalized to [0,1] range
// Output: probability of price going UP in next period

// ==================== TYPES ====================

export interface MLConfig {
  hiddenSize: number;      // neurons in hidden layer
  learningRate: number;
  epochs: number;
  lookback: number;        // candles used for feature window
  trainSplit: number;      // 0.8 = 80% train, 20% test
}

export const DEFAULT_ML_CONFIG: MLConfig = {
  hiddenSize: 64,
  learningRate: 0.005,
  epochs: 150,
  lookback: 20,
  trainSplit: 0.8,
};

export interface MLPrediction {
  direction: "UP" | "DOWN";
  confidence: number;      // 0-1
  priceTarget: number;     // estimated next price
  features: number[];      // raw feature vector used
  ensemble?: {
    nnVote: number;          // NN probability
    momentumVote: number;    // momentum model vote
    meanRevVote: number;     // mean reversion vote
    trendVote: number;       // trend-following vote
    finalScore: number;      // weighted ensemble score
  };
}

export interface MLMetrics {
  trainAccuracy: number;
  testAccuracy: number;
  totalSamples: number;
  trainSamples: number;
  testSamples: number;
  epochsRun: number;
  trainLoss: number;
  predictions: { timestamp: number; actual: "UP" | "DOWN"; predicted: "UP" | "DOWN"; confidence: number }[];
  featureImportance: { name: string; importance: number }[];
  ensembleAccuracy?: number;
  modelVotes?: { model: string; accuracy: number; weight: number }[];
}

export interface MLTrainProgress {
  epoch: number;
  totalEpochs: number;
  trainLoss: number;
  trainAcc: number;
  testAcc: number;
}

// ==================== FEATURE NAMES ====================

const FEATURE_NAMES = [
  "RSI", "MACD_hist", "BB_position", "SMA20_ratio",
  "EMA12_ratio", "Stoch_K", "ADX", "ATR_pct",
  "Return_1", "Return_3", "Return_5", "Return_10",
  "Volatility_5", "Volume_change", "High_Low_range",
  "Close_Open_ratio",
  // V2 features
  "VWAP_ratio", "OBV_trend", "RSI_divergence", "Vol_weighted_mom",
  "Body_ratio", "Upper_shadow", "Lower_shadow", "Price_accel",
];

// ==================== DEEP NEURAL NETWORK ====================
// 2 hidden layers + dropout + GRU memory cell + L2 regularization

class DeepNeuralNetwork {
  private w1: number[][];  // input → hidden1
  private b1: number[];
  private w2: number[][];  // hidden1 → hidden2
  private b2: number[];
  private w3: number[];    // hidden2 → output
  private b3: number;
  // GRU-like memory gate
  private wz: number[][];  // update gate weights
  private bz: number[];
  private wr: number[][];  // reset gate weights
  private br: number[];
  private memory: number[];
  private inputSize: number;
  private h1Size: number;
  private h2Size: number;
  private dropoutRate: number;
  private training: boolean = true;

  constructor(inputSize: number, hiddenSize: number, dropoutRate: number = 0.2) {
    this.inputSize = inputSize;
    this.h1Size = hiddenSize;
    this.h2Size = Math.floor(hiddenSize / 2);
    this.dropoutRate = dropoutRate;

    // Xavier/He initialization
    const s1 = Math.sqrt(2 / (inputSize + this.h1Size));
    const s2 = Math.sqrt(2 / (this.h1Size + this.h2Size));
    const s3 = Math.sqrt(2 / (this.h2Size + 1));

    this.w1 = Array.from({ length: this.h1Size }, () =>
      Array.from({ length: inputSize }, () => (Math.random() * 2 - 1) * s1)
    );
    this.b1 = new Array(this.h1Size).fill(0);

    this.w2 = Array.from({ length: this.h2Size }, () =>
      Array.from({ length: this.h1Size }, () => (Math.random() * 2 - 1) * s2)
    );
    this.b2 = new Array(this.h2Size).fill(0);

    this.w3 = Array.from({ length: this.h2Size }, () => (Math.random() * 2 - 1) * s3);
    this.b3 = 0;

    // GRU gates (operates on hidden1 size)
    const sg = Math.sqrt(2 / (this.h1Size * 2));
    this.wz = Array.from({ length: this.h1Size }, () =>
      Array.from({ length: this.h1Size }, () => (Math.random() * 2 - 1) * sg)
    );
    this.bz = new Array(this.h1Size).fill(0);
    this.wr = Array.from({ length: this.h1Size }, () =>
      Array.from({ length: this.h1Size }, () => (Math.random() * 2 - 1) * sg)
    );
    this.br = new Array(this.h1Size).fill(0);
    this.memory = new Array(this.h1Size).fill(0);
  }

  private leakyRelu(x: number): number { return x > 0 ? x : 0.01 * x; }
  private leakyReluDeriv(x: number): number { return x > 0 ? 1 : 0.01; }
  private sigmoid(x: number): number {
    const c = Math.max(-500, Math.min(500, x));
    return 1 / (1 + Math.exp(-c));
  }

  // Dropout mask
  private dropMask(size: number): number[] {
    if (!this.training || this.dropoutRate <= 0) return new Array(size).fill(1);
    const scale = 1 / (1 - this.dropoutRate);
    return Array.from({ length: size }, () => Math.random() > this.dropoutRate ? scale : 0);
  }

  setTraining(t: boolean): void { this.training = t; }
  resetMemory(): void { this.memory = new Array(this.h1Size).fill(0); }

  // Forward pass: input → h1 (+ GRU memory) → h2 (+ dropout) → output
  forward(input: number[]): { h1: number[]; h1gated: number[]; h2: number[]; output: number; drop1: number[]; drop2: number[] } {
    // Layer 1
    const h1raw = new Array(this.h1Size);
    for (let j = 0; j < this.h1Size; j++) {
      let sum = this.b1[j];
      for (let i = 0; i < this.inputSize; i++) sum += input[i] * this.w1[j][i];
      h1raw[j] = this.leakyRelu(sum);
    }

    // GRU gate: blend h1 with memory
    const h1gated = new Array(this.h1Size);
    for (let j = 0; j < this.h1Size; j++) {
      let zSum = this.bz[j], rSum = this.br[j];
      for (let k = 0; k < this.h1Size; k++) {
        zSum += this.wz[j][k] * this.memory[k];
        rSum += this.wr[j][k] * this.memory[k];
      }
      const z = this.sigmoid(zSum); // update gate
      const r = this.sigmoid(rSum); // reset gate
      h1gated[j] = z * this.memory[j] * r + (1 - z) * h1raw[j];
    }
    // Update memory
    for (let j = 0; j < this.h1Size; j++) this.memory[j] = h1gated[j];

    const drop1 = this.dropMask(this.h1Size);
    const h1dropped = h1gated.map((v, i) => v * drop1[i]);

    // Layer 2
    const h2 = new Array(this.h2Size);
    for (let j = 0; j < this.h2Size; j++) {
      let sum = this.b2[j];
      for (let i = 0; i < this.h1Size; i++) sum += h1dropped[i] * this.w2[j][i];
      h2[j] = this.leakyRelu(sum);
    }

    const drop2 = this.dropMask(this.h2Size);
    const h2dropped = h2.map((v, i) => v * drop2[i]);

    // Output
    let outSum = this.b3;
    for (let j = 0; j < this.h2Size; j++) outSum += h2dropped[j] * this.w3[j];

    return { h1: h1raw, h1gated: h1dropped, h2: h2dropped, output: this.sigmoid(outSum), drop1, drop2 };
  }

  // Train one sample (SGD with backprop + L2)
  train(input: number[], target: number, lr: number, l2: number = 0.0001): number {
    this.setTraining(true);
    const { h1gated, h2, output, drop1, drop2 } = this.forward(input);

    const eps = 1e-7;
    const loss = -(target * Math.log(output + eps) + (1 - target) * Math.log(1 - output + eps));
    const dOut = output - target;

    // Layer 2 → Output
    const dH2 = new Array(this.h2Size).fill(0);
    for (let j = 0; j < this.h2Size; j++) {
      this.w3[j] -= lr * (dOut * h2[j] + l2 * this.w3[j]);
      dH2[j] = dOut * this.w3[j] * this.leakyReluDeriv(h2[j]) * drop2[j];
    }
    this.b3 -= lr * dOut;

    // Layer 1 → Layer 2
    const dH1 = new Array(this.h1Size).fill(0);
    for (let j = 0; j < this.h2Size; j++) {
      for (let i = 0; i < this.h1Size; i++) {
        this.w2[j][i] -= lr * (dH2[j] * h1gated[i] + l2 * this.w2[j][i]);
        dH1[i] += dH2[j] * this.w2[j][i];
      }
      this.b2[j] -= lr * dH2[j];
    }

    // Input → Layer 1
    for (let j = 0; j < this.h1Size; j++) {
      const grad = dH1[j] * this.leakyReluDeriv(h1gated[j]) * drop1[j];
      for (let i = 0; i < this.inputSize; i++) {
        this.w1[j][i] -= lr * (grad * input[i] + l2 * this.w1[j][i]);
      }
      this.b1[j] -= lr * grad;
    }

    return loss;
  }

  predict(input: number[]): number {
    this.setTraining(false);
    return this.forward(input).output;
  }

  getFeatureImportance(): number[] {
    const imp = new Array(this.inputSize).fill(0);
    for (let i = 0; i < this.inputSize; i++) {
      for (let j = 0; j < this.h1Size; j++) imp[i] += Math.abs(this.w1[j][i]);
    }
    const max = Math.max(...imp, 1e-7);
    return imp.map((v) => v / max);
  }

  serialize(): object {
    return {
      inputSize: this.inputSize, h1Size: this.h1Size, h2Size: this.h2Size,
      w1: this.w1, b1: this.b1, w2: this.w2, b2: this.b2, w3: this.w3, b3: this.b3,
      wz: this.wz, bz: this.bz, wr: this.wr, br: this.br, memory: this.memory,
      dropoutRate: this.dropoutRate,
    };
  }

  static deserialize(data: any): DeepNeuralNetwork {
    const nn = new DeepNeuralNetwork(data.inputSize, data.h1Size, data.dropoutRate || 0.2);
    nn.w1 = data.w1; nn.b1 = data.b1; nn.w2 = data.w2; nn.b2 = data.b2;
    nn.w3 = data.w3; nn.b3 = data.b3;
    nn.wz = data.wz; nn.bz = data.bz; nn.wr = data.wr; nn.br = data.br;
    nn.memory = data.memory || new Array(data.h1Size).fill(0);
    return nn;
  }
}

// Backward compat alias
type NeuralNetwork = DeepNeuralNetwork;
const NeuralNetwork = DeepNeuralNetwork;

// ==================== FEATURE EXTRACTION ====================

interface OHLCV {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function sma(data: number[], period: number): number {
  if (data.length < period) return data[data.length - 1] || 0;
  const slice = data.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / period;
}

function ema(data: number[], period: number): number {
  if (data.length === 0) return 0;
  const k = 2 / (period + 1);
  let val = data[0];
  for (let i = 1; i < data.length; i++) {
    val = data[i] * k + val * (1 - k);
  }
  return val;
}

function stdDev(data: number[]): number {
  if (data.length < 2) return 0;
  const m = data.reduce((s, v) => s + v, 0) / data.length;
  return Math.sqrt(data.reduce((s, v) => s + (v - m) ** 2, 0) / (data.length - 1));
}

function extractFeatures(candles: OHLCV[], idx: number, lookback: number): number[] | null {
  if (idx < lookback) return null;

  const window = candles.slice(idx - lookback, idx + 1);
  const closes = window.map((c) => c.close);
  const cur = candles[idx];
  const prev = candles[idx - 1];

  if (!cur || !prev || cur.close === 0) return null;

  // 1. RSI (simplified)
  let gains = 0, losses = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const avgGain = gains / lookback;
  const avgLoss = losses / lookback;
  const rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  // 2. MACD histogram (simplified)
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, Math.min(26, closes.length));
  const macdHist = ema12 - ema26;

  // 3. Bollinger Band position
  const sma20 = sma(closes, Math.min(20, closes.length));
  const sd = stdDev(closes.slice(-Math.min(20, closes.length)));
  const bbUpper = sma20 + 2 * sd;
  const bbLower = sma20 - 2 * sd;
  const bbPos = (bbUpper - bbLower) > 0 ? (cur.close - bbLower) / (bbUpper - bbLower) : 0.5;

  // 4. SMA20 ratio
  const sma20Ratio = sma20 > 0 ? cur.close / sma20 : 1;

  // 5. EMA12 ratio
  const ema12Ratio = ema12 > 0 ? cur.close / ema12 : 1;

  // 6. Stochastic K
  const highs = window.map((c) => c.high);
  const lows = window.map((c) => c.low);
  const highMax = Math.max(...highs);
  const lowMin = Math.min(...lows);
  const stochK = (highMax - lowMin) > 0 ? ((cur.close - lowMin) / (highMax - lowMin)) * 100 : 50;

  // 7. ADX (simplified — directional strength)
  let upMoves = 0, downMoves = 0;
  for (let i = 1; i < window.length; i++) {
    const up = window[i].high - window[i - 1].high;
    const down = window[i - 1].low - window[i].low;
    if (up > down && up > 0) upMoves += up;
    if (down > up && down > 0) downMoves += down;
  }
  const adxApprox = (upMoves + downMoves) > 0 ? Math.abs(upMoves - downMoves) / (upMoves + downMoves) * 100 : 0;

  // 8. ATR %
  let trSum = 0;
  for (let i = 1; i < window.length; i++) {
    trSum += Math.max(
      window[i].high - window[i].low,
      Math.abs(window[i].high - window[i - 1].close),
      Math.abs(window[i].low - window[i - 1].close),
    );
  }
  const atrPct = cur.close > 0 ? (trSum / (window.length - 1)) / cur.close * 100 : 0;

  // 9-12. Price returns
  const ret1 = prev.close > 0 ? (cur.close - prev.close) / prev.close * 100 : 0;
  const ret3 = idx >= 3 && candles[idx - 3].close > 0 ? (cur.close - candles[idx - 3].close) / candles[idx - 3].close * 100 : 0;
  const ret5 = idx >= 5 && candles[idx - 5].close > 0 ? (cur.close - candles[idx - 5].close) / candles[idx - 5].close * 100 : 0;
  const ret10 = idx >= 10 && candles[idx - 10].close > 0 ? (cur.close - candles[idx - 10].close) / candles[idx - 10].close * 100 : 0;

  // 13. Volatility (5-period std of returns)
  const returns5: number[] = [];
  for (let i = Math.max(1, idx - 4); i <= idx; i++) {
    if (candles[i - 1].close > 0) returns5.push((candles[i].close - candles[i - 1].close) / candles[i - 1].close);
  }
  const vol5 = stdDev(returns5) * 100;

  // 14. Volume change
  const volChange = prev.volume > 0 && cur.volume > 0 ? cur.volume / prev.volume : 1;

  // 15. High-Low range %
  const hlRange = cur.close > 0 ? (cur.high - cur.low) / cur.close * 100 : 0;

  // 16. Close-Open ratio
  const coRatio = cur.open > 0 ? cur.close / cur.open : 1;

  // ==================== V2 FEATURES ====================

  // 17. VWAP ratio — volume-weighted average price position
  let vwapNum = 0, vwapDen = 0;
  for (const c of window) {
    const tp = (c.high + c.low + c.close) / 3;
    vwapNum += tp * c.volume;
    vwapDen += c.volume;
  }
  const vwap = vwapDen > 0 ? vwapNum / vwapDen : cur.close;
  const vwapRatio = vwap > 0 ? cur.close / vwap : 1;

  // 18. OBV trend — on-balance volume direction
  let obv = 0;
  for (let i = 1; i < window.length; i++) {
    if (window[i].close > window[i - 1].close) obv += window[i].volume;
    else if (window[i].close < window[i - 1].close) obv -= window[i].volume;
  }
  const obvMax = window.reduce((s, c) => s + c.volume, 0);
  const obvNorm = obvMax > 0 ? obv / obvMax : 0;

  // 19. RSI divergence — price vs RSI direction mismatch
  const priceDir = cur.close > candles[Math.max(0, idx - 5)].close ? 1 : -1;
  // Compute RSI at idx-5 for divergence check
  let rsi5Gains = 0, rsi5Losses = 0;
  const w5start = Math.max(0, idx - 5 - lookback);
  const w5 = candles.slice(w5start, Math.max(1, idx - 5) + 1).map((c) => c.close);
  for (let i = 1; i < w5.length; i++) {
    const d = w5[i] - w5[i - 1];
    if (d > 0) rsi5Gains += d; else rsi5Losses -= d;
  }
  const rsi5 = rsi5Losses === 0 ? 100 : 100 - 100 / (1 + (rsi5Gains / Math.max(1, w5.length - 1)) / (rsi5Losses / Math.max(1, w5.length - 1)));
  const rsiDir = rsi > rsi5 ? 1 : -1;
  const rsiDivergence = priceDir !== rsiDir ? 1 : 0; // divergence detected

  // 20. Volume-weighted momentum
  let volMom = 0, volTotal = 0;
  for (let i = Math.max(1, window.length - 5); i < window.length; i++) {
    const ret = window[i - 1].close > 0 ? (window[i].close - window[i - 1].close) / window[i - 1].close : 0;
    volMom += ret * window[i].volume;
    volTotal += window[i].volume;
  }
  const volWeightedMom = volTotal > 0 ? volMom / volTotal : 0;

  // 21. Candle body ratio (body size / total range)
  const bodySize = Math.abs(cur.close - cur.open);
  const totalRange = cur.high - cur.low;
  const bodyRatio = totalRange > 0 ? bodySize / totalRange : 0.5;

  // 22. Upper shadow ratio
  const upperShadow = cur.high - Math.max(cur.close, cur.open);
  const upperShadowRatio = totalRange > 0 ? upperShadow / totalRange : 0;

  // 23. Lower shadow ratio
  const lowerShadow = Math.min(cur.close, cur.open) - cur.low;
  const lowerShadowRatio = totalRange > 0 ? lowerShadow / totalRange : 0;

  // 24. Price acceleration (2nd derivative of returns)
  const accelRet1 = ret1;
  const accelRet2 = idx >= 2 && candles[idx - 2].close > 0
    ? (candles[idx - 1].close - candles[idx - 2].close) / candles[idx - 2].close * 100 : 0;
  const priceAccel = accelRet1 - accelRet2;

  return [
    rsi / 100,                          // [0,1]
    clamp((macdHist / cur.close) * 50 + 0.5, 0, 1), // normalized around 0.5
    clamp(bbPos, 0, 1),                 // [0,1]
    clamp((sma20Ratio - 0.9) * 5, 0, 1), // normalize ratio
    clamp((ema12Ratio - 0.9) * 5, 0, 1),
    stochK / 100,                       // [0,1]
    clamp(adxApprox / 100, 0, 1),       // [0,1]
    clamp(atrPct / 10, 0, 1),           // normalize
    clamp(ret1 / 10 + 0.5, 0, 1),      // center at 0.5
    clamp(ret3 / 20 + 0.5, 0, 1),
    clamp(ret5 / 30 + 0.5, 0, 1),
    clamp(ret10 / 50 + 0.5, 0, 1),
    clamp(vol5 / 5, 0, 1),             // normalize
    clamp(volChange / 3, 0, 1),         // normalize
    clamp(hlRange / 10, 0, 1),
    clamp((coRatio - 0.95) * 10, 0, 1),
    // V2 features
    clamp((vwapRatio - 0.95) * 10, 0, 1),       // VWAP position
    clamp(obvNorm + 0.5, 0, 1),                  // OBV trend [-1,1] → [0,1]
    rsiDivergence,                                // 0 or 1
    clamp(volWeightedMom * 100 + 0.5, 0, 1),    // volume-weighted momentum
    clamp(bodyRatio, 0, 1),                       // body ratio
    clamp(upperShadowRatio, 0, 1),               // upper shadow
    clamp(lowerShadowRatio, 0, 1),               // lower shadow
    clamp(priceAccel / 10 + 0.5, 0, 1),         // price acceleration
  ];
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

// ==================== ML PREDICTOR CLASS ====================

export class MLPredictor {
  private nn: NeuralNetwork | null = null;
  private config: MLConfig;
  private trained: boolean = false;
  private lastMetrics: MLMetrics | null = null;

  constructor(config: MLConfig = DEFAULT_ML_CONFIG) {
    this.config = config;
  }

  isReady(): boolean { return this.trained && this.nn !== null; }
  getMetrics(): MLMetrics | null { return this.lastMetrics; }

  // ==================== TRAIN ====================

  async train(
    candles: OHLCV[],
    onProgress?: (p: MLTrainProgress) => void,
  ): Promise<MLMetrics> {
    const { hiddenSize, learningRate, epochs, lookback, trainSplit } = this.config;

    // Build dataset
    const X: number[][] = [];
    const Y: number[] = [];
    const timestamps: number[] = [];

    for (let i = lookback; i < candles.length - 1; i++) {
      const features = extractFeatures(candles, i, lookback);
      if (!features) continue;

      // Label: 1 if next candle closes higher, 0 otherwise
      const nextClose = candles[i + 1].close;
      const curClose = candles[i].close;
      const label = nextClose > curClose ? 1 : 0;

      X.push(features);
      Y.push(label);
      timestamps.push(candles[i].timestamp);
    }

    if (X.length < 20) {
      throw new Error(`Insufficient data: ${X.length} samples (need ≥20)`);
    }

    // Split train/test
    const splitIdx = Math.floor(X.length * trainSplit);
    const trainX = X.slice(0, splitIdx);
    const trainY = Y.slice(0, splitIdx);
    const testX = X.slice(splitIdx);
    const testY = Y.slice(splitIdx);
    const testTimestamps = timestamps.slice(splitIdx);

    // Create network
    const inputSize = X[0].length;
    this.nn = new NeuralNetwork(inputSize, hiddenSize);

    let trainLoss = 0;
    let trainAcc = 0;
    let testAcc = 0;

    // Training loop
    for (let epoch = 0; epoch < epochs; epoch++) {
      // Shuffle training data
      const indices = Array.from({ length: trainX.length }, (_, i) => i);
      for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
      }

      trainLoss = 0;
      for (const idx of indices) {
        trainLoss += this.nn.train(trainX[idx], trainY[idx], learningRate);
      }
      trainLoss /= trainX.length;

      // Compute accuracies every 10 epochs
      if (epoch % 10 === 0 || epoch === epochs - 1) {
        trainAcc = this.computeAccuracy(trainX, trainY);
        testAcc = this.computeAccuracy(testX, testY);

        if (onProgress) {
          onProgress({ epoch: epoch + 1, totalEpochs: epochs, trainLoss, trainAcc, testAcc });
        }
      }

      // Yield to UI every 5 epochs
      if (epoch % 5 === 0) {
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    // Final metrics
    trainAcc = this.computeAccuracy(trainX, trainY);
    testAcc = this.computeAccuracy(testX, testY);

    // Test predictions
    const predictions = testX.map((x, i) => {
      const prob = this.nn!.predict(x);
      const predicted = prob > 0.5 ? "UP" as const : "DOWN" as const;
      const actual = testY[i] === 1 ? "UP" as const : "DOWN" as const;
      return { timestamp: testTimestamps[i], actual, predicted, confidence: Math.abs(prob - 0.5) * 2 };
    });

    // Feature importance
    const importanceVals = this.nn.getFeatureImportance();
    const featureImportance = FEATURE_NAMES.map((name, i) => ({
      name,
      importance: importanceVals[i] || 0,
    })).sort((a, b) => b.importance - a.importance);

    this.trained = true;
    this.lastMetrics = {
      trainAccuracy: trainAcc,
      testAccuracy: testAcc,
      totalSamples: X.length,
      trainSamples: trainX.length,
      testSamples: testX.length,
      epochsRun: epochs,
      trainLoss,
      predictions,
      featureImportance,
    };

    return this.lastMetrics;
  }

  // ==================== PREDICT ====================

  predict(candles: OHLCV[]): MLPrediction | null {
    if (!this.nn || !this.trained || candles.length < this.config.lookback + 1) return null;

    const idx = candles.length - 1;
    const features = extractFeatures(candles, idx, this.config.lookback);
    if (!features) return null;

    const prob = this.nn.predict(features);
    const direction = prob > 0.5 ? "UP" as const : "DOWN" as const;
    const confidence = Math.abs(prob - 0.5) * 2;

    // Estimate price target using recent volatility
    const curPrice = candles[idx].close;
    const returns: number[] = [];
    for (let i = Math.max(1, candles.length - 10); i < candles.length; i++) {
      if (candles[i - 1].close > 0) {
        returns.push(Math.abs((candles[i].close - candles[i - 1].close) / candles[i - 1].close));
      }
    }
    const avgMove = returns.length > 0 ? returns.reduce((s, v) => s + v, 0) / returns.length : 0.01;
    const priceTarget = direction === "UP"
      ? curPrice * (1 + avgMove * confidence)
      : curPrice * (1 - avgMove * confidence);

    return { direction, confidence, priceTarget, features };
  }

  // ==================== HELPERS ====================

  private computeAccuracy(X: number[][], Y: number[]): number {
    if (!this.nn || X.length === 0) return 0;
    let correct = 0;
    for (let i = 0; i < X.length; i++) {
      const pred = this.nn.predict(X[i]) > 0.5 ? 1 : 0;
      if (pred === Y[i]) correct++;
    }
    return correct / X.length;
  }

  // Serialize model
  serialize(): object | null {
    if (!this.nn) return null;
    return { config: this.config, nn: this.nn.serialize(), trained: this.trained };
  }

  // Deserialize model
  static deserialize(data: any): MLPredictor {
    const pred = new MLPredictor(data.config);
    pred.nn = NeuralNetwork.deserialize(data.nn);
    pred.trained = data.trained;
    return pred;
  }
}

// ==================== ENSEMBLE MODEL ====================
// Combines: Neural Network + Momentum + Mean Reversion + Trend Following
// Each sub-model votes, weighted by recent accuracy

function momentumScore(candles: OHLCV[], idx: number): number {
  if (idx < 10) return 0.5;
  const ret1 = candles[idx].close / candles[idx - 1].close - 1;
  const ret3 = candles[idx].close / candles[idx - 3].close - 1;
  const ret5 = candles[idx].close / candles[idx - 5].close - 1;
  const ret10 = candles[idx].close / candles[idx - 10].close - 1;
  // Weighted momentum: recent returns weighted more
  const score = ret1 * 0.4 + ret3 * 0.3 + ret5 * 0.2 + ret10 * 0.1;
  return clamp(score * 20 + 0.5, 0, 1); // normalize to 0-1
}

function meanReversionScore(candles: OHLCV[], idx: number, lookback: number): number {
  if (idx < lookback) return 0.5;
  const closes = candles.slice(idx - lookback, idx + 1).map((c) => c.close);
  const mean = closes.reduce((s, v) => s + v, 0) / closes.length;
  const cur = candles[idx].close;
  // Distance from mean — further from mean = stronger reversion signal
  const deviation = mean > 0 ? (cur - mean) / mean : 0;
  // Invert: if price is above mean, predict DOWN (revert), and vice versa
  return clamp(-deviation * 10 + 0.5, 0, 1);
}

function trendFollowingScore(candles: OHLCV[], idx: number): number {
  if (idx < 20) return 0.5;
  const closes = candles.slice(idx - 20, idx + 1).map((c) => c.close);
  // Simple trend: slope of linear regression
  const n = closes.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i; sumY += closes[i]; sumXY += i * closes[i]; sumX2 += i * i;
  }
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const avgPrice = sumY / n;
  const normalizedSlope = avgPrice > 0 ? slope / avgPrice : 0;
  return clamp(normalizedSlope * 200 + 0.5, 0, 1);
}

export class EnsemblePredictor {
  private mlPredictor: MLPredictor;
  private modelWeights = { nn: 0.4, momentum: 0.2, meanRev: 0.2, trend: 0.2 };
  private config: MLConfig;
  private candles: OHLCV[] = [];

  constructor(config: MLConfig = DEFAULT_ML_CONFIG) {
    this.config = config;
    this.mlPredictor = new MLPredictor(config);
  }

  isReady(): boolean { return this.mlPredictor.isReady(); }
  getMetrics(): MLMetrics | null { return this.mlPredictor.getMetrics(); }

  async train(
    candles: OHLCV[],
    onProgress?: (p: MLTrainProgress) => void,
  ): Promise<MLMetrics> {
    this.candles = candles;
    const metrics = await this.mlPredictor.train(candles, onProgress);

    // Evaluate each sub-model on test set
    const splitIdx = Math.floor((candles.length - this.config.lookback - 1) * this.config.trainSplit) + this.config.lookback;
    let nnCorrect = 0, momCorrect = 0, mrCorrect = 0, trendCorrect = 0, ensCorrect = 0;
    let testCount = 0;

    for (let i = splitIdx; i < candles.length - 1; i++) {
      const actual = candles[i + 1].close > candles[i].close ? 1 : 0;
      const nnProb = this.mlPredictor.predict(candles.slice(0, i + 1));
      const nnVote = nnProb ? (nnProb.direction === "UP" ? 1 : 0) : 0.5;
      const momVote = momentumScore(candles, i) > 0.5 ? 1 : 0;
      const mrVote = meanReversionScore(candles, i, this.config.lookback) > 0.5 ? 1 : 0;
      const trendVote = trendFollowingScore(candles, i) > 0.5 ? 1 : 0;

      if (nnVote === actual) nnCorrect++;
      if (momVote === actual) momCorrect++;
      if (mrVote === actual) mrCorrect++;
      if (trendVote === actual) trendCorrect++;

      // Weighted ensemble vote
      const ensScore = (nnVote === 1 ? this.modelWeights.nn : 0) +
        (momVote === 1 ? this.modelWeights.momentum : 0) +
        (mrVote === 1 ? this.modelWeights.meanRev : 0) +
        (trendVote === 1 ? this.modelWeights.trend : 0);
      if ((ensScore > 0.5 ? 1 : 0) === actual) ensCorrect++;
      testCount++;
    }

    const ensAcc = testCount > 0 ? ensCorrect / testCount : 0;

    // Adaptive weight update: boost models with better accuracy
    if (testCount > 5) {
      const accs = [
        nnCorrect / testCount,
        momCorrect / testCount,
        mrCorrect / testCount,
        trendCorrect / testCount,
      ];
      const totalAcc = accs.reduce((s, a) => s + a, 0);
      if (totalAcc > 0) {
        this.modelWeights = {
          nn: Math.max(0.1, accs[0] / totalAcc),
          momentum: Math.max(0.05, accs[1] / totalAcc),
          meanRev: Math.max(0.05, accs[2] / totalAcc),
          trend: Math.max(0.05, accs[3] / totalAcc),
        };
        // Renormalize
        const wSum = this.modelWeights.nn + this.modelWeights.momentum + this.modelWeights.meanRev + this.modelWeights.trend;
        this.modelWeights.nn /= wSum;
        this.modelWeights.momentum /= wSum;
        this.modelWeights.meanRev /= wSum;
        this.modelWeights.trend /= wSum;
      }
    }

    // Enhance metrics with ensemble info
    metrics.ensembleAccuracy = ensAcc;
    metrics.modelVotes = [
      { model: "Neural Net", accuracy: testCount > 0 ? nnCorrect / testCount : 0, weight: this.modelWeights.nn },
      { model: "Momentum", accuracy: testCount > 0 ? momCorrect / testCount : 0, weight: this.modelWeights.momentum },
      { model: "Mean Rev", accuracy: testCount > 0 ? mrCorrect / testCount : 0, weight: this.modelWeights.meanRev },
      { model: "Trend", accuracy: testCount > 0 ? trendCorrect / testCount : 0, weight: this.modelWeights.trend },
    ];

    return metrics;
  }

  predict(candles?: OHLCV[]): MLPrediction | null {
    const data = candles || this.candles;
    if (data.length < this.config.lookback + 1) return null;

    const nnPred = this.mlPredictor.predict(data);
    const idx = data.length - 1;

    const nnProb = nnPred ? (nnPred.direction === "UP" ? nnPred.confidence * 0.5 + 0.5 : 0.5 - nnPred.confidence * 0.5) : 0.5;
    const momProb = momentumScore(data, idx);
    const mrProb = meanReversionScore(data, idx, this.config.lookback);
    const trendProb = trendFollowingScore(data, idx);

    // Weighted ensemble
    const finalScore = nnProb * this.modelWeights.nn +
      momProb * this.modelWeights.momentum +
      mrProb * this.modelWeights.meanRev +
      trendProb * this.modelWeights.trend;

    const direction = finalScore > 0.5 ? "UP" as const : "DOWN" as const;
    const confidence = Math.abs(finalScore - 0.5) * 2;

    // Price target
    const curPrice = data[idx].close;
    const returns: number[] = [];
    for (let i = Math.max(1, data.length - 10); i < data.length; i++) {
      if (data[i - 1].close > 0) returns.push(Math.abs((data[i].close - data[i - 1].close) / data[i - 1].close));
    }
    const avgMove = returns.length > 0 ? returns.reduce((s, v) => s + v, 0) / returns.length : 0.01;
    const priceTarget = direction === "UP" ? curPrice * (1 + avgMove * confidence) : curPrice * (1 - avgMove * confidence);

    return {
      direction,
      confidence,
      priceTarget,
      features: nnPred?.features || [],
      ensemble: {
        nnVote: nnProb,
        momentumVote: momProb,
        meanRevVote: mrProb,
        trendVote: trendProb,
        finalScore,
      },
    };
  }

  // Get signal for AI integration: -1 to +1
  getSignal(candles?: OHLCV[]): { signal: number; confidence: number; direction: "UP" | "DOWN" } {
    const pred = this.predict(candles);
    if (!pred) return { signal: 0, confidence: 0, direction: "UP" };
    const signal = pred.direction === "UP" ? pred.confidence : -pred.confidence;
    return { signal, confidence: pred.confidence, direction: pred.direction };
  }
}

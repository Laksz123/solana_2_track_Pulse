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
  hiddenSize: 32,
  learningRate: 0.01,
  epochs: 100,
  lookback: 14,
  trainSplit: 0.8,
};

export interface MLPrediction {
  direction: "UP" | "DOWN";
  confidence: number;      // 0-1
  priceTarget: number;     // estimated next price
  features: number[];      // raw feature vector used
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
];

// ==================== NEURAL NETWORK ====================

class NeuralNetwork {
  private weightsIH: number[][];  // input → hidden
  private biasH: number[];
  private weightsHO: number[];    // hidden → output
  private biasO: number;
  private inputSize: number;
  private hiddenSize: number;

  constructor(inputSize: number, hiddenSize: number) {
    this.inputSize = inputSize;
    this.hiddenSize = hiddenSize;

    // Xavier initialization
    const scaleIH = Math.sqrt(2 / (inputSize + hiddenSize));
    const scaleHO = Math.sqrt(2 / (hiddenSize + 1));

    this.weightsIH = Array.from({ length: hiddenSize }, () =>
      Array.from({ length: inputSize }, () => (Math.random() * 2 - 1) * scaleIH)
    );
    this.biasH = new Array(hiddenSize).fill(0);
    this.weightsHO = Array.from({ length: hiddenSize }, () => (Math.random() * 2 - 1) * scaleHO);
    this.biasO = 0;
  }

  // ReLU activation
  private relu(x: number): number { return Math.max(0, x); }
  private reluDeriv(x: number): number { return x > 0 ? 1 : 0; }

  // Sigmoid for output
  private sigmoid(x: number): number {
    const clamped = Math.max(-500, Math.min(500, x));
    return 1 / (1 + Math.exp(-clamped));
  }

  // Forward pass
  forward(input: number[]): { hidden: number[]; output: number } {
    const hidden = new Array(this.hiddenSize);
    for (let j = 0; j < this.hiddenSize; j++) {
      let sum = this.biasH[j];
      for (let i = 0; i < this.inputSize; i++) {
        sum += input[i] * this.weightsIH[j][i];
      }
      hidden[j] = this.relu(sum);
    }

    let outSum = this.biasO;
    for (let j = 0; j < this.hiddenSize; j++) {
      outSum += hidden[j] * this.weightsHO[j];
    }

    return { hidden, output: this.sigmoid(outSum) };
  }

  // Train one sample (SGD with backprop)
  train(input: number[], target: number, lr: number): number {
    // Forward
    const { hidden, output } = this.forward(input);

    // Binary cross-entropy loss
    const eps = 1e-7;
    const loss = -(target * Math.log(output + eps) + (1 - target) * Math.log(1 - output + eps));

    // Output gradient (sigmoid + BCE derivative)
    const dOutput = output - target;

    // Hidden → Output gradients
    for (let j = 0; j < this.hiddenSize; j++) {
      const dW = dOutput * hidden[j];
      this.weightsHO[j] -= lr * dW;
    }
    this.biasO -= lr * dOutput;

    // Input → Hidden gradients
    for (let j = 0; j < this.hiddenSize; j++) {
      const dHidden = dOutput * this.weightsHO[j] * this.reluDeriv(hidden[j]);
      for (let i = 0; i < this.inputSize; i++) {
        this.weightsIH[j][i] -= lr * dHidden * input[i];
      }
      this.biasH[j] -= lr * dHidden;
    }

    return loss;
  }

  // Predict
  predict(input: number[]): number {
    return this.forward(input).output;
  }

  // Feature importance (absolute weight sums from input layer)
  getFeatureImportance(): number[] {
    const importance = new Array(this.inputSize).fill(0);
    for (let i = 0; i < this.inputSize; i++) {
      for (let j = 0; j < this.hiddenSize; j++) {
        importance[i] += Math.abs(this.weightsIH[j][i]);
      }
    }
    // Normalize to 0-1
    const max = Math.max(...importance, 1e-7);
    return importance.map((v) => v / max);
  }

  // Serialize
  serialize(): object {
    return {
      inputSize: this.inputSize,
      hiddenSize: this.hiddenSize,
      weightsIH: this.weightsIH,
      biasH: this.biasH,
      weightsHO: this.weightsHO,
      biasO: this.biasO,
    };
  }

  // Deserialize
  static deserialize(data: any): NeuralNetwork {
    const nn = new NeuralNetwork(data.inputSize, data.hiddenSize);
    nn.weightsIH = data.weightsIH;
    nn.biasH = data.biasH;
    nn.weightsHO = data.weightsHO;
    nn.biasO = data.biasO;
    return nn;
  }
}

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

// ==================== JUPITER DEX INTEGRATION ====================
// Real token swaps on Solana via Jupiter V6 API (aggregator)
// Supports: SOL, BTC (wBTC), ETH (wETH), BONK, JUP, RAY

import {
  Connection,
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  AddressLookupTableAccount,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";

// ==================== TOKEN MINTS (Solana Mainnet / Devnet) ====================

export const TOKEN_MINTS: Record<string, string> = {
  // Native SOL (wrapped)
  SOL: "So11111111111111111111111111111111111111112",
  // USDC on Solana
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  // Wrapped BTC (Solana)
  BTC: "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
  // Wrapped ETH (Solana)
  ETH: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
  // BONK
  BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  // Jupiter
  JUP: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  // Raydium
  RAY: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
};

// CoinGecko ID → token symbol mapping
export const COINGECKO_TO_SYMBOL: Record<string, string> = {
  solana: "SOL",
  bitcoin: "BTC",
  ethereum: "ETH",
  bonk: "BONK",
  "jupiter-exchange-solana": "JUP",
  raydium: "RAY",
};

// Token decimals
export const TOKEN_DECIMALS: Record<string, number> = {
  SOL: 9,
  USDC: 6,
  BTC: 8,
  ETH: 8,
  BONK: 5,
  JUP: 6,
  RAY: 6,
};

// ==================== JUPITER API ====================

const JUPITER_API_BASE = "https://quote-api.jup.ag/v6";

// ==================== TYPES ====================

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: Array<{
    swapInfo: {
      ammKey: string;
      label: string;
      inputMint: string;
      outputMint: string;
      inAmount: string;
      outAmount: string;
      feeAmount: string;
      feeMint: string;
    };
    percent: number;
  }>;
}

export interface SwapResult {
  success: boolean;
  signature?: string;
  inputAmount: number;
  outputAmount: number;
  inputSymbol: string;
  outputSymbol: string;
  priceImpact: number;
  error?: string;
}

export interface SwapSettings {
  slippageBps: number;       // slippage in basis points (50 = 0.5%)
  maxPriceImpactPct: number; // max acceptable price impact %
  priorityFee: number;       // priority fee in lamports (for faster inclusion)
  confirmBeforeSwap: boolean; // require user confirmation
  maxTradeUSD: number;       // max single trade size in USD
  enableRealSwaps: boolean;  // master switch: false = simulation only
}

export const DEFAULT_SWAP_SETTINGS: SwapSettings = {
  slippageBps: 50,            // 0.5% slippage
  maxPriceImpactPct: 1.0,     // max 1% price impact
  priorityFee: 50000,         // 0.00005 SOL priority fee
  confirmBeforeSwap: true,    // require confirmation by default
  maxTradeUSD: 100,           // max $100 per trade (safety)
  enableRealSwaps: false,     // START WITH SIMULATION — user must enable
};

// ==================== QUOTE ====================

/**
 * Get a swap quote from Jupiter
 * @param inputSymbol - e.g. "SOL", "USDC"
 * @param outputSymbol - e.g. "BTC", "BONK"
 * @param amountRaw - amount in raw units (lamports for SOL, smallest unit for tokens)
 * @param slippageBps - slippage tolerance in basis points
 */
export async function getJupiterQuote(
  inputSymbol: string,
  outputSymbol: string,
  amountRaw: string,
  slippageBps: number = 50,
): Promise<JupiterQuote | null> {
  const inputMint = TOKEN_MINTS[inputSymbol];
  const outputMint = TOKEN_MINTS[outputSymbol];

  if (!inputMint || !outputMint) {
    console.error(`Unknown token: ${inputSymbol} or ${outputSymbol}`);
    return null;
  }

  const url = `${JUPITER_API_BASE}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=${slippageBps}&swapMode=ExactIn`;

  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      const text = await resp.text();
      console.error(`Jupiter quote error ${resp.status}:`, text);
      return null;
    }
    return await resp.json();
  } catch (err) {
    console.error("Jupiter quote fetch error:", err);
    return null;
  }
}

// ==================== SWAP TRANSACTION ====================

/**
 * Build a swap transaction from a Jupiter quote
 */
export async function buildSwapTransaction(
  quote: JupiterQuote,
  userPublicKey: PublicKey,
  priorityFee: number = 50000,
): Promise<VersionedTransaction | null> {
  const url = `${JUPITER_API_BASE}/swap`;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: userPublicKey.toBase58(),
        wrapAndUnwrapSol: true,
        computeUnitPriceMicroLamports: priorityFee,
        dynamicComputeUnitLimit: true,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error(`Jupiter swap error ${resp.status}:`, text);
      return null;
    }

    const data = await resp.json();
    const swapTransactionBuf = Buffer.from(data.swapTransaction, "base64");
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    return transaction;
  } catch (err) {
    console.error("Jupiter swap build error:", err);
    return null;
  }
}

// ==================== EXECUTE SWAP ====================

/**
 * Full swap flow: quote → build TX → sign → send → confirm
 */
export async function executeJupiterSwap(
  connection: Connection,
  userPublicKey: PublicKey,
  signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>,
  inputSymbol: string,
  outputSymbol: string,
  amountRaw: string,
  settings: SwapSettings,
): Promise<SwapResult> {
  const inputDecimals = TOKEN_DECIMALS[inputSymbol] || 9;
  const outputDecimals = TOKEN_DECIMALS[outputSymbol] || 9;
  const inputAmount = parseInt(amountRaw) / Math.pow(10, inputDecimals);

  // Safety check: master switch
  if (!settings.enableRealSwaps) {
    return {
      success: false,
      inputAmount,
      outputAmount: 0,
      inputSymbol,
      outputSymbol,
      priceImpact: 0,
      error: "Real swaps disabled. Enable in settings to trade with real funds.",
    };
  }

  // Step 1: Get quote
  const quote = await getJupiterQuote(inputSymbol, outputSymbol, amountRaw, settings.slippageBps);
  if (!quote) {
    return {
      success: false,
      inputAmount,
      outputAmount: 0,
      inputSymbol,
      outputSymbol,
      priceImpact: 0,
      error: "Failed to get Jupiter quote",
    };
  }

  // Step 2: Check price impact
  const priceImpact = parseFloat(quote.priceImpactPct);
  if (priceImpact > settings.maxPriceImpactPct) {
    return {
      success: false,
      inputAmount,
      outputAmount: parseInt(quote.outAmount) / Math.pow(10, outputDecimals),
      inputSymbol,
      outputSymbol,
      priceImpact,
      error: `Price impact too high: ${priceImpact.toFixed(2)}% > max ${settings.maxPriceImpactPct}%`,
    };
  }

  // Step 3: Build transaction
  const transaction = await buildSwapTransaction(quote, userPublicKey, settings.priorityFee);
  if (!transaction) {
    return {
      success: false,
      inputAmount,
      outputAmount: parseInt(quote.outAmount) / Math.pow(10, outputDecimals),
      inputSymbol,
      outputSymbol,
      priceImpact,
      error: "Failed to build swap transaction",
    };
  }

  try {
    // Step 4: Get latest blockhash
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    transaction.message.recentBlockhash = blockhash;

    // Step 5: Sign transaction (triggers wallet popup)
    const signed = await signTransaction(transaction);

    // Step 6: Send and confirm
    const rawTransaction = signed.serialize();
    const signature = await connection.sendRawTransaction(rawTransaction, {
      skipPreflight: true,
      maxRetries: 3,
    });

    // Step 7: Confirm transaction
    const confirmation = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      "confirmed",
    );

    if (confirmation.value.err) {
      return {
        success: false,
        signature,
        inputAmount,
        outputAmount: parseInt(quote.outAmount) / Math.pow(10, outputDecimals),
        inputSymbol,
        outputSymbol,
        priceImpact,
        error: `Transaction failed: ${JSON.stringify(confirmation.value.err)}`,
      };
    }

    return {
      success: true,
      signature,
      inputAmount,
      outputAmount: parseInt(quote.outAmount) / Math.pow(10, outputDecimals),
      inputSymbol,
      outputSymbol,
      priceImpact,
    };
  } catch (err: any) {
    return {
      success: false,
      inputAmount,
      outputAmount: parseInt(quote.outAmount) / Math.pow(10, outputDecimals),
      inputSymbol,
      outputSymbol,
      priceImpact,
      error: err.message || String(err),
    };
  }
}

// ==================== HELPERS ====================

/**
 * Convert USD amount to raw token units for a BUY
 * For buying: we swap SOL → target token
 * amountUSD is how much USD worth of SOL we want to spend
 */
export function usdToSolLamports(amountUSD: number, solPriceUSD: number): string {
  if (solPriceUSD <= 0) return "0";
  const solAmount = amountUSD / solPriceUSD;
  return Math.floor(solAmount * LAMPORTS_PER_SOL).toString();
}

/**
 * Convert token amount to raw units
 */
export function tokenToRaw(amount: number, symbol: string): string {
  const decimals = TOKEN_DECIMALS[symbol] || 9;
  return Math.floor(amount * Math.pow(10, decimals)).toString();
}

/**
 * Convert raw units to human-readable amount
 */
export function rawToToken(rawAmount: string, symbol: string): number {
  const decimals = TOKEN_DECIMALS[symbol] || 9;
  return parseInt(rawAmount) / Math.pow(10, decimals);
}

/**
 * Get a simulated quote (for when real swaps are disabled)
 * Uses CoinGecko prices to estimate output
 */
export function getSimulatedQuote(
  inputSymbol: string,
  outputSymbol: string,
  inputAmountUSD: number,
  inputPriceUSD: number,
  outputPriceUSD: number,
): SwapResult {
  if (outputPriceUSD <= 0) {
    return {
      success: false,
      inputAmount: inputAmountUSD / inputPriceUSD,
      outputAmount: 0,
      inputSymbol,
      outputSymbol,
      priceImpact: 0,
      error: "Invalid output price",
    };
  }

  const inputAmount = inputAmountUSD / inputPriceUSD;
  const outputAmount = inputAmountUSD / outputPriceUSD;
  const simulatedSlippage = 0.003; // 0.3% simulated slippage
  const adjustedOutput = outputAmount * (1 - simulatedSlippage);

  return {
    success: true,
    signature: `sim_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    inputAmount,
    outputAmount: adjustedOutput,
    inputSymbol,
    outputSymbol,
    priceImpact: simulatedSlippage * 100,
  };
}

// ==================== HIGH-LEVEL TRADE FUNCTION ====================

/**
 * Execute an AI trade decision via Jupiter
 * 
 * BUY flow:  SOL → target token (e.g. SOL → BONK)
 * SELL flow: target token → SOL (e.g. BONK → SOL)
 * 
 * For simplicity, all trades go through SOL as the base currency.
 */
export async function executeAITrade(
  connection: Connection,
  userPublicKey: PublicKey,
  signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>,
  action: "BUY" | "SELL",
  coinId: string,        // coingecko ID
  amountUSD: number,     // USD value of the trade
  solPriceUSD: number,   // current SOL price in USD
  tokenPriceUSD: number, // current target token price in USD
  settings: SwapSettings,
): Promise<SwapResult> {
  const symbol = COINGECKO_TO_SYMBOL[coinId];
  if (!symbol) {
    return {
      success: false,
      inputAmount: 0,
      outputAmount: 0,
      inputSymbol: "?",
      outputSymbol: "?",
      priceImpact: 0,
      error: `Unknown coin: ${coinId}`,
    };
  }

  // Max trade size guard
  if (amountUSD > settings.maxTradeUSD) {
    return {
      success: false,
      inputAmount: 0,
      outputAmount: 0,
      inputSymbol: action === "BUY" ? "SOL" : symbol,
      outputSymbol: action === "BUY" ? symbol : "SOL",
      priceImpact: 0,
      error: `Trade size $${amountUSD.toFixed(2)} exceeds max $${settings.maxTradeUSD}`,
    };
  }

  // If buying SOL itself, no swap needed — it's already SOL
  if (symbol === "SOL" && action === "BUY") {
    return {
      success: true,
      inputAmount: amountUSD,
      outputAmount: amountUSD / solPriceUSD,
      inputSymbol: "USDC",
      outputSymbol: "SOL",
      priceImpact: 0,
      error: "SOL buy: no swap needed, already holding SOL",
    };
  }

  // Simulation mode
  if (!settings.enableRealSwaps) {
    if (action === "BUY") {
      return getSimulatedQuote("SOL", symbol, amountUSD, solPriceUSD, tokenPriceUSD);
    } else {
      return getSimulatedQuote(symbol, "SOL", amountUSD, tokenPriceUSD, solPriceUSD);
    }
  }

  // Real swap via Jupiter
  if (action === "BUY") {
    // SOL → Token
    const solLamports = usdToSolLamports(amountUSD, solPriceUSD);
    return executeJupiterSwap(
      connection, userPublicKey, signTransaction,
      "SOL", symbol, solLamports, settings,
    );
  } else {
    // Token → SOL
    const tokenAmount = amountUSD / tokenPriceUSD;
    const rawAmount = tokenToRaw(tokenAmount, symbol);
    return executeJupiterSwap(
      connection, userPublicKey, signTransaction,
      symbol, "SOL", rawAmount, settings,
    );
  }
}

// ==================== TOKEN BALANCE FETCHING ====================

/**
 * Fetch all SPL token balances for the connected wallet
 */
export async function fetchTokenBalances(
  connection: Connection,
  owner: PublicKey,
): Promise<Record<string, number>> {
  const balances: Record<string, number> = {};

  try {
    // SOL balance
    const solBalance = await connection.getBalance(owner);
    balances["SOL"] = solBalance / LAMPORTS_PER_SOL;

    // SPL token balances
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(owner, {
      programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    });

    // Map mint → symbol
    const mintToSymbol: Record<string, string> = {};
    for (const [sym, mint] of Object.entries(TOKEN_MINTS)) {
      mintToSymbol[mint] = sym;
    }

    for (const account of tokenAccounts.value) {
      const parsed = account.account.data.parsed;
      const mint = parsed.info.mint;
      const amount = parsed.info.tokenAmount.uiAmount;
      const symbol = mintToSymbol[mint];
      if (symbol && amount > 0) {
        balances[symbol] = amount;
      }
    }
  } catch (err) {
    console.error("fetchTokenBalances error:", err);
  }

  return balances;
}

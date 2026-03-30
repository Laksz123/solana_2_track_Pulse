# AI Asset Manager — Autonomous AI Trading Agent on Solana

> **Hackathon: AI + Blockchain — Autonomous Smart Contracts (Case 2)**

An autonomous AI agent that analyzes real cryptocurrency markets using 9 technical indicators, makes trading decisions, and records every action on Solana blockchain for full transparency.

---

## Problem Statement

1. **Humans trade emotionally** — panic selling, FOMO buying, missing opportunities 24/7
2. **Smart contracts are static** — they don't adapt to market conditions
3. **AI is a black box** — no way to verify why an AI made a specific decision
4. **No autonomous asset management** — existing tools require constant manual intervention

## Our Solution

AI Asset Manager combines:
- **AI** that analyzes real market data and makes autonomous trading decisions
- **Solana blockchain** that records every AI decision on-chain for transparency
- **User control** through strategy selection and deposit/withdraw at any time

**The key innovation:** every BUY/SELL decision made by the AI triggers an on-chain transaction. The AI's reasoning is SHA-256 hashed and stored in a separate PDA, creating an **immutable audit trail** of AI behavior.

---

## Architecture

```
┌──────────────┐     ┌───────────────────┐     ┌──────────────────┐
│  CoinGecko   │────▶│   AI Engine        │────▶│  Solana Devnet   │
│  Real Prices │     │  9 TA Indicators   │     │  Smart Contract  │
│  OHLCV Data  │     │  Weighted Scoring  │     │                  │
└──────────────┘     │  Risk Management   │     │  execute_trade() │
                     │  Kelly Criterion   │     │  log_ai_decision()│
                     └───────┬───────────┘     │  Agent PDA       │
                             │                  └────────┬─────────┘
                     ┌───────▼───────────┐              │
                     │   Next.js UI      │◀─────────────┘
                     │   Phantom Wallet  │   reads on-chain state
                     │   Charts + Logs   │
                     └───────────────────┘
```

### Flow: AI → Decision → On-Chain

```
1. Fetch real BTC/ETH/SOL/BONK/JUP/RAY prices (CoinGecko API)
2. Calculate 9 technical indicators per asset
3. AI scores each asset → BUY / SELL / HOLD + confidence %
4. If BUY/SELL: execute_trade() → Solana transaction → Agent PDA updated
5. log_ai_decision() → SHA-256(reasoning) stored on-chain
6. UI shows trade + Solana Explorer link
```

---

## AI Engine — Technical Analysis

The AI uses **9 professional trading indicators** simultaneously:

| Indicator | Purpose |
|-----------|---------|
| **RSI** | Overbought/oversold detection (< 30 = buy, > 70 = sell) |
| **MACD** | Trend direction and momentum crossovers |
| **Bollinger Bands** | Volatility and price extremes |
| **Stochastic** | Price momentum oscillator |
| **ADX** | Trend strength measurement |
| **OBV** | Volume-based trend confirmation |
| **ATR** | Volatility for position sizing |
| **Support/Resistance** | Key price levels |
| **Candlestick Patterns** | Hammer, doji, engulfing patterns |

### Decision Logic

All signals are weighted and combined into a single score:
- **Score > threshold** → BUY (with position size from modified Kelly Criterion)
- **Score < -threshold** → SELL (with stop-loss / take-profit logic)
- **Near zero** → HOLD

Additional strategies:
- **Dip-buying**: buys when asset drops > 3% in 24h
- **Oversold buying**: buys when RSI < 35
- **Trailing stop**: protects profits on reversal
- **Cash reserve**: always keeps 10% in cash

### 3 Risk Profiles

| | Conservative | Moderate | Aggressive |
|---|---|---|---|
| Max position | 20% | 30% | 45% |
| Min confidence | 40% | 30% | 20% |
| Risk per trade | 3% | 6% | 12% |
| Stop-loss | 5% | 10% | 20% |

---

## Smart Contract (Solana / Anchor)

### Instructions

| Instruction | Description |
|---|---|
| `create_agent(strategy)` | Create Agent PDA for user |
| `deposit(amount)` | Transfer SOL into agent |
| `withdraw(amount)` | Transfer SOL back to user |
| `execute_trade(action, token_id, amount, price)` | Record AI trade on-chain |
| `update_strategy(strategy)` | Change risk profile on-chain |
| `log_ai_decision(action, token_id, amount, price, confidence, reasoning_hash)` | Store AI decision hash for auditability |

### On-Chain State

```rust
Agent {
    owner: Pubkey,
    balance: u64,
    strategy: u8,              // 0=conservative, 1=moderate, 2=aggressive
    positions: [TokenPosition; 5],
    history: [TradeRecord; 20],
}

AIDecisionLog {
    agent: Pubkey,
    owner: Pubkey,
    action: u8,                // 0=HOLD, 1=BUY, 2=SELL
    token_id: u8,
    amount: u64,
    price: u64,
    confidence: u8,            // 0-100%
    reasoning_hash: [u8; 32],  // SHA-256 of AI reasoning text
    timestamp: i64,
}
```

---

## Jupiter DEX Integration (NEW)

Real token swaps on Solana via **Jupiter V6 API** — the #1 DEX aggregator.

### How It Works

```
AI Decision (BUY BONK) → Jupiter Quote → Swap TX → Sign (Phantom) → On-Chain Swap
```

### Supported Tokens

| Token | Mint Address |
|-------|-------------|
| SOL | `So11111111111111111111111111111111111111112` |
| BTC (wBTC) | `3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh` |
| ETH (wETH) | `7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs` |
| BONK | `DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263` |
| JUP | `JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN` |
| RAY | `4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R` |

### Safety Features

- **Simulation mode by default** — no real funds at risk until you enable it
- **Confirmation dialog** — every real swap requires explicit user approval
- **Max trade size** — configurable cap per trade ($50–$500)
- **Price impact check** — rejects swaps with excessive slippage
- **Configurable slippage** — 0.25% / 0.5% / 1% / 2%

### Trade Flow

1. AI analyzes market → decides BUY/SELL
2. If wallet connected: Jupiter quote fetched
3. If real swaps enabled: confirmation dialog shown
4. Swap TX built, signed via Phantom, sent to Solana
5. Trade recorded on-chain via smart contract PDA
6. Token balances updated in real-time

---

## Quick Start

### Frontend

```bash
cd app
npm install
npm run dev
```

Open http://localhost:3000

### Smart Contract

```bash
# Requirements: Solana CLI, Anchor CLI, Rust
anchor build
solana config set --url devnet
solana airdrop 2
solana program deploy target/deploy/ai_asset_manager.so
```

---

## Demo Flow

1. **Connect Phantom Wallet** (devnet)
2. **Create AI Agent** — choose Conservative / Moderate / Aggressive
3. **Deposit funds**
4. **Run AI** — watch it analyze real market data
5. **AI makes decisions** — BUY/SELL with reasoning
6. **On-chain TX** — every trade recorded on Solana, viewable in Explorer
7. **Auto Mode** — AI runs every 15 seconds autonomously
8. **Switch strategy** — change risk profile in real-time

---

## Project Structure

```
ai-asset-manager/
├── programs/ai_asset_manager/
│   └── src/lib.rs                        # Solana smart contract (Anchor/Rust)
├── app/src/
│   ├── app/page.tsx                      # Main dashboard UI
│   ├── app/layout.tsx                    # Root layout with WalletProvider
│   ├── lib/
│   │   ├── ai-model.ts                  # AI decision model + risk management
│   │   ├── technical-analysis.ts         # 9 TA indicators engine
│   │   ├── market-data.ts               # CoinGecko real data fetcher
│   │   ├── solana-integration.ts         # On-chain TX helpers
│   │   ├── jupiter-swap.ts              # Jupiter DEX integration (real swaps)
│   │   └── i18n.ts                      # EN/RU translations
│   ├── components/
│   │   ├── PriceChart.tsx               # TradingView-style charts
│   │   └── WalletProvider.tsx           # Phantom wallet adapter
│   └── idl/ai_asset_manager.json        # Program IDL
├── Anchor.toml
└── README.md
```

---

## Tech Stack

- **Solana** + **Anchor** (Rust) — smart contract
- **Next.js 14** (App Router) — frontend
- **TailwindCSS** — styling
- **lightweight-charts** — TradingView-style charts
- **CoinGecko API** — real market data
- **Phantom Wallet Adapter** — Solana wallet
- **TypeScript** — type-safe AI engine
- **Lucide React** — icons

---

## Why This Wins

| Criteria | How We Score |
|---|---|
| **Product & Idea (20)** | Real problem: autonomous 24/7 trading without emotions |
| **Technical (25)** | Full-stack: Rust contract + TS AI engine + 9 indicators + real data |
| **Use of Solana (15)** | PDA state, on-chain trades, AI reasoning hashes, strategy governance |
| **Innovation (15)** | AI reasoning transparency via on-chain SHA-256 audit trail |
| **UX (10)** | Professional trading UI, bilingual, strategy switcher, charts |
| **Demo (10)** | Live demo with real prices, wallet connection, on-chain TXs |
| **Docs (5)** | This README + inline code docs |
# solana_2_track_Pulse

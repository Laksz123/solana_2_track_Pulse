import { Connection, PublicKey, SystemProgram, clusterApiUrl } from "@solana/web3.js";
import { Program, AnchorProvider, BN, web3 } from "@coral-xyz/anchor";
import IDL from "@/idl/ai_asset_manager.json";

// Program ID — will be updated after deployment
export const PROGRAM_ID = new PublicKey(
  IDL.metadata.address
);

export const SOLANA_NETWORK = "devnet";
export const SOLANA_RPC = clusterApiUrl("devnet");

// Token ID mapping for on-chain storage
export const TOKEN_IDS: Record<string, number> = {
  bitcoin: 0,
  ethereum: 1,
  solana: 2,
  bonk: 3,
  jupiter: 4,
  raydium: 5,
};

export const TOKEN_NAMES: Record<number, string> = {
  0: "BTC",
  1: "ETH",
  2: "SOL",
  3: "BONK",
  4: "JUP",
  5: "RAY",
};

// ==================== PDA DERIVATION ====================

export function getAgentPDA(owner: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), owner.toBuffer()],
    PROGRAM_ID
  );
}

export function getDecisionLogPDA(
  agentPDA: PublicKey,
  timestamp: number
): [PublicKey, number] {
  const tsBytes = Buffer.alloc(8);
  tsBytes.writeBigInt64LE(BigInt(timestamp));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("decision"), agentPDA.toBuffer(), tsBytes],
    PROGRAM_ID
  );
}

// ==================== SHA-256 HASH ====================

export async function sha256(text: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data.buffer as ArrayBuffer);
  return new Uint8Array(hashBuffer);
}

// ==================== PROGRAM HELPER ====================

export function getProgram(provider: AnchorProvider): Program {
  return new Program(IDL as any, PROGRAM_ID, provider);
}

export function getConnection(): Connection {
  return new Connection(SOLANA_RPC, "confirmed");
}

// ==================== ON-CHAIN ACTIONS ====================

export interface OnChainResult {
  success: boolean;
  signature?: string;
  error?: string;
}

/** Create agent PDA on-chain */
export async function createAgentOnChain(
  program: Program,
  owner: PublicKey,
  strategy: number
): Promise<OnChainResult> {
  try {
    const [agentPDA] = getAgentPDA(owner);
    const sig = await program.methods
      .createAgent(strategy)
      .accounts({
        agent: agentPDA,
        owner: owner,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    return { success: true, signature: sig };
  } catch (e: any) {
    // If agent already exists, that's fine
    if (e.message?.includes("already in use")) {
      return { success: true, signature: "already-exists" };
    }
    return { success: false, error: e.message || String(e) };
  }
}

/** Deposit SOL into agent PDA */
export async function depositOnChain(
  program: Program,
  owner: PublicKey,
  lamports: number
): Promise<OnChainResult> {
  try {
    const [agentPDA] = getAgentPDA(owner);
    const sig = await program.methods
      .deposit(new BN(lamports))
      .accounts({
        agent: agentPDA,
        owner: owner,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    return { success: true, signature: sig };
  } catch (e: any) {
    return { success: false, error: e.message || String(e) };
  }
}

/** Withdraw SOL from agent PDA */
export async function withdrawOnChain(
  program: Program,
  owner: PublicKey,
  lamports: number
): Promise<OnChainResult> {
  try {
    const [agentPDA] = getAgentPDA(owner);
    const sig = await program.methods
      .withdraw(new BN(lamports))
      .accounts({
        agent: agentPDA,
        owner: owner,
      })
      .rpc();
    return { success: true, signature: sig };
  } catch (e: any) {
    return { success: false, error: e.message || String(e) };
  }
}

/** Execute AI trade decision on-chain */
export async function executeTradeOnChain(
  program: Program,
  owner: PublicKey,
  action: number, // 0=HOLD, 1=BUY, 2=SELL
  tokenId: number,
  amountLamports: number,
  priceLamports: number
): Promise<OnChainResult> {
  try {
    const [agentPDA] = getAgentPDA(owner);
    const sig = await program.methods
      .executeTrade(action, tokenId, new BN(amountLamports), new BN(priceLamports))
      .accounts({
        agent: agentPDA,
        owner: owner,
      })
      .rpc();
    return { success: true, signature: sig };
  } catch (e: any) {
    return { success: false, error: e.message || String(e) };
  }
}

/** Update strategy on-chain */
export async function updateStrategyOnChain(
  program: Program,
  owner: PublicKey,
  strategy: number
): Promise<OnChainResult> {
  try {
    const [agentPDA] = getAgentPDA(owner);
    const sig = await program.methods
      .updateStrategy(strategy)
      .accounts({
        agent: agentPDA,
        owner: owner,
      })
      .rpc();
    return { success: true, signature: sig };
  } catch (e: any) {
    return { success: false, error: e.message || String(e) };
  }
}

/** Log AI decision on-chain for transparency */
export async function logAIDecisionOnChain(
  program: Program,
  owner: PublicKey,
  action: number,
  tokenId: number,
  amountLamports: number,
  priceLamports: number,
  confidence: number,
  reasoningText: string
): Promise<OnChainResult> {
  try {
    const [agentPDA] = getAgentPDA(owner);
    const reasoningHash = await sha256(reasoningText);
    const timestamp = Math.floor(Date.now() / 1000);
    const [decisionLogPDA] = getDecisionLogPDA(agentPDA, timestamp);

    const sig = await program.methods
      .logAiDecision(
        action,
        tokenId,
        new BN(amountLamports),
        new BN(priceLamports),
        confidence,
        Array.from(reasoningHash)
      )
      .accounts({
        decisionLog: decisionLogPDA,
        agent: agentPDA,
        owner: owner,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    return { success: true, signature: sig };
  } catch (e: any) {
    return { success: false, error: e.message || String(e) };
  }
}

// ==================== READ ON-CHAIN STATE ====================

export interface OnChainAgent {
  owner: PublicKey;
  balance: number; // lamports
  strategy: number;
  positionsCount: number;
  positions: Array<{
    tokenId: number;
    amount: number;
    avgPrice: number;
  }>;
  historyCount: number;
  history: Array<{
    action: number;
    tokenId: number;
    amount: number;
    price: number;
    timestamp: number;
  }>;
}

/** Fetch agent state from on-chain */
export async function fetchAgentOnChain(
  program: Program,
  owner: PublicKey
): Promise<OnChainAgent | null> {
  try {
    const [agentPDA] = getAgentPDA(owner);
    const account = await program.account.agent.fetch(agentPDA);
    return {
      owner: account.owner as PublicKey,
      balance: (account.balance as BN).toNumber(),
      strategy: account.strategy as number,
      positionsCount: account.positionsCount as number,
      positions: (account.positions as any[]).slice(0, account.positionsCount as number).map((p: any) => ({
        tokenId: p.tokenId,
        amount: (p.amount as BN).toNumber(),
        avgPrice: (p.avgPrice as BN).toNumber(),
      })),
      historyCount: account.historyCount as number,
      history: (account.history as any[]).slice(0, account.historyCount as number).map((h: any) => ({
        action: h.action,
        tokenId: h.tokenId,
        amount: (h.amount as BN).toNumber(),
        price: (h.price as BN).toNumber(),
        timestamp: (h.timestamp as BN).toNumber(),
      })),
    };
  } catch (e: any) {
    return null;
  }
}

/** Get Solana Explorer URL for a transaction */
export function getExplorerUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

/** Get Solana Explorer URL for an account */
export function getExplorerAccountUrl(address: string): string {
  return `https://explorer.solana.com/address/${address}?cluster=devnet`;
}

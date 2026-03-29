use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("DuRZJW1RmWrhZg41opM5kV3vnUzjCREgq1ySsTTAWWp3");

#[program]
pub mod ai_asset_manager {
    use super::*;

    /// Create a new AI agent account (PDA) for the user
    pub fn create_agent(ctx: Context<CreateAgent>, strategy: u8) -> Result<()> {
        let agent = &mut ctx.accounts.agent;
        agent.owner = ctx.accounts.owner.key();
        agent.balance = 0;
        agent.strategy = strategy;
        agent.positions_count = 0;
        agent.positions = [TokenPosition::default(); 5];
        agent.history_count = 0;
        agent.history = [TradeRecord::default(); 20];
        agent.bump = ctx.bumps.agent;

        msg!("Agent created for owner: {}", agent.owner);
        msg!("Strategy: {}", strategy);
        Ok(())
    }

    /// Deposit SOL into the agent
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, ErrorCode::InvalidAmount);

        // Transfer SOL from user to agent PDA
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.owner.to_account_info(),
                to: ctx.accounts.agent.to_account_info(),
            },
        );
        system_program::transfer(cpi_context, amount)?;

        let agent = &mut ctx.accounts.agent;
        agent.balance = agent.balance.checked_add(amount).unwrap();

        msg!("Deposited {} lamports. New balance: {}", amount, agent.balance);
        Ok(())
    }

    /// Withdraw SOL from the agent back to the owner
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        let agent = &mut ctx.accounts.agent;
        require!(amount > 0, ErrorCode::InvalidAmount);
        require!(agent.balance >= amount, ErrorCode::InsufficientBalance);

        // Transfer SOL from PDA back to owner
        **agent.to_account_info().try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.owner.to_account_info().try_borrow_mut_lamports()? += amount;

        agent.balance = agent.balance.checked_sub(amount).unwrap();

        msg!("Withdrew {} lamports. New balance: {}", amount, agent.balance);
        Ok(())
    }

    /// Update agent strategy on-chain
    pub fn update_strategy(ctx: Context<UpdateAgent>, strategy: u8) -> Result<()> {
        require!(strategy <= 2, ErrorCode::InvalidAction);
        let agent = &mut ctx.accounts.agent;
        agent.strategy = strategy;
        msg!("Strategy updated to: {}", strategy);
        Ok(())
    }

    /// Log an AI decision on-chain for transparency and auditability
    pub fn log_ai_decision(
        ctx: Context<LogDecision>,
        action: u8,
        token_id: u8,
        amount: u64,
        price: u64,
        confidence: u8,
        reasoning_hash: [u8; 32],
    ) -> Result<()> {
        let log = &mut ctx.accounts.decision_log;
        let clock = Clock::get()?;
        log.agent = ctx.accounts.agent.key();
        log.owner = ctx.accounts.owner.key();
        log.action = action;
        log.token_id = token_id;
        log.amount = amount;
        log.price = price;
        log.confidence = confidence;
        log.reasoning_hash = reasoning_hash;
        log.timestamp = clock.unix_timestamp;
        log.bump = ctx.bumps.decision_log;

        msg!("AI Decision logged on-chain: action={}, token={}, confidence={}%", action, token_id, confidence);
        Ok(())
    }

    /// Execute a trade decision made by the AI engine
    /// action: 0 = HOLD, 1 = BUY, 2 = SELL
    pub fn execute_trade(
        ctx: Context<ExecuteTrade>,
        action: u8,
        token_id: u8,
        amount: u64,
        price: u64,
    ) -> Result<()> {
        let agent = &mut ctx.accounts.agent;
        let clock = Clock::get()?;

        match action {
            // HOLD
            0 => {
                msg!("AI Decision: HOLD");
            }
            // BUY
            1 => {
                require!(agent.balance >= amount, ErrorCode::InsufficientBalance);
                agent.balance = agent.balance.checked_sub(amount).unwrap();

                // Find existing position or add new
                let mut found = false;
                for i in 0..agent.positions_count as usize {
                    if agent.positions[i].token_id == token_id {
                        agent.positions[i].amount = agent.positions[i]
                            .amount
                            .checked_add(amount)
                            .unwrap();
                        agent.positions[i].avg_price = price;
                        found = true;
                        break;
                    }
                }
                if !found {
                    let idx = agent.positions_count as usize;
                    require!(idx < 5, ErrorCode::MaxPositionsReached);
                    agent.positions[idx] = TokenPosition {
                        token_id,
                        amount,
                        avg_price: price,
                    };
                    agent.positions_count += 1;
                }

                msg!("AI Decision: BUY token {} amount {} at price {}", token_id, amount, price);
            }
            // SELL
            2 => {
                let mut found = false;
                for i in 0..agent.positions_count as usize {
                    if agent.positions[i].token_id == token_id {
                        require!(
                            agent.positions[i].amount >= amount,
                            ErrorCode::InsufficientPosition
                        );
                        agent.positions[i].amount = agent.positions[i]
                            .amount
                            .checked_sub(amount)
                            .unwrap();
                        agent.balance = agent.balance.checked_add(amount).unwrap();

                        // Remove position if empty
                        if agent.positions[i].amount == 0 {
                            for j in i..(agent.positions_count as usize - 1) {
                                agent.positions[j] = agent.positions[j + 1];
                            }
                            agent.positions_count -= 1;
                        }
                        found = true;
                        break;
                    }
                }
                require!(found, ErrorCode::PositionNotFound);

                msg!("AI Decision: SELL token {} amount {} at price {}", token_id, amount, price);
            }
            _ => {
                return Err(ErrorCode::InvalidAction.into());
            }
        }

        // Record trade in history
        let hc = agent.history_count as usize;
        if hc < 20 {
            agent.history[hc] = TradeRecord {
                action,
                token_id,
                amount,
                price,
                timestamp: clock.unix_timestamp,
            };
            agent.history_count += 1;
        } else {
            // Shift history and add new record
            for i in 0..19 {
                agent.history[i] = agent.history[i + 1];
            }
            agent.history[19] = TradeRecord {
                action,
                token_id,
                amount,
                price,
                timestamp: clock.unix_timestamp,
            };
        }

        Ok(())
    }
}

// ==================== ACCOUNTS ====================

#[derive(Accounts)]
pub struct CreateAgent<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + Agent::INIT_SPACE,
        seeds = [b"agent", owner.key().as_ref()],
        bump
    )]
    pub agent: Account<'info, Agent>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(
        mut,
        seeds = [b"agent", owner.key().as_ref()],
        bump = agent.bump,
        has_one = owner
    )]
    pub agent: Account<'info, Agent>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(
        mut,
        seeds = [b"agent", owner.key().as_ref()],
        bump = agent.bump,
        has_one = owner
    )]
    pub agent: Account<'info, Agent>,
    #[account(mut)]
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct ExecuteTrade<'info> {
    #[account(
        mut,
        seeds = [b"agent", owner.key().as_ref()],
        bump = agent.bump,
        has_one = owner
    )]
    pub agent: Account<'info, Agent>,
    #[account(mut)]
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct UpdateAgent<'info> {
    #[account(
        mut,
        seeds = [b"agent", owner.key().as_ref()],
        bump = agent.bump,
        has_one = owner
    )]
    pub agent: Account<'info, Agent>,
    #[account(mut)]
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct LogDecision<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + AIDecisionLog::INIT_SPACE,
        seeds = [b"decision", agent.key().as_ref(), &Clock::get().unwrap().unix_timestamp.to_le_bytes()],
        bump
    )]
    pub decision_log: Account<'info, AIDecisionLog>,
    #[account(
        seeds = [b"agent", owner.key().as_ref()],
        bump = agent.bump,
        has_one = owner
    )]
    pub agent: Account<'info, Agent>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

// ==================== STATE ====================

#[account]
#[derive(InitSpace)]
pub struct Agent {
    pub owner: Pubkey,       // 32
    pub balance: u64,        // 8
    pub strategy: u8,        // 1 (0=conservative, 1=moderate, 2=aggressive)
    pub positions_count: u8, // 1
    #[max_len(5)]
    pub positions: [TokenPosition; 5], // 5 * 17 = 85
    pub history_count: u8,   // 1
    #[max_len(20)]
    pub history: [TradeRecord; 20], // 20 * 26 = 520
    pub bump: u8,            // 1
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct TokenPosition {
    pub token_id: u8,   // 1
    pub amount: u64,     // 8
    pub avg_price: u64,  // 8
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct TradeRecord {
    pub action: u8,       // 1 (0=HOLD, 1=BUY, 2=SELL)
    pub token_id: u8,     // 1
    pub amount: u64,      // 8
    pub price: u64,       // 8
    pub timestamp: i64,   // 8
}

#[account]
#[derive(InitSpace)]
pub struct AIDecisionLog {
    pub agent: Pubkey,           // 32
    pub owner: Pubkey,           // 32
    pub action: u8,              // 1
    pub token_id: u8,            // 1
    pub amount: u64,             // 8
    pub price: u64,              // 8
    pub confidence: u8,          // 1
    pub reasoning_hash: [u8; 32], // 32 — SHA256 of AI reasoning text
    pub timestamp: i64,          // 8
    pub bump: u8,                // 1
}

// ==================== ERRORS ====================

#[error_code]
pub enum ErrorCode {
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Insufficient balance")]
    InsufficientBalance,
    #[msg("Insufficient position")]
    InsufficientPosition,
    #[msg("Position not found")]
    PositionNotFound,
    #[msg("Maximum positions reached")]
    MaxPositionsReached,
    #[msg("Invalid action")]
    InvalidAction,
}

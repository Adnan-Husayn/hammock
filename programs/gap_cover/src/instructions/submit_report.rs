use anchor_lang::prelude::*;

use crate::errors::GapError;
use crate::lazer::{lazer_verify, LazerAccounts};
use crate::math::rank_key;
use crate::pyth::{check_eligible, parse_report};
use crate::sigverify::require_ed25519_at_index0;
use crate::state::*;

#[derive(Accounts)]
pub struct SubmitReport<'info> {
    #[account(mut)]
    pub submitter: Signer<'info>,
    #[account(mut)]
    pub market: Account<'info, Market>,
    /// CHECK: key checked in lazer_verify.
    pub lazer_program: UncheckedAccount<'info>,
    /// CHECK: key, owner and treasury field checked in lazer_verify.
    pub lazer_storage: UncheckedAccount<'info>,
    /// CHECK: must match the storage account's treasury; checked in lazer_verify.
    #[account(mut)]
    pub lazer_treasury: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: address checked here and in lazer_verify.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct SubmitSandboxPrice<'info> {
    pub demo_authority: Signer<'info>,
    #[account(mut)]
    pub market: Account<'info, Market>,
}

fn required_state(leg: Leg) -> MarketState {
    match leg {
        Leg::Friday => MarketState::Created,
        Leg::Monday => MarketState::FridayFinal,
    }
}

pub fn submit_report(ctx: Context<SubmitReport>, leg: Leg, signed_message: Vec<u8>) -> Result<()> {
    let market = &ctx.accounts.market;
    require!(!market.sandbox, GapError::SandboxMarket);
    require!(market.state == required_state(leg), GapError::WrongState);

    let now_us = Clock::get()?
        .unix_timestamp
        .checked_mul(1_000_000)
        .ok_or(GapError::Overflow)?;
    let target = market.target_ts_us(leg);
    let close = target.checked_add(market.submission_window_us).ok_or(GapError::Overflow)?;
    require!(now_us >= target, GapError::WindowNotStarted);
    require!(now_us <= close, GapError::WindowClosed);

    let ix_sysvar = ctx.accounts.instructions_sysvar.to_account_info();
    let (_, envelope) = require_ed25519_at_index0(&ix_sysvar, None).map_err(|e| {
        msg!("Ed25519 layout: {}", e);
        error!(GapError::WrongInstructionLayout)
    })?;
    require!(envelope == signed_message, GapError::WrongInstructionLayout);

    lazer_verify(
        LazerAccounts {
            program: &ctx.accounts.lazer_program.to_account_info(),
            payer: &ctx.accounts.submitter.to_account_info(),
            storage: &ctx.accounts.lazer_storage.to_account_info(),
            treasury: &ctx.accounts.lazer_treasury.to_account_info(),
            system_program: &ctx.accounts.system_program.to_account_info(),
            instructions_sysvar: &ix_sysvar,
        },
        &signed_message,
    )?;

    let report = parse_report(&signed_message, market.feed_id)?;
    check_eligible(&report, market, leg)?;

    let submitter = ctx.accounts.submitter.key();
    let market = &mut ctx.accounts.market;
    let slot = market.candidate_mut(leg);
    let replace = match slot {
        None => true,
        Some(c) => rank_key(report.feed_update_ts_us, target) < rank_key(c.feed_ts_us, target),
    };
    if replace {
        *slot = Some(Candidate { price: report.price, feed_ts_us: report.feed_update_ts_us, submitter });
        msg!("Candidate set: price {} at {}", report.price, report.feed_update_ts_us);
    } else {
        msg!("Candidate kept: report does not rank strictly closer to the target");
    }
    Ok(())
}

pub fn submit_sandbox_price(ctx: Context<SubmitSandboxPrice>, leg: Leg, price: i64) -> Result<()> {
    let authority = ctx.accounts.demo_authority.key();
    let market = &mut ctx.accounts.market;
    require!(market.sandbox, GapError::NotSandbox);
    require_keys_eq!(authority, market.demo_authority, GapError::WrongAuthority);
    require!(price > 0, GapError::BadPrice);
    require!(market.state == required_state(leg), GapError::WrongState);
    let now_us = Clock::get()?
        .unix_timestamp
        .checked_mul(1_000_000)
        .ok_or(GapError::Overflow)?;
    let c = Candidate { price, feed_ts_us: now_us, submitter: authority };
    match leg {
        Leg::Friday => {
            market.friday = Some(c);
            market.state = MarketState::FridayFinal;
        }
        Leg::Monday => {
            require!(market.monday.is_none(), GapError::WrongState);
            market.monday = Some(c);
            market.buying_closed = true;
        }
    }
    Ok(())
}

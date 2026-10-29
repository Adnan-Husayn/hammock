use anchor_lang::prelude::*;

use crate::errors::GapError;
use crate::math::effective_multiplier_bits;
use crate::state::*;
use crate::token::{scaled_ui_config, transfer_checked};

#[derive(Accounts)]
pub struct FinaliseFriday<'info> {
    pub caller: Signer<'info>,
    #[account(mut)]
    pub market: Account<'info, Market>,
    /// CHECK: PDA that owns the reserves; address fixed by seeds.
    #[account(seeds = [b"vault", market.key().as_ref()], bump = market.vault_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    /// CHECK: key checked against the market.
    #[account(address = market.usdc_mint @ GapError::InvalidMint)]
    pub usdc_mint: UncheckedAccount<'info>,
    /// CHECK: key checked against the market; parsed for the ScaledUiAmount extension.
    #[account(address = market.nvdax_mint @ GapError::InvalidMint)]
    pub nvdax_mint: UncheckedAccount<'info>,
    /// CHECK: key checked against the market.
    #[account(mut, address = market.escrow @ GapError::InvalidMint)]
    pub escrow: UncheckedAccount<'info>,
    /// CHECK: key checked against the market.
    #[account(mut, address = market.collateral_reserve @ GapError::InvalidMint)]
    pub collateral_reserve: UncheckedAccount<'info>,
    /// CHECK: key checked against the market.
    #[account(mut, address = market.bounty_reserve @ GapError::InvalidMint)]
    pub bounty_reserve: UncheckedAccount<'info>,
    /// CHECK: owner, mint and token program checked in the handler.
    #[account(mut)]
    pub submitter_usdc: UncheckedAccount<'info>,
    /// CHECK: owner, mint and token program checked in the handler.
    #[account(mut)]
    pub dealer_usdc: UncheckedAccount<'info>,
    /// CHECK: key checked against the market.
    #[account(address = market.token_program @ GapError::InvalidMint)]
    pub token_program: UncheckedAccount<'info>,
}

/// Require a token account of the market's token program, on the USDC mint, held by `owner`.
fn require_usdc_account(acct: &AccountInfo, market: &Market, owner: &Pubkey) -> Result<()> {
    require_keys_eq!(*acct.owner, market.token_program, GapError::InvalidMint);
    let d = acct.try_borrow_data()?;
    require!(d.len() >= 165, GapError::InvalidMint);
    require!(d[0..32] == market.usdc_mint.to_bytes(), GapError::InvalidMint);
    require!(d[32..64] == owner.to_bytes(), GapError::InvalidMint);
    Ok(())
}

fn token_amount(acct: &AccountInfo) -> Result<u64> {
    let d = acct.try_borrow_data()?;
    require!(d.len() >= 72, GapError::InvalidMint);
    Ok(u64::from_le_bytes(d[64..72].try_into().unwrap()))
}

/// Spec section 8: true when the NVDAx multiplier makes the market void.
fn multiplier_voids(nvdax: &AccountInfo, market: &Market, now: i64) -> Result<bool> {
    let (mult, ts, new_mult) = scaled_ui_config(nvdax)?;
    if effective_multiplier_bits(mult, new_mult, ts, now) != market.creation_multiplier_bits {
        return Ok(true);
    }
    let monday_s = market.monday_target_ts_us / 1_000_000;
    let scheduled_in_range = ts > market.created_at && ts <= monday_s;
    Ok(scheduled_in_range && new_mult != market.creation_multiplier_bits)
}

pub fn finalise_friday(ctx: Context<FinaliseFriday>) -> Result<()> {
    let market = &ctx.accounts.market;
    require!(market.state == MarketState::Created, GapError::WrongState);
    require!(!market.sandbox, GapError::SandboxMarket);

    let now = Clock::get()?.unix_timestamp;
    let now_us = now.checked_mul(1_000_000).ok_or(GapError::Overflow)?;
    let close = market
        .friday_target_ts_us
        .checked_add(market.submission_window_us)
        .ok_or(GapError::Overflow)?;
    require!(now_us > close, GapError::WindowOpen);

    let void = market.friday.is_none() || multiplier_voids(&ctx.accounts.nvdax_mint.to_account_info(), market, now)?;

    let market_key = market.key();
    let bump = [market.vault_bump];
    let seeds: &[&[u8]] = &[b"vault", market_key.as_ref(), &bump];
    let tp = ctx.accounts.token_program.to_account_info();
    let mint = ctx.accounts.usdc_mint.to_account_info();
    let vault = ctx.accounts.vault_authority.to_account_info();
    let bounty_per_leg = market.bounty_per_leg;
    let dealer = market.dealer;
    let submitter = market.friday.map(|c| c.submitter);

    if void {
        require_usdc_account(&ctx.accounts.dealer_usdc, market, &dealer)?;
        for from in [&ctx.accounts.escrow, &ctx.accounts.collateral_reserve, &ctx.accounts.bounty_reserve] {
            let from = from.to_account_info();
            let amount = token_amount(&from)?;
            if amount > 0 {
                transfer_checked(&tp, &from, &mint, &ctx.accounts.dealer_usdc.to_account_info(), &vault, amount, &[seeds])?;
            }
        }
        ctx.accounts.market.state = MarketState::Voided;
        msg!("Friday mark voided; reserves returned to the dealer");
    } else {
        let submitter = submitter.ok_or(GapError::WrongState)?;
        require_usdc_account(&ctx.accounts.submitter_usdc, market, &submitter)?;
        transfer_checked(
            &tp,
            &ctx.accounts.bounty_reserve.to_account_info(),
            &mint,
            &ctx.accounts.submitter_usdc.to_account_info(),
            &vault,
            bounty_per_leg,
            &[seeds],
        )?;
        ctx.accounts.market.state = MarketState::FridayFinal;
        msg!("Friday mark final; bounty paid to the submitter");
    }
    Ok(())
}

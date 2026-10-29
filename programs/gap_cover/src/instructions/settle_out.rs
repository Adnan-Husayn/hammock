use anchor_lang::prelude::*;

use crate::errors::GapError;
use crate::instructions::finalise::require_usdc_account;
use crate::state::*;
use crate::token::transfer_checked;

#[derive(Accounts)]
pub struct Claim<'info> {
    pub owner: Signer<'info>,
    #[account(mut)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"position", market.key().as_ref(), owner.key().as_ref()], bump)]
    pub position: Account<'info, Position>,
    /// CHECK: PDA that owns the reserves; address fixed by seeds.
    #[account(seeds = [b"vault", market.key().as_ref()], bump = market.vault_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    /// CHECK: key checked against the market.
    #[account(address = market.usdc_mint @ GapError::InvalidMint)]
    pub usdc_mint: UncheckedAccount<'info>,
    /// CHECK: key checked against the market.
    #[account(mut, address = market.escrow @ GapError::InvalidMint)]
    pub escrow: UncheckedAccount<'info>,
    /// CHECK: owner, mint and token program checked in the handler.
    #[account(mut)]
    pub owner_usdc: UncheckedAccount<'info>,
    /// CHECK: key checked against the market.
    #[account(address = market.token_program @ GapError::InvalidMint)]
    pub token_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    pub owner: Signer<'info>,
    #[account(mut)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"position", market.key().as_ref(), owner.key().as_ref()], bump)]
    pub position: Account<'info, Position>,
    /// CHECK: PDA that owns the reserves; address fixed by seeds.
    #[account(seeds = [b"vault", market.key().as_ref()], bump = market.vault_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    /// CHECK: key checked against the market.
    #[account(address = market.usdc_mint @ GapError::InvalidMint)]
    pub usdc_mint: UncheckedAccount<'info>,
    /// CHECK: key checked against the market.
    #[account(mut, address = market.escrow @ GapError::InvalidMint)]
    pub escrow: UncheckedAccount<'info>,
    /// CHECK: owner, mint and token program checked in the handler.
    #[account(mut)]
    pub owner_usdc: UncheckedAccount<'info>,
    /// CHECK: key checked against the market.
    #[account(address = market.token_program @ GapError::InvalidMint)]
    pub token_program: UncheckedAccount<'info>,
}


/// Pay `amount` from escrow to the position owner's account and close the position.
macro_rules! pay_and_close {
    ($ctx:expr, $amount:expr) => {{
        let a = &mut $ctx.accounts;
        let amount: u64 = $amount;
        require_usdc_account(&a.owner_usdc, &a.market, &a.owner.key())?;
        if amount > 0 {
            let market_key = a.market.key();
            let bump = [a.market.vault_bump];
            let seeds: &[&[u8]] = &[b"vault", market_key.as_ref(), &bump];
            transfer_checked(
                &a.token_program.to_account_info(),
                &a.escrow.to_account_info(),
                &a.usdc_mint.to_account_info(),
                &a.owner_usdc.to_account_info(),
                &a.vault_authority.to_account_info(),
                amount,
                &[seeds],
            )?;
        }
        a.position.closed = true;
        a.market.open_positions = a.market.open_positions.checked_sub(1).ok_or(GapError::Overflow)?;
    }};
}

pub fn claim(mut ctx: Context<Claim>) -> Result<()> {
    let market = &ctx.accounts.market;
    require!(market.state == MarketState::MondayFinal, GapError::WrongState);
    require!(!ctx.accounts.position.closed, GapError::PositionClosed);
    let amount = (ctx.accounts.position.contracts as u64)
        .checked_mul(market.payout_per_contract)
        .ok_or(GapError::Overflow)?;
    // After a sweep the escrow is gone; only a zero payout can still close the position.
    require!(amount == 0 || !market.swept, GapError::AlreadySwept);
    pay_and_close!(ctx, amount);
    msg!("claimed {}", amount);
    Ok(())
}

pub fn refund(mut ctx: Context<Refund>) -> Result<()> {
    require!(ctx.accounts.market.state == MarketState::Voided, GapError::WrongState);
    require!(!ctx.accounts.position.closed, GapError::PositionClosed);
    let amount = ctx.accounts.position.premium_paid;
    pay_and_close!(ctx, amount);
    msg!("refunded {}", amount);
    Ok(())
}

#[derive(Accounts)]
pub struct Sweep<'info> {
    pub caller: Signer<'info>,
    #[account(mut)]
    pub market: Account<'info, Market>,
    /// CHECK: PDA that owns the reserves; address fixed by seeds.
    #[account(seeds = [b"vault", market.key().as_ref()], bump = market.vault_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    /// CHECK: key checked against the market.
    #[account(address = market.usdc_mint @ GapError::InvalidMint)]
    pub usdc_mint: UncheckedAccount<'info>,
    /// CHECK: key checked against the market.
    #[account(mut, address = market.escrow @ GapError::InvalidMint)]
    pub escrow: UncheckedAccount<'info>,
    /// CHECK: owner, mint and token program checked in the handler.
    #[account(mut)]
    pub dealer_usdc: UncheckedAccount<'info>,
    /// CHECK: key checked against the market.
    #[account(address = market.token_program @ GapError::InvalidMint)]
    pub token_program: UncheckedAccount<'info>,
}

pub fn sweep(ctx: Context<Sweep>) -> Result<()> {
    let market = &ctx.accounts.market;
    // Only MondayFinal: escrow in Voided holds refunds, which never expire.
    require!(market.state == MarketState::MondayFinal, GapError::WrongState);
    require!(!market.swept, GapError::AlreadySwept);
    // The settlement time is not stored; the deadline runs from the Monday target.
    let deadline = (market.monday_target_ts_us / 1_000_000)
        .checked_add(market.claim_deadline_s)
        .ok_or(GapError::Overflow)?;
    require!(Clock::get()?.unix_timestamp > deadline, GapError::TooEarly);
    require_usdc_account(&ctx.accounts.dealer_usdc, market, &market.dealer)?;

    let escrow = ctx.accounts.escrow.to_account_info();
    let amount = {
        let d = escrow.try_borrow_data()?;
        require!(d.len() >= 72, GapError::InvalidMint);
        u64::from_le_bytes(d[64..72].try_into().unwrap())
    };
    if amount > 0 {
        let market_key = market.key();
        let bump = [market.vault_bump];
        let seeds: &[&[u8]] = &[b"vault", market_key.as_ref(), &bump];
        transfer_checked(
            &ctx.accounts.token_program.to_account_info(),
            &escrow,
            &ctx.accounts.usdc_mint.to_account_info(),
            &ctx.accounts.dealer_usdc.to_account_info(),
            &ctx.accounts.vault_authority.to_account_info(),
            amount,
            &[seeds],
        )?;
    }
    ctx.accounts.market.swept = true;
    msg!("swept {} to the dealer", amount);
    Ok(())
}

#[derive(Accounts)]
pub struct CloseMarket<'info> {
    pub caller: Signer<'info>,
    #[account(mut, close = dealer)]
    pub market: Account<'info, Market>,
    /// CHECK: rent destination; must be the market's dealer.
    #[account(mut, address = market.dealer @ GapError::WrongAuthority)]
    pub dealer: UncheckedAccount<'info>,
}

pub fn close_market(ctx: Context<CloseMarket>) -> Result<()> {
    let m = &ctx.accounts.market;
    let voided_unsold = m.state == MarketState::Voided && m.contracts_sold == 0;
    // Before settlement the reserves are still needed, so only settled markets close on an empty book.
    let settled = matches!(m.state, MarketState::MondayFinal | MarketState::Voided);
    let drained = settled && m.open_positions == 0;
    require!(voided_unsold || drained || m.swept, GapError::CannotClose);
    Ok(())
}

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke, program::invoke_signed, system_instruction, system_program};

use crate::errors::GapError;
use crate::instructions::finalise::require_usdc_account;
use crate::quote::decode_quote;
use crate::sigverify::require_inline_ed25519_at_index0;
use crate::state::*;
use crate::token::transfer_checked;

#[derive(Accounts)]
pub struct Buy<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(mut)]
    pub market: Account<'info, Market>,
    /// CHECK: Position PDA; created on the buyer's first buy and checked in the handler.
    #[account(mut, seeds = [b"position", market.key().as_ref(), buyer.key().as_ref()], bump)]
    pub position: UncheckedAccount<'info>,
    /// CHECK: PDA that owns the reserves; address fixed by seeds.
    #[account(seeds = [b"vault", market.key().as_ref()], bump = market.vault_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    /// CHECK: key checked against the market.
    #[account(address = market.usdc_mint @ GapError::InvalidMint)]
    pub usdc_mint: UncheckedAccount<'info>,
    /// CHECK: key checked against the market.
    #[account(mut, address = market.escrow @ GapError::InvalidMint)]
    pub escrow: UncheckedAccount<'info>,
    /// CHECK: key checked against the market.
    #[account(mut, address = market.collateral_reserve @ GapError::InvalidMint)]
    pub collateral_reserve: UncheckedAccount<'info>,
    /// CHECK: owner, mint and token program checked in the handler.
    #[account(mut)]
    pub buyer_usdc: UncheckedAccount<'info>,
    /// CHECK: key checked against the market.
    #[account(address = market.token_program @ GapError::InvalidMint)]
    pub token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: address checked here.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

const POSITION_SPACE: usize = 8 + Position::INIT_SPACE;

/// Load the buyer's position, creating it on the first buy. Returns (position, is_new).
fn load_or_create_position(ctx: &Context<Buy>) -> Result<(Position, bool)> {
    let acct = ctx.accounts.position.to_account_info();
    if *acct.owner == crate::ID {
        let data = acct.try_borrow_data()?;
        return Ok((Position::try_deserialize(&mut &data[..])?, false));
    }
    require_keys_eq!(*acct.owner, system_program::ID, GapError::WrongState);
    let market_key = ctx.accounts.market.key();
    let buyer_key = ctx.accounts.buyer.key();
    let bump = [ctx.bumps.position];
    let seeds: &[&[u8]] = &[b"position", market_key.as_ref(), buyer_key.as_ref(), &bump];
    let buyer = ctx.accounts.buyer.to_account_info();
    let sys = ctx.accounts.system_program.to_account_info();
    // Allocate/assign rather than create_account so lamports sent to the address in advance cannot block it.
    let need = Rent::get()?.minimum_balance(POSITION_SPACE).saturating_sub(acct.lamports());
    if need > 0 {
        invoke(&system_instruction::transfer(buyer.key, acct.key, need), &[buyer.clone(), acct.clone(), sys.clone()])?;
    }
    invoke_signed(&system_instruction::allocate(acct.key, POSITION_SPACE as u64), &[acct.clone(), sys.clone()], &[seeds])?;
    invoke_signed(&system_instruction::assign(acct.key, &crate::ID), &[acct.clone(), sys], &[seeds])?;
    Ok((Position::default(), true))
}

pub fn buy(ctx: Context<Buy>) -> Result<()> {
    let market = &ctx.accounts.market;
    let msg = require_inline_ed25519_at_index0(&ctx.accounts.instructions_sysvar, market.dealer_quote_key)?;
    let q = decode_quote(&msg)?;

    require!(market.state == MarketState::FridayFinal, GapError::WrongState);
    let now = Clock::get()?.unix_timestamp;
    require!(!market.buying_closed && now < market.buying_close_ts, GapError::BuyingClosed);
    if market.sandbox {
        let friday_s = market.friday.ok_or(GapError::WrongState)?.feed_ts_us / 1_000_000;
        let cap = friday_s.checked_add(SANDBOX_BUYING_S).ok_or(GapError::Overflow)?;
        require!(now < cap, GapError::BuyingClosed);
    }

    require_keys_eq!(q.market, market.key(), GapError::BadQuote);
    require_keys_eq!(q.buyer, ctx.accounts.buyer.key(), GapError::WrongBuyer);
    require!(q.contracts > 0, GapError::BadQuote);
    require!(
        q.premium_per_contract > 0 && q.premium_per_contract < CONTRACT_UNIT,
        GapError::BadPremium
    );
    require!(now <= q.expiry, GapError::QuoteExpired);
    let latest = now.checked_add(market.quote_max_lifetime_s).ok_or(GapError::Overflow)?;
    require!(q.expiry <= latest, GapError::BadQuote);

    let sold = market.contracts_sold.checked_add(q.contracts).ok_or(GapError::OverCapacity)?;
    require!(sold <= market.max_contracts, GapError::OverCapacity);

    let total_premium = (q.contracts as u64).checked_mul(q.premium_per_contract).ok_or(GapError::Overflow)?;
    let notional = (q.contracts as u64).checked_mul(CONTRACT_UNIT).ok_or(GapError::Overflow)?;
    let from_reserve = notional.checked_sub(total_premium).ok_or(GapError::Overflow)?;
    require!(from_reserve > 0, GapError::BadPremium);
    let total_premiums = market.total_premiums.checked_add(total_premium).ok_or(GapError::Overflow)?;

    let (mut pos, is_new) = load_or_create_position(&ctx)?;
    let expected = pos.last_nonce.checked_add(1).ok_or(GapError::Overflow)?;
    require!(q.nonce >= expected, GapError::QuoteUsed);
    require!(q.nonce == expected, GapError::BadNonce);
    require!(!pos.closed, GapError::WrongState);

    let market = &ctx.accounts.market;
    require_usdc_account(&ctx.accounts.buyer_usdc, market, &ctx.accounts.buyer.key())?;
    let market_key = market.key();
    let vbump = [market.vault_bump];
    let vseeds: &[&[u8]] = &[b"vault", market_key.as_ref(), &vbump];
    let tp = ctx.accounts.token_program.to_account_info();
    let mint = ctx.accounts.usdc_mint.to_account_info();
    let escrow = ctx.accounts.escrow.to_account_info();
    transfer_checked(&tp, &ctx.accounts.buyer_usdc.to_account_info(), &mint, &escrow, &ctx.accounts.buyer.to_account_info(), total_premium, &[])?;
    transfer_checked(
        &tp,
        &ctx.accounts.collateral_reserve.to_account_info(),
        &mint,
        &escrow,
        &ctx.accounts.vault_authority.to_account_info(),
        from_reserve,
        &[vseeds],
    )?;

    pos.contracts = pos.contracts.checked_add(q.contracts).ok_or(GapError::Overflow)?;
    pos.premium_paid = pos.premium_paid.checked_add(total_premium).ok_or(GapError::Overflow)?;
    pos.last_nonce = q.nonce;
    {
        let acct = ctx.accounts.position.to_account_info();
        let mut data = acct.try_borrow_mut_data()?;
        let mut out: &mut [u8] = &mut data[..];
        pos.try_serialize(&mut out)?;
    }

    let m = &mut ctx.accounts.market;
    m.contracts_sold = sold;
    m.total_premiums = total_premiums;
    if is_new {
        m.open_positions = m.open_positions.checked_add(1).ok_or(GapError::Overflow)?;
    }
    msg!("sold {} contracts for {} premium", q.contracts, total_premium);
    Ok(())
}

use anchor_lang::prelude::*;

use crate::errors::GapError;
use crate::math::effective_multiplier_bits;
use crate::state::*;
use crate::token::{create_pda_token_account, is_token_program, mint_decimals, scaled_ui_config, transfer_checked};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct MarketParams {
    /// Unix seconds, UTC.
    pub friday_target_ts: i64,
    pub monday_target_ts: i64,
    pub buying_close_ts: i64,
    pub band_lower_bps: u16,
    pub band_upper_bps: u16,
    pub friday_conf_cap_bps: u16,
    pub monday_conf_cap_bps: u16,
    pub min_publishers: u16,
    pub max_contracts: u32,
    pub bounty_per_leg: u64,
    pub dealer_quote_key: Pubkey,
    pub sandbox: bool,
    pub demo_authority: Pubkey,
    pub sandbox_mode: SandboxMode,
}

#[derive(Accounts)]
#[instruction(params: MarketParams)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub dealer: Signer<'info>,
    #[account(
        init,
        payer = dealer,
        space = 8 + Market::INIT_SPACE,
        seeds = [b"market", dealer.key().as_ref(), &params.friday_target_ts.to_le_bytes()],
        bump
    )]
    pub market: Account<'info, Market>,
    /// CHECK: PDA that owns the three USDC accounts; holds no data.
    #[account(seeds = [b"vault", market.key().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    /// CHECK: owner must be the token program; decimals checked below.
    pub usdc_mint: UncheckedAccount<'info>,
    /// CHECK: Token-2022 mint with the ScaledUiAmount extension, parsed below.
    pub nvdax_mint: UncheckedAccount<'info>,
    /// CHECK: created here as a token account at this PDA.
    #[account(mut, seeds = [b"escrow", market.key().as_ref()], bump)]
    pub escrow: UncheckedAccount<'info>,
    /// CHECK: created here as a token account at this PDA.
    #[account(mut, seeds = [b"collateral", market.key().as_ref()], bump)]
    pub collateral_reserve: UncheckedAccount<'info>,
    /// CHECK: created here as a token account at this PDA.
    #[account(mut, seeds = [b"bounty", market.key().as_ref()], bump)]
    pub bounty_reserve: UncheckedAccount<'info>,
    /// CHECK: dealer's USDC account; the token program checks owner, mint and balance.
    #[account(mut)]
    pub dealer_usdc: UncheckedAccount<'info>,
    /// CHECK: SPL Token or Token-2022, and the USDC mint's owner.
    pub token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

fn validate(p: &MarketParams, now: i64) -> Result<()> {
    // Spec section 6 fixes the band and the bounty for every market.
    require!(
        p.band_lower_bps == BAND_LOWER_BPS && p.band_upper_bps == BAND_UPPER_BPS,
        GapError::InvalidParams
    );
    require!(p.bounty_per_leg == BOUNTY_PER_LEG, GapError::InvalidParams);
    require!(p.friday_target_ts < p.buying_close_ts, GapError::InvalidParams);
    require!(p.buying_close_ts <= p.monday_target_ts, GapError::InvalidParams);
    require!(p.friday_conf_cap_bps > 0 && p.monday_conf_cap_bps > 0, GapError::InvalidParams);
    require!(p.min_publishers > 0 && p.max_contracts > 0, GapError::InvalidParams);
    require!(p.dealer_quote_key != Pubkey::default(), GapError::InvalidParams);
    // Both targets must convert to microseconds without overflow.
    p.monday_target_ts.checked_mul(1_000_000).ok_or(GapError::InvalidParams)?;
    p.friday_target_ts.checked_mul(1_000_000).ok_or(GapError::InvalidParams)?;
    if p.sandbox {
        require!(p.demo_authority != Pubkey::default(), GapError::InvalidParams);
    } else {
        require!(p.demo_authority == Pubkey::default(), GapError::InvalidParams);
        let earliest = now.checked_add(MIN_CREATE_LEAD_S).ok_or(GapError::Overflow)?;
        require!(p.friday_target_ts >= earliest, GapError::CreatedTooLate);
    }
    Ok(())
}

pub fn create_market(ctx: Context<CreateMarket>, params: MarketParams) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    validate(&params, now)?;

    let tp = &ctx.accounts.token_program;
    require!(is_token_program(tp.key), GapError::InvalidMint);
    require_keys_eq!(*ctx.accounts.usdc_mint.owner, *tp.key, GapError::InvalidMint);
    require!(mint_decimals(&ctx.accounts.usdc_mint)? == 6, GapError::InvalidMint);
    let (mult, ts, new_mult) = scaled_ui_config(&ctx.accounts.nvdax_mint)?;

    let collateral = (params.max_contracts as u64)
        .checked_mul(CONTRACT_UNIT)
        .ok_or(GapError::Overflow)?;
    let bounty = params.bounty_per_leg.checked_mul(2).ok_or(GapError::Overflow)?;

    let market_key = ctx.accounts.market.key();
    let vault = ctx.accounts.vault_authority.key();
    let a = &ctx.accounts;
    for (acct, tag, bump) in [
        (&a.escrow, b"escrow".as_ref(), ctx.bumps.escrow),
        (&a.collateral_reserve, b"collateral".as_ref(), ctx.bumps.collateral_reserve),
        (&a.bounty_reserve, b"bounty".as_ref(), ctx.bumps.bounty_reserve),
    ] {
        create_pda_token_account(
            &a.dealer.to_account_info(),
            &acct.to_account_info(),
            &a.usdc_mint.to_account_info(),
            &vault,
            &tp.to_account_info(),
            &a.system_program.to_account_info(),
            &[tag, market_key.as_ref(), &[bump]],
        )?;
    }
    for (to, amount) in [(&a.collateral_reserve, collateral), (&a.bounty_reserve, bounty)] {
        transfer_checked(
            &tp.to_account_info(),
            &a.dealer_usdc.to_account_info(),
            &a.usdc_mint.to_account_info(),
            &to.to_account_info(),
            &a.dealer.to_account_info(),
            amount,
            &[],
        )?;
    }

    let m = &mut ctx.accounts.market;
    m.set_inner(Market {
        dealer: ctx.accounts.dealer.key(),
        bump: ctx.bumps.market,
        vault_bump: ctx.bumps.vault_authority,
        feed_id: FEED_ID,
        exponent: EXPONENT,
        nvdax_mint: ctx.accounts.nvdax_mint.key(),
        usdc_mint: ctx.accounts.usdc_mint.key(),
        token_program: tp.key(),
        escrow: ctx.accounts.escrow.key(),
        collateral_reserve: ctx.accounts.collateral_reserve.key(),
        bounty_reserve: ctx.accounts.bounty_reserve.key(),
        friday_target_ts_us: params.friday_target_ts.checked_mul(1_000_000).ok_or(GapError::Overflow)?,
        monday_target_ts_us: params.monday_target_ts.checked_mul(1_000_000).ok_or(GapError::Overflow)?,
        buying_close_ts: params.buying_close_ts,
        band_lower_bps: params.band_lower_bps,
        band_upper_bps: params.band_upper_bps,
        friday_conf_cap_bps: params.friday_conf_cap_bps,
        monday_conf_cap_bps: params.monday_conf_cap_bps,
        min_publishers: params.min_publishers,
        eligibility_half_window_us: ELIGIBILITY_HALF_WINDOW_US,
        submission_window_us: if params.sandbox { SANDBOX_SUBMISSION_WINDOW_US } else { SUBMISSION_WINDOW_US },
        max_contracts: params.max_contracts,
        bounty_per_leg: params.bounty_per_leg,
        claim_deadline_s: CLAIM_DEADLINE_S,
        dealer_quote_key: params.dealer_quote_key,
        quote_max_lifetime_s: QUOTE_MAX_LIFETIME_S,
        sandbox: params.sandbox,
        demo_authority: params.demo_authority,
        sandbox_mode: params.sandbox_mode,
        creation_multiplier_bits: effective_multiplier_bits(mult, new_mult, ts, now),
        created_at: now,
        ..Default::default()
    });
    Ok(())
}

use anchor_lang::prelude::*;


declare_id!("HzYCke4ESM4ripYknCuGu3Bk9XU3xRTmBoYkHaESMG9g");

pub mod errors;
pub mod instructions;
pub mod lazer;
pub mod math;
pub mod pyth;
pub mod sigverify;
pub mod state;
pub mod token;

use instructions::*;
use state::Leg;

#[program]
pub mod gap_cover {
    use super::*;

    pub fn ping(_ctx: Context<Ping>) -> Result<()> {
        msg!("gap_cover ping");
        Ok(())
    }

    pub fn create_market(ctx: Context<CreateMarket>, params: MarketParams) -> Result<()> {
        instructions::create_market::create_market(ctx, params)
    }

    pub fn submit_report(ctx: Context<SubmitReport>, leg: Leg, signed_message: Vec<u8>) -> Result<()> {
        instructions::submit_report::submit_report(ctx, leg, signed_message)
    }

    pub fn finalise_friday(ctx: Context<FinaliseFriday>) -> Result<()> {
        instructions::finalise::finalise_friday(ctx)
    }

    pub fn submit_sandbox_price(ctx: Context<SubmitSandboxPrice>, leg: Leg, price: i64) -> Result<()> {
        instructions::submit_report::submit_sandbox_price(ctx, leg, price)
    }
}

#[derive(Accounts)]
pub struct Ping {}

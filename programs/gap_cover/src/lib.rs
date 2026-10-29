use anchor_lang::prelude::*;


declare_id!("HzYCke4ESM4ripYknCuGu3Bk9XU3xRTmBoYkHaESMG9g");

pub mod errors;
pub mod instructions;
pub mod lazer;
pub mod math;
pub mod pyth;
pub mod quote;
pub mod sigverify;
pub mod state;
pub mod token;

use instructions::*;
use state::Leg;

#[program]
pub mod gap_cover {
    use super::*;

    pub fn create_market(ctx: Context<CreateMarket>, params: MarketParams) -> Result<()> {
        instructions::create_market::create_market(ctx, params)
    }

    pub fn submit_report(ctx: Context<SubmitReport>, leg: Leg, signed_message: Vec<u8>) -> Result<()> {
        instructions::submit_report::submit_report(ctx, leg, signed_message)
    }

    pub fn finalise_friday(ctx: Context<Finalise>) -> Result<()> {
        instructions::finalise::finalise_friday(ctx)
    }

    pub fn finalise_monday(ctx: Context<Finalise>) -> Result<()> {
        instructions::finalise::finalise_monday(ctx)
    }

    pub fn submit_sandbox_price(ctx: Context<SubmitSandboxPrice>, leg: Leg, price: i64) -> Result<()> {
        instructions::submit_report::submit_sandbox_price(ctx, leg, price)
    }

    pub fn buy(ctx: Context<Buy>) -> Result<()> {
        instructions::buy::buy(ctx)
    }

    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        instructions::settle_out::claim(ctx)
    }

    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        instructions::settle_out::refund(ctx)
    }

    pub fn sweep(ctx: Context<Sweep>) -> Result<()> {
        instructions::settle_out::sweep(ctx)
    }

    pub fn close_market(ctx: Context<CloseMarket>) -> Result<()> {
        instructions::settle_out::close_market(ctx)
    }
}

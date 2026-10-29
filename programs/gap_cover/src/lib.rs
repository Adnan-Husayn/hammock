use anchor_lang::prelude::*;

declare_id!("HzYCke4ESM4ripYknCuGu3Bk9XU3xRTmBoYkHaESMG9g");

#[program]
pub mod gap_cover {
    use super::*;

    pub fn ping(_ctx: Context<Ping>) -> Result<()> {
        msg!("gap_cover ping");
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Ping {}

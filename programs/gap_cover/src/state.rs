use anchor_lang::prelude::*;

/// Which mark a report is for.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Leg {
    Friday,
    Monday,
}

/// Fixed by spec section 6 for every market.
pub const FEED_ID: u32 = 1314;
pub const EXPONENT: i16 = -5;
pub const ELIGIBILITY_HALF_WINDOW_US: i64 = 5_000_000;
pub const SUBMISSION_WINDOW_US: i64 = 7 * 60 * 1_000_000;
pub const SANDBOX_SUBMISSION_WINDOW_US: i64 = 5_000_000;
pub const QUOTE_MAX_LIFETIME_S: i64 = 90;
pub const CLAIM_DEADLINE_S: i64 = 30 * 86_400;
pub const MIN_CREATE_LEAD_S: i64 = 3_600;
pub const BAND_LOWER_BPS: u16 = 100;
pub const BAND_UPPER_BPS: u16 = 500;
pub const BOUNTY_PER_LEG: u64 = 100_000;
pub const CONTRACT_UNIT: u64 = 1_000_000;
/// Sandbox buying stays available for at most this long after the Friday price (spec section 10).
pub const SANDBOX_BUYING_S: i64 = 600;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, Default, InitSpace)]
pub enum MarketState {
    #[default]
    Created,
    FridayFinal,
    MondayFinal,
    Voided,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, Default, InitSpace)]
pub enum SandboxMode {
    #[default]
    Gap,
    MultiplierVoid,
}

/// A report that currently holds a mark, and who submitted it.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub struct Candidate {
    pub price: i64,
    pub feed_ts_us: i64,
    pub submitter: Pubkey,
}

/// Market (spec sections 6, 9 and 10). Parameters never change after creation.
#[account]
#[derive(Debug, Default, InitSpace)]
pub struct Market {
    pub dealer: Pubkey,
    pub bump: u8,
    pub vault_bump: u8,
    pub feed_id: u32,
    pub exponent: i16,
    pub nvdax_mint: Pubkey,
    pub usdc_mint: Pubkey,
    pub token_program: Pubkey,
    pub escrow: Pubkey,
    pub collateral_reserve: Pubkey,
    pub bounty_reserve: Pubkey,
    pub friday_target_ts_us: i64,
    pub monday_target_ts_us: i64,
    pub buying_close_ts: i64,
    pub band_lower_bps: u16,
    pub band_upper_bps: u16,
    pub friday_conf_cap_bps: u16,
    pub monday_conf_cap_bps: u16,
    pub min_publishers: u16,
    pub eligibility_half_window_us: i64,
    pub submission_window_us: i64,
    pub max_contracts: u32,
    pub bounty_per_leg: u64,
    pub claim_deadline_s: i64,
    pub dealer_quote_key: Pubkey,
    pub quote_max_lifetime_s: i64,
    pub sandbox: bool,
    pub demo_authority: Pubkey,
    pub sandbox_mode: SandboxMode,
    /// f64 bits of the NVDAx effective scaled-UI multiplier at creation.
    pub creation_multiplier_bits: u64,
    pub created_at: i64,
    pub state: MarketState,
    pub friday: Option<Candidate>,
    pub monday: Option<Candidate>,
    pub contracts_sold: u32,
    pub total_premiums: u64,
    pub open_positions: u32,
    pub swept: bool,
    pub payout_per_contract: u64,
    pub buying_closed: bool,
    /// Unix seconds when the market entered MondayFinal; the claim deadline runs from here.
    pub settled_at: i64,
}

impl Market {
    pub fn target_ts_us(&self, leg: Leg) -> i64 {
        match leg {
            Leg::Friday => self.friday_target_ts_us,
            Leg::Monday => self.monday_target_ts_us,
        }
    }

    pub fn conf_cap_bps(&self, leg: Leg) -> u16 {
        match leg {
            Leg::Friday => self.friday_conf_cap_bps,
            Leg::Monday => self.monday_conf_cap_bps,
        }
    }

    pub fn candidate_mut(&mut self, leg: Leg) -> &mut Option<Candidate> {
        match leg {
            Leg::Friday => &mut self.friday,
            Leg::Monday => &mut self.monday,
        }
    }
}

/// Position PDA ["position", market, buyer] (spec section 10).
#[account]
#[derive(Debug, Default, InitSpace)]
pub struct Position {
    pub contracts: u32,
    pub premium_paid: u64,
    pub last_nonce: u64,
    pub closed: bool,
}

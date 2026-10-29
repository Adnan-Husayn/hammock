use anchor_lang::prelude::*;

/// Which mark a report is for.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Leg {
    Friday,
    Monday,
}

/// Market parameters (spec section 6). Task 4 adds state, candidates and money fields.
#[account]
#[derive(Debug, Default)]
pub struct Market {
    pub feed_id: u32,
    pub exponent: i16,
    pub friday_target_ts_us: i64,
    pub monday_target_ts_us: i64,
    pub eligibility_half_window_us: i64,
    pub friday_conf_cap_bps: u16,
    pub monday_conf_cap_bps: u16,
    pub min_publishers: u16,
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
}

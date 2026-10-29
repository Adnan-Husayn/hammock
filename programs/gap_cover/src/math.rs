use anchor_lang::prelude::*;

const SCALE: i128 = 1_000_000;

fn overflow() -> Error {
    ProgramError::ArithmeticOverflow.into()
}

/// Signed gap in bps: (friday - monday) * 10_000 / friday, truncating; negative on a rise.
pub fn gap_bps(friday: i64, monday: i64) -> Result<i128> {
    if friday <= 0 {
        return Err(overflow());
    }
    let diff = (friday as i128).checked_sub(monday as i128).ok_or_else(overflow)?;
    let num = diff.checked_mul(10_000).ok_or_else(overflow)?;
    num.checked_div(friday as i128).ok_or_else(overflow)
}

/// clamp((gap - lower) * 1_000_000 / (upper - lower), 0, 1_000_000), rounded down.
/// Any arithmetic failure or invalid band yields 0 (never more than escrow).
pub fn payout_per_contract(gap_bps: i128, lower_bps: u16, upper_bps: u16) -> u64 {
    let lower = lower_bps as i128;
    let width = upper_bps as i128 - lower;
    if width <= 0 || gap_bps <= lower {
        return 0;
    }
    if gap_bps >= upper_bps as i128 {
        return SCALE as u64;
    }
    match (gap_bps - lower).checked_mul(SCALE).and_then(|n| n.checked_div(width)) {
        Some(v) => v.clamp(0, SCALE) as u64,
        None => 0,
    }
}

/// confidence * 10_000 <= price * cap_bps, checked i128, no division.
pub fn conf_ok(confidence: u64, price: i64, cap_bps: u16) -> bool {
    if price <= 0 {
        return false;
    }
    let lhs = (confidence as i128).checked_mul(10_000);
    let rhs = (price as i128).checked_mul(cap_bps as i128);
    match (lhs, rhs) {
        (Some(l), Some(r)) => l <= r,
        _ => false,
    }
}

/// Rank key; lower wins, replacement needs strictly lower.
pub fn rank_key(feed_ts_us: i64, target_us: i64) -> (u64, i64) {
    let d = (feed_ts_us as i128 - target_us as i128).unsigned_abs();
    (d.min(u64::MAX as u128) as u64, feed_ts_us)
}

/// Effective multiplier bits at `at`: new if at >= effective_ts, else current. Raw bits only.
pub fn effective_multiplier_bits(
    multiplier_bits: u64,
    new_multiplier_bits: u64,
    effective_ts: i64,
    at: i64,
) -> u64 {
    if at >= effective_ts {
        new_multiplier_bits
    } else {
        multiplier_bits
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payout_band() {
        assert_eq!(payout_per_contract(gap_bps(10_000, 9_950).unwrap(), 100, 500), 0);
        assert_eq!(payout_per_contract(100, 100, 500), 0);
        assert_eq!(payout_per_contract(101, 100, 500), 2_500);
        assert_eq!(payout_per_contract(200, 100, 500), 250_000);
        assert_eq!(payout_per_contract(500, 100, 500), 1_000_000);
        assert_eq!(payout_per_contract(1_000, 100, 500), 1_000_000);
        assert_eq!(payout_per_contract(gap_bps(10_000, 10_300).unwrap(), 100, 500), 0);
    }

    #[test]
    fn payout_edges_and_errors() {
        assert_eq!(payout_per_contract(499, 100, 500), 997_500);
        assert_eq!(payout_per_contract(501, 100, 500), 1_000_000);
        assert_eq!(payout_per_contract(i128::MIN, 100, 500), 0);
        assert_eq!(payout_per_contract(i128::MAX, 100, 500), 1_000_000);
        assert_eq!(payout_per_contract(300, 500, 100), 0);
        assert!(gap_bps(0, 5).is_err());
        assert!(gap_bps(-1, 5).is_err());
        assert!(gap_bps(i64::MAX, i64::MIN).is_ok());
    }

    #[test]
    fn conf_cross_multiplied() {
        assert!(conf_ok(21_057, 21_430_043, 10));
        assert!(!conf_ok(21_457, 21_430_043, 10));
        assert!(conf_ok(21_430, 21_430_000, 10)); // exact boundary passes
        assert!(!conf_ok(1, 0, 10));
        assert!(!conf_ok(1, -5, 10));
        assert!(!conf_ok(u64::MAX, i64::MAX, 0));
    }

    #[test]
    fn rank_strict() {
        let t = 1_000_000_000;
        assert!(rank_key(t + 200_000, t) < rank_key(t - 300_000, t));
        assert!(rank_key(t - 200_000, t) < rank_key(t + 200_000, t));
        assert_eq!(rank_key(t + 5, t), rank_key(t + 5, t));
        assert!(!(rank_key(t + 5, t) < rank_key(t + 5, t)));
        assert!(rank_key(i64::MIN, i64::MAX) > rank_key(0, 0));
    }

    #[test]
    fn multiplier_effective() {
        let (a, b) = (1.0f64.to_bits(), 1.0025f64.to_bits());
        assert_eq!(effective_multiplier_bits(a, b, 100, 200), b);
        assert_eq!(effective_multiplier_bits(a, b, 200, 200), b);
        assert_eq!(effective_multiplier_bits(a, b, 300, 200), a);
    }
}

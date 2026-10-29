use anchor_lang::prelude::*;

use crate::math::conf_ok;
use crate::state::{Leg, Market};

/// Solana envelope magic (b9011a82 little-endian) and Lazer payload magic (75d3c793).
pub const SOLANA_FORMAT_MAGIC: u32 = 0x821a_01b9;
pub const PAYLOAD_MAGIC: u32 = 0x93c7_d375;
pub const ENVELOPE_HEADER_LEN: usize = 4 + 64 + 32 + 2;

const PROP_PRICE: u8 = 0;
const PROP_PUBLISHER_COUNT: u8 = 3;
const PROP_EXPONENT: u8 = 4;
const PROP_CONFIDENCE: u8 = 5;
const PROP_MARKET_SESSION: u8 = 9;
const PROP_FEED_UPDATE_TS: u8 = 12;

#[error_code]
pub enum PythError {
    #[msg("Malformed Pyth payload")]
    BadPayload,
    #[msg("Report is for a different feed")]
    WrongFeed,
    #[msg("Report is not from the regular session")]
    WrongSession,
    #[msg("Report carries a price forward from an earlier update")]
    CarriedForward,
    #[msg("Report is outside the eligibility window")]
    OutsideWindow,
    #[msg("Report price is not positive")]
    ZeroPrice,
    #[msg("Report exponent does not match the market")]
    WrongExponent,
    #[msg("Report confidence is too wide")]
    WideConfidence,
    #[msg("Report has too few publishers")]
    TooFewPublishers,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MarketSession {
    Regular,
    PreMarket,
    PostMarket,
    OverNight,
    Closed,
}

impl MarketSession {
    fn from_i16(v: i16) -> Result<Self> {
        Ok(match v {
            0 => Self::Regular,
            1 => Self::PreMarket,
            2 => Self::PostMarket,
            3 => Self::OverNight,
            4 => Self::Closed,
            _ => return err!(PythError::BadPayload),
        })
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct PriceReport {
    pub timestamp_us: i64,
    pub feed_id: u32,
    pub price: i64,
    pub exponent: i16,
    pub confidence: u64,
    pub publishers: u16,
    pub session: MarketSession,
    pub feed_update_ts_us: i64,
}

struct Cursor<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let end = self.pos.checked_add(n).ok_or(PythError::BadPayload)?;
        let s = self.data.get(self.pos..end).ok_or(PythError::BadPayload)?;
        self.pos = end;
        Ok(s)
    }
    fn u8(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<u16> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }
    fn i16(&mut self) -> Result<i16> {
        Ok(i16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }
    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn u64(&mut self) -> Result<u64> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
}

fn to_i64(v: u64) -> Result<i64> {
    i64::try_from(v).map_err(|_| error!(PythError::BadPayload))
}

/// Parse a Solana-format Lazer message and return the report for `feed_id`.
/// Every property in the requested set must appear exactly once; any other property fails.
pub fn parse_report(signed_message: &[u8], feed_id: u32) -> Result<PriceReport> {
    let mut c = Cursor { data: signed_message, pos: 0 };
    require!(c.u32()? == SOLANA_FORMAT_MAGIC, PythError::BadPayload);
    c.take(64 + 32)?;
    let len = c.u16()? as usize;
    require!(signed_message.len() == ENVELOPE_HEADER_LEN + len, PythError::BadPayload);

    require!(c.u32()? == PAYLOAD_MAGIC, PythError::BadPayload);
    let timestamp_us = to_i64(c.u64()?)?;
    let _channel = c.u8()?;
    let n_feeds = c.u8()?;
    let mut found: Option<PriceReport> = None;
    for _ in 0..n_feeds {
        let id = c.u32()?;
        let n_props = c.u8()?;
        let (mut price, mut exponent, mut confidence, mut publishers, mut session, mut fts) =
            (None, None, None, None, None, None);
        for _ in 0..n_props {
            match c.u8()? {
                PROP_PRICE => {
                    require!(price.is_none(), PythError::BadPayload);
                    price = Some(c.u64()? as i64);
                }
                PROP_PUBLISHER_COUNT => {
                    require!(publishers.is_none(), PythError::BadPayload);
                    publishers = Some(c.u16()?);
                }
                PROP_EXPONENT => {
                    require!(exponent.is_none(), PythError::BadPayload);
                    exponent = Some(c.i16()?);
                }
                PROP_CONFIDENCE => {
                    require!(confidence.is_none(), PythError::BadPayload);
                    confidence = Some(c.u64()?);
                }
                PROP_MARKET_SESSION => {
                    require!(session.is_none(), PythError::BadPayload);
                    session = Some(MarketSession::from_i16(c.i16()?)?);
                }
                PROP_FEED_UPDATE_TS => {
                    require!(fts.is_none(), PythError::BadPayload);
                    // Option<u64>: a None here means no update time, which is never eligible.
                    require!(c.u8()? == 1, PythError::BadPayload);
                    fts = Some(to_i64(c.u64()?)?);
                }
                _ => return err!(PythError::BadPayload),
            }
        }
        if id == feed_id {
            require!(found.is_none(), PythError::BadPayload);
            found = Some(PriceReport {
                timestamp_us,
                feed_id: id,
                price: price.ok_or(PythError::BadPayload)?,
                exponent: exponent.ok_or(PythError::BadPayload)?,
                confidence: confidence.ok_or(PythError::BadPayload)?,
                publishers: publishers.ok_or(PythError::BadPayload)?,
                session: session.ok_or(PythError::BadPayload)?,
                feed_update_ts_us: fts.ok_or(PythError::BadPayload)?,
            });
        }
    }
    require!(c.pos == signed_message.len(), PythError::BadPayload);
    found.ok_or_else(|| error!(PythError::WrongFeed))
}

/// Spec section 5 eligibility checks for one leg.
pub fn check_eligible(r: &PriceReport, market: &Market, leg: Leg) -> Result<()> {
    require!(r.feed_id == market.feed_id, PythError::WrongFeed);
    require!(r.session == MarketSession::Regular, PythError::WrongSession);
    require!(r.feed_update_ts_us == r.timestamp_us, PythError::CarriedForward);
    let t = market.target_ts_us(leg) as i128;
    let hw = market.eligibility_half_window_us as i128;
    let ts = r.feed_update_ts_us as i128;
    require!(ts >= t - hw && ts <= t + hw, PythError::OutsideWindow);
    require!(r.price > 0, PythError::ZeroPrice);
    require!(r.exponent == market.exponent, PythError::WrongExponent);
    require!(
        conf_ok(r.confidence, r.price, market.conf_cap_bps(leg)),
        PythError::WideConfidence
    );
    require!(r.publishers >= market.min_publishers, PythError::TooFewPublishers);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        let s = s.trim();
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }
    fn regular() -> Vec<u8> {
        hex(include_str!("../tests/data/regular.hex"))
    }
    fn premarket() -> Vec<u8> {
        hex(include_str!("../tests/data/premarket.hex"))
    }
    const TS: i64 = 1_793_280_669_400_000;

    fn market() -> Market {
        Market {
            feed_id: 1314,
            exponent: -5,
            friday_target_ts_us: TS,
            monday_target_ts_us: TS + 1_000_000,
            eligibility_half_window_us: 5_000_000,
            friday_conf_cap_bps: 10,
            monday_conf_cap_bps: 10,
            min_publishers: 5,
            ..Default::default()
        }
    }
    fn report() -> PriceReport {
        parse_report(&regular(), 1314).unwrap()
    }
    fn code(e: Error) -> u32 {
        match e {
            Error::AnchorError(a) => a.error_code_number,
            _ => panic!("not an anchor error"),
        }
    }
    fn expect(r: &PriceReport, m: &Market, leg: Leg, want: PythError) {
        assert_eq!(code(check_eligible(r, m, leg).unwrap_err()), u32::from(want));
    }

    #[test]
    fn parses_regular_fixture() {
        let r = report();
        assert_eq!(r.price, 21_430_043);
        assert_eq!(r.exponent, -5);
        assert_eq!(r.confidence, 21_057);
        assert_eq!(r.publishers, 20);
        assert_eq!(r.session, MarketSession::Regular);
        assert_eq!(r.feed_id, 1314);
        assert_eq!(r.timestamp_us, TS);
        assert_eq!(r.feed_update_ts_us, TS);
    }

    #[test]
    fn parses_premarket_fixture() {
        let r = parse_report(&premarket(), 1314).unwrap();
        assert_eq!(r.session, MarketSession::PreMarket);
        assert_eq!(r.price, 21_460_000);
        assert_eq!(r.publishers, 14);
        assert_eq!(r.confidence, 5_018);
    }

    #[test]
    fn parses_live_postmarket_capture() {
        let r = parse_report(&hex(include_str!("../tests/data/postmarket.hex")), 1314).unwrap();
        assert_eq!(r.session, MarketSession::PostMarket);
        assert_eq!(r.price, 21_043_004);
        assert_eq!(r.exponent, -5);
        assert_eq!(r.confidence, 3_496);
        assert_eq!(r.publishers, 14);
        assert_eq!(r.feed_update_ts_us, 1_793_307_911_600_000);
    }

    #[test]
    fn rejects_truncated_extended_and_missing_feed() {
        let m = regular();
        assert!(parse_report(&m[..m.len() - 1], 1314).is_err());
        let mut longer = m.clone();
        longer.push(0);
        assert!(parse_report(&longer, 1314).is_err());
        assert_eq!(code(parse_report(&m, 1315).unwrap_err()), u32::from(PythError::WrongFeed));
        let mut bad = m.clone();
        bad[0] ^= 1;
        assert!(parse_report(&bad, 1314).is_err());
    }

    #[test]
    fn regular_fixture_is_eligible_on_both_edges() {
        let mut m = market();
        check_eligible(&report(), &m, Leg::Friday).unwrap();
        m.monday_target_ts_us = TS + 5_000_000;
        check_eligible(&report(), &m, Leg::Monday).unwrap();
        m.monday_target_ts_us = TS - 5_000_000;
        check_eligible(&report(), &m, Leg::Monday).unwrap();
    }

    #[test]
    fn wrong_feed() {
        let mut r = report();
        r.feed_id = 1;
        expect(&r, &market(), Leg::Friday, PythError::WrongFeed);
    }
    #[test]
    fn wrong_session() {
        let r = parse_report(&premarket(), 1314).unwrap();
        let mut m = market();
        m.friday_target_ts_us = r.timestamp_us;
        expect(&r, &m, Leg::Friday, PythError::WrongSession);
    }
    #[test]
    fn carried_forward() {
        let mut r = report();
        r.feed_update_ts_us -= 1;
        expect(&r, &market(), Leg::Friday, PythError::CarriedForward);
    }
    #[test]
    fn outside_window() {
        let mut m = market();
        m.monday_target_ts_us = TS + 5_000_001;
        expect(&report(), &m, Leg::Monday, PythError::OutsideWindow);
        m.monday_target_ts_us = TS - 5_000_001;
        expect(&report(), &m, Leg::Monday, PythError::OutsideWindow);
    }
    #[test]
    fn zero_price() {
        let mut r = report();
        r.price = 0;
        expect(&r, &market(), Leg::Friday, PythError::ZeroPrice);
    }
    #[test]
    fn wrong_exponent() {
        let mut r = report();
        r.exponent = -6;
        expect(&r, &market(), Leg::Friday, PythError::WrongExponent);
    }
    #[test]
    fn wide_confidence() {
        // 21_057 * 10_000 > 21_430_043 * 9
        let mut m = market();
        m.monday_conf_cap_bps = 9;
        m.monday_target_ts_us = TS;
        expect(&report(), &m, Leg::Monday, PythError::WideConfidence);
    }
    #[test]
    fn too_few_publishers() {
        let mut m = market();
        m.min_publishers = 21;
        expect(&report(), &m, Leg::Friday, PythError::TooFewPublishers);
    }
}

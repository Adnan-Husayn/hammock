//! Dealer quote message (spec section 7), 96 bytes little-endian:
//! "MGCQ" | market | buyer | contracts u32 | premium_per_contract u64 | expiry i64 | nonce u64.
use anchor_lang::prelude::*;

use crate::errors::GapError;

pub const QUOTE_MAGIC: &[u8; 4] = b"MGCQ";
pub const QUOTE_LEN: usize = 96;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Quote {
    pub market: Pubkey,
    pub buyer: Pubkey,
    pub contracts: u32,
    pub premium_per_contract: u64,
    pub expiry: i64,
    pub nonce: u64,
}

pub fn decode_quote(msg: &[u8]) -> Result<Quote> {
    require!(msg.len() == QUOTE_LEN, GapError::BadQuote);
    require!(&msg[0..4] == QUOTE_MAGIC, GapError::BadQuote);
    let u64_at = |o: usize| u64::from_le_bytes(msg[o..o + 8].try_into().unwrap());
    Ok(Quote {
        market: Pubkey::new_from_array(msg[4..36].try_into().unwrap()),
        buyer: Pubkey::new_from_array(msg[36..68].try_into().unwrap()),
        contracts: u32::from_le_bytes(msg[68..72].try_into().unwrap()),
        premium_per_contract: u64_at(72),
        expiry: u64_at(80) as i64,
        nonce: u64_at(88),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Vec<u8> {
        let mut m = QUOTE_MAGIC.to_vec();
        m.extend([1u8; 32]);
        m.extend([2u8; 32]);
        m.extend(7u32.to_le_bytes());
        m.extend(120_000u64.to_le_bytes());
        m.extend((-5i64).to_le_bytes());
        m.extend(9u64.to_le_bytes());
        m
    }

    /// Shared with service/test/quote.test.ts: the TypeScript encoder must produce these exact bytes.
    #[test]
    fn decodes_shared_vector() {
        let s = include_str!("../tests/data/quote.hex").trim();
        let v: Vec<u8> = (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect();
        assert_eq!(v, sample());
        let q = decode_quote(&v).unwrap();
        assert_eq!((q.contracts, q.premium_per_contract, q.expiry, q.nonce), (7, 120_000, -5, 9));
    }

    #[test]
    fn decodes_fields() {
        let q = decode_quote(&sample()).unwrap();
        assert_eq!(q.market, Pubkey::new_from_array([1; 32]));
        assert_eq!(q.buyer, Pubkey::new_from_array([2; 32]));
        assert_eq!((q.contracts, q.premium_per_contract, q.expiry, q.nonce), (7, 120_000, -5, 9));
    }

    #[test]
    fn rejects_other_lengths_and_magic() {
        let m = sample();
        assert!(decode_quote(&m[..95]).is_err());
        let mut long = m.clone();
        long.push(0);
        assert!(decode_quote(&long).is_err());
        let mut bad = m;
        bad[0] = b'X';
        assert!(decode_quote(&bad).is_err());
    }
}

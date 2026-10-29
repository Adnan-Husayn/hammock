use anchor_lang::prelude::*;
use anchor_lang::solana_program::ed25519_program;
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked,
};

use crate::pyth::SOLANA_FORMAT_MAGIC;

/// Ed25519 instruction data: count u8, padding u8, then one 14-byte offsets header.
pub const ED25519_DATA_LEN: usize = 2 + 14;
/// The program instruction that carries the signed bytes sits at this index.
pub const PROGRAM_IX_INDEX: u16 = 1;

#[error_code]
pub enum SigError {
    #[msg("This instruction must be at transaction index 1")]
    WrongInstructionIndex,
    #[msg("Instruction 0 must be the Ed25519 program")]
    NotEd25519,
    #[msg("Ed25519 instruction must carry exactly one signature")]
    SignatureCount,
    #[msg("Ed25519 offsets do not point at the expected bytes")]
    BadOffsets,
    #[msg("Ed25519 signer is not the expected key")]
    WrongSigner,
}

struct Offsets {
    sig: u16,
    sig_ix: u16,
    pk: u16,
    pk_ix: u16,
    msg: u16,
    msg_len: u16,
    msg_ix: u16,
}

fn rd(d: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([d[at], d[at + 1]])
}

/// Pure layout check. `ed_data` is instruction 0's data and `target_data` is the data of the
/// instruction at `current_index`. The header must point into the current instruction at a
/// Solana-format envelope: magic, signature, public key, u16 length, payload. Returns the signer
/// and the whole envelope (the bytes Lazer and `parse_report` take).
pub fn check_ed25519_layout(
    current_index: u16,
    ed_program: &Pubkey,
    ed_data: &[u8],
    target_data: &[u8],
    expected_signer: Option<Pubkey>,
) -> Result<(Pubkey, Vec<u8>)> {
    require!(current_index == PROGRAM_IX_INDEX, SigError::WrongInstructionIndex);
    require_keys_eq!(*ed_program, ed25519_program::ID, SigError::NotEd25519);
    require!(!ed_data.is_empty() && ed_data[0] == 1, SigError::SignatureCount);
    require!(ed_data.len() == ED25519_DATA_LEN, SigError::BadOffsets);
    let o = Offsets {
        sig: rd(ed_data, 2),
        sig_ix: rd(ed_data, 4),
        pk: rd(ed_data, 6),
        pk_ix: rd(ed_data, 8),
        msg: rd(ed_data, 10),
        msg_len: rd(ed_data, 12),
        msg_ix: rd(ed_data, 14),
    };
    require!(
        o.sig_ix == current_index && o.pk_ix == current_index && o.msg_ix == current_index,
        SigError::BadOffsets
    );
    let start = (o.sig as usize).checked_sub(4).ok_or(SigError::BadOffsets)?;
    require!(o.pk as usize == o.sig as usize + 64, SigError::BadOffsets);
    require!(o.msg as usize == o.pk as usize + 32 + 2, SigError::BadOffsets);
    let end = o.msg as usize + o.msg_len as usize;
    let env = target_data.get(start..end).ok_or(SigError::BadOffsets)?;
    require!(
        u32::from_le_bytes(env[0..4].try_into().unwrap()) == SOLANA_FORMAT_MAGIC,
        SigError::BadOffsets
    );
    require!(rd(env, 100) == o.msg_len, SigError::BadOffsets);
    let signer = Pubkey::new_from_array(env[68..100].try_into().unwrap());
    if let Some(want) = expected_signer {
        require_keys_eq!(signer, want, SigError::WrongSigner);
    }
    Ok((signer, env.to_vec()))
}

/// Reads the instructions sysvar and applies `check_ed25519_layout`.
pub fn require_ed25519_at_index0(
    ix_sysvar: &AccountInfo,
    expected_signer: Option<Pubkey>,
) -> Result<(Pubkey, Vec<u8>)> {
    let current = load_current_index_checked(ix_sysvar)?;
    require!(current == PROGRAM_IX_INDEX, SigError::WrongInstructionIndex);
    let ed = load_instruction_at_checked(0, ix_sysvar)?;
    let me = load_instruction_at_checked(current as usize, ix_sysvar)?;
    check_ed25519_layout(current, &ed.program_id, &ed.data, &me.data, expected_signer)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        let s = s.trim();
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }
    fn envelope() -> Vec<u8> {
        hex(include_str!("../tests/data/regular.hex"))
    }
    const PREFIX: usize = 13; // e.g. 8-byte discriminator, 1-byte leg, 4-byte vec length

    fn target() -> Vec<u8> {
        let mut d = vec![7u8; PREFIX];
        d.extend(envelope());
        d.extend([0u8; 3]);
        d
    }
    /// Header as createEd25519Instruction(payload, 1, PREFIX) builds it.
    fn header(count: u8, ix: [u16; 3], sig_off: u16) -> Vec<u8> {
        let len = (envelope().len() - 102) as u16;
        let mut d = vec![count, 0];
        for v in [sig_off, ix[0], sig_off + 64, ix[1], sig_off + 98, len, ix[2]] {
            d.extend(v.to_le_bytes());
        }
        d
    }
    fn good() -> Vec<u8> {
        header(1, [1, 1, 1], PREFIX as u16 + 4)
    }
    fn run(cur: u16, ed: &[u8]) -> Result<(Pubkey, Vec<u8>)> {
        check_ed25519_layout(cur, &ed25519_program::ID, ed, &target(), None)
    }

    #[test]
    fn accepts_expected_layout() {
        let (signer, msg) = run(1, &good()).unwrap();
        assert_eq!(msg, envelope());
        assert_eq!(signer.to_bytes(), envelope()[68..100]);
        check_ed25519_layout(1, &ed25519_program::ID, &good(), &target(), Some(signer)).unwrap();
        assert!(check_ed25519_layout(1, &ed25519_program::ID, &good(), &target(), Some(Pubkey::default())).is_err());
    }
    #[test]
    fn rejects_message_in_other_instruction() {
        assert!(run(1, &header(1, [1, 1, 0], PREFIX as u16 + 4)).is_err());
        assert!(run(1, &header(1, [1, 1, 2], PREFIX as u16 + 4)).is_err());
        assert!(run(1, &header(1, [0, 1, 1], PREFIX as u16 + 4)).is_err());
        assert!(run(1, &header(1, [1, u16::MAX, 1], PREFIX as u16 + 4)).is_err());
    }
    #[test]
    fn rejects_two_signatures() {
        let mut two = header(2, [1, 1, 1], PREFIX as u16 + 4);
        two.extend(&good()[2..]);
        assert!(run(1, &two).is_err());
        let mut padded = good();
        padded[0] = 2;
        assert!(run(1, &padded).is_err());
    }
    #[test]
    fn rejects_shifted_offsets_wrong_index_and_program() {
        assert!(run(1, &header(1, [1, 1, 1], PREFIX as u16 + 5)).is_err());
        let mut d = good();
        d[12] ^= 1; // message length
        assert!(run(1, &d).is_err());
        let mut d = good();
        d[6] += 1; // public key offset
        assert!(run(1, &d).is_err());
        assert!(run(2, &header(1, [2, 2, 2], PREFIX as u16 + 4)).is_err());
        assert!(check_ed25519_layout(1, &Pubkey::default(), &good(), &target(), None).is_err());
    }
}

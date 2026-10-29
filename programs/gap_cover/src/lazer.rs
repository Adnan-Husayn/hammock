use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    hash::hash,
    instruction::{AccountMeta, Instruction},
    program::invoke,

};

pub const LAZER_PROGRAM_ID: Pubkey = anchor_lang::pubkey!("pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt");
pub const LAZER_STORAGE_ID: Pubkey = anchor_lang::pubkey!("3rdJbqfnagQ4yx9HXJViD4zc4xpiSqmFsKpPuSCQVyQL");
/// Storage layout: 8 discriminator, 32 top authority, 32 treasury, ...
const STORAGE_TREASURY_OFFSET: usize = 40;

#[error_code]
pub enum LazerError {
    #[msg("Wrong Lazer verifier account")]
    WrongLazerAccount,
}

pub struct LazerAccounts<'a, 'info> {
    pub program: &'a AccountInfo<'info>,
    pub payer: &'a AccountInfo<'info>,
    pub storage: &'a AccountInfo<'info>,
    pub treasury: &'a AccountInfo<'info>,
    pub system_program: &'a AccountInfo<'info>,
    pub instructions_sysvar: &'a AccountInfo<'info>,
}

pub fn verify_message_discriminator() -> [u8; 8] {
    hash(b"global:verify_message").to_bytes()[..8].try_into().unwrap()
}

/// Borsh `(Vec<u8>, u16 = 0, u8 = 0)` after the discriminator.
pub fn verify_message_data(signed_message: &[u8]) -> Vec<u8> {
    let mut d = Vec::with_capacity(8 + 4 + signed_message.len() + 3);
    d.extend(verify_message_discriminator());
    d.extend((signed_message.len() as u32).to_le_bytes());
    d.extend(signed_message);
    d.extend([0u8, 0, 0]);
    d
}

pub fn lazer_verify(a: LazerAccounts, signed_message: &[u8]) -> Result<()> {
    require_keys_eq!(*a.program.key, LAZER_PROGRAM_ID, LazerError::WrongLazerAccount);
    require_keys_eq!(*a.storage.key, LAZER_STORAGE_ID, LazerError::WrongLazerAccount);
    require_keys_eq!(*a.storage.owner, LAZER_PROGRAM_ID, LazerError::WrongLazerAccount);
    {
        let data = a.storage.try_borrow_data()?;
        let t = data
            .get(STORAGE_TREASURY_OFFSET..STORAGE_TREASURY_OFFSET + 32)
            .ok_or(LazerError::WrongLazerAccount)?;
        require!(t == a.treasury.key.as_ref(), LazerError::WrongLazerAccount);
    }
    require_keys_eq!(
        *a.instructions_sysvar.key,
        anchor_lang::solana_program::sysvar::instructions::ID,
        LazerError::WrongLazerAccount
    );
    require_keys_eq!(
        *a.system_program.key,
        anchor_lang::solana_program::system_program::ID,
        LazerError::WrongLazerAccount
    );
    let ix = Instruction {
        program_id: LAZER_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*a.payer.key, true),
            AccountMeta::new_readonly(*a.storage.key, false),
            AccountMeta::new(*a.treasury.key, false),
            AccountMeta::new_readonly(*a.system_program.key, false),
            AccountMeta::new_readonly(*a.instructions_sysvar.key, false),
        ],
        data: verify_message_data(signed_message),
    };
    invoke(
        &ix,
        &[
            a.payer.clone(),
            a.storage.clone(),
            a.treasury.clone(),
            a.system_program.clone(),
            a.instructions_sysvar.clone(),
            a.program.clone(),
        ],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verify_message_data_layout() {
        let d = verify_message_data(&[9, 9]);
        assert_eq!(&d[..8], &verify_message_discriminator());
        assert_eq!(&d[8..], &[2, 0, 0, 0, 9, 9, 0, 0, 0]);
        // Same 12-byte prefix the spike's createEd25519Instruction(msg, 1, 12) assumes.
        assert_eq!(d.len(), 12 + 2 + 3);
    }
}

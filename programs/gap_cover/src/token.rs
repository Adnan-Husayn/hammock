//! Raw SPL Token / Token-2022 CPIs (anchor-spl is not a dependency of this build).
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::{invoke, invoke_signed},
    system_instruction,
};

use crate::errors::GapError;

pub const SPL_TOKEN_ID: Pubkey = anchor_lang::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const TOKEN_2022_ID: Pubkey = anchor_lang::pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const TOKEN_ACCOUNT_LEN: usize = 165;
const MINT_BASE_LEN: usize = 82;
const MINT_DECIMALS_OFFSET: usize = 44;
const EXT_SCALED_UI_AMOUNT: u16 = 25;

pub fn is_token_program(id: &Pubkey) -> bool {
    *id == SPL_TOKEN_ID || *id == TOKEN_2022_ID
}

pub fn mint_decimals(mint: &AccountInfo) -> Result<u8> {
    let d = mint.try_borrow_data()?;
    require!(d.len() >= MINT_BASE_LEN && d[45] == 1, GapError::InvalidMint);
    Ok(d[MINT_DECIMALS_OFFSET])
}

/// (multiplier bits, new multiplier effective ts, new multiplier bits) from a Token-2022 mint.
pub fn scaled_ui_config(mint: &AccountInfo) -> Result<(u64, i64, u64)> {
    require_keys_eq!(*mint.owner, TOKEN_2022_ID, GapError::InvalidMint);
    let d = mint.try_borrow_data()?;
    require!(d.len() > TOKEN_ACCOUNT_LEN && d[TOKEN_ACCOUNT_LEN] == 1, GapError::InvalidMint);
    let mut at = TOKEN_ACCOUNT_LEN + 1;
    while at + 4 <= d.len() {
        let ty = u16::from_le_bytes([d[at], d[at + 1]]);
        let len = u16::from_le_bytes([d[at + 2], d[at + 3]]) as usize;
        let body = d.get(at + 4..at + 4 + len).ok_or(GapError::InvalidMint)?;
        if ty == EXT_SCALED_UI_AMOUNT {
            require!(len >= 56, GapError::InvalidMint);
            let u = |o: usize| u64::from_le_bytes(body[o..o + 8].try_into().unwrap());
            return Ok((u(32), u(40) as i64, u(48)));
        }
        if ty == 0 {
            break;
        }
        at += 4 + len;
    }
    err!(GapError::InvalidMint)
}

/// Create a token account at a PDA (`seeds`) owned by `owner`.
#[allow(clippy::too_many_arguments)]
pub fn create_pda_token_account<'info>(
    payer: &AccountInfo<'info>,
    account: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    owner: &Pubkey,
    token_program: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    seeds: &[&[u8]],
) -> Result<()> {
    let lamports = Rent::get()?.minimum_balance(TOKEN_ACCOUNT_LEN);
    invoke_signed(
        &system_instruction::create_account(
            payer.key,
            account.key,
            lamports,
            TOKEN_ACCOUNT_LEN as u64,
            token_program.key,
        ),
        &[payer.clone(), account.clone(), system_program.clone()],
        &[seeds],
    )?;
    let mut data = vec![18u8]; // InitializeAccount3
    data.extend(owner.as_ref());
    invoke(
        &Instruction {
            program_id: *token_program.key,
            accounts: vec![AccountMeta::new(*account.key, false), AccountMeta::new_readonly(*mint.key, false)],
            data,
        },
        &[account.clone(), mint.clone(), token_program.clone()],
    )?;
    Ok(())
}

/// TransferChecked; `signer_seeds` empty when the authority signed the transaction.
pub fn transfer_checked<'info>(
    token_program: &AccountInfo<'info>,
    from: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    amount: u64,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let mut data = vec![12u8];
    data.extend(amount.to_le_bytes());
    data.push(mint_decimals(mint)?);
    invoke_signed(
        &Instruction {
            program_id: *token_program.key,
            accounts: vec![
                AccountMeta::new(*from.key, false),
                AccountMeta::new_readonly(*mint.key, false),
                AccountMeta::new(*to.key, false),
                AccountMeta::new_readonly(*authority.key, true),
            ],
            data,
        },
        &[from.clone(), mint.clone(), to.clone(), authority.clone(), token_program.clone()],
        signer_seeds,
    )?;
    Ok(())
}

use anchor_lang::prelude::*;

#[error_code(offset = 6100)]
pub enum GapError {
    #[msg("Market parameters are not valid")]
    InvalidParams,
    #[msg("Real markets must be created at least one hour before the Friday target")]
    CreatedTooLate,
    #[msg("Market is not in the right state for this leg")]
    WrongState,
    #[msg("The submission window for this leg has not started")]
    WindowNotStarted,
    #[msg("The submission window for this leg has closed")]
    WindowClosed,
    #[msg("Transaction must carry the Ed25519 instruction at index 0 over this instruction's message")]
    WrongInstructionLayout,
    #[msg("Sandbox markets take prices from the demo authority only")]
    SandboxMarket,
    #[msg("Only sandbox markets take a price from the demo authority")]
    NotSandbox,
    #[msg("Signer is not the market's demo authority")]
    WrongAuthority,
    #[msg("Price must be positive")]
    BadPrice,
    #[msg("Mint or token account is not valid for this market")]
    InvalidMint,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("The submission window for this leg is still running")]
    WindowOpen,
}

use crate::{constants::STAKE_POOL_PROGRAM_ID, error::ErrorCode, state::*, ANCHOR_DISCRIMINATOR};
use anchor_lang::{
    prelude::*,
    solana_program::{
        instruction::Instruction,
        program::invoke_signed,
        stake,
        sysvar::{clock, stake_history},
    },
};

use anchor_spl::token::spl_token::ID as TOKEN_PROGRAM_ID;

#[derive(Accounts)]
#[event_cpi]
pub struct Deposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        init_if_needed,
        constraint = user_whitelist_account.status == WhitelistUserStatus::Whitelisted @ ErrorCode::UserNotWhitelisted,
        payer = user,
        space = ANCHOR_DISCRIMINATOR + UserStatus::INIT_SPACE,
        seeds = [b"user", user.key().as_ref()],
        bump
    )]
    pub user_whitelist_account: Account<'info, UserStatus>,

    #[account(
        mut,
        constraint = !access.is_paused @ ErrorCode::ContractPaused,
        seeds = [b"access"],
        bump,
    )]
    pub access: Box<Account<'info, Access>>,

    /// CHECK: the stake pool account
    #[account(mut)]
    pub stake_pool: AccountInfo<'info>,

    /// CHECK: the deposit authority PDA
    #[account(mut)]
    pub deposit_authority: AccountInfo<'info>,

    /// CHECK: the withdraw authority PDA
    #[account(mut)]
    pub withdraw_authority: AccountInfo<'info>,

    /// CHECK: the reserve account of the stake pool
    #[account(mut)]
    pub pool_reserve: AccountInfo<'info>,

    /// CHECK: User's pool token associated token account
    #[account(mut)]
    pub user_pool_token_account: AccountInfo<'info>,

    /// CHECK: Fee token account
    #[account(mut)]
    pub fee_token_account: AccountInfo<'info>,

    /// CHECK: Pool token mint
    #[account(mut)]
    pub pool_mint: AccountInfo<'info>,

    /// CHECK: Referral fee token account (can be same as fee). The referral fee is fixed at
    /// zero and never enabled (see README "Fees"), so no tokens are ever routed here.
    #[account(mut)]
    pub referral_fee_token_account: AccountInfo<'info>,

    /// CHECK: SPL Token program
    #[account(address = TOKEN_PROGRAM_ID)]
    pub token_program: AccountInfo<'info>,

    /// CHECK: Stake Pool program
    #[account(address = STAKE_POOL_PROGRAM_ID)]
    pub stake_pool_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

/// Processes the `Deposit` instruction
pub fn process_deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    let accounts = &ctx.accounts;

    // derive the deposit authority PDA from the staker program
    let (deposit_authority_pda, deposit_authority_bump) =
        Pubkey::find_program_address(&[b"deposit"], ctx.program_id);

    // Prepare the DepositSol instruction
    let instruction_data = {
        let mut data = vec![14]; // Instruction index for DepositSol
        data.extend_from_slice(&amount.to_le_bytes()); // Deposit amount as u64 (little-endian)
        data
    };

    let deposit_sol_ix = Instruction {
        program_id: STAKE_POOL_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(accounts.stake_pool.key(), false), // Stake pool
            AccountMeta::new_readonly(accounts.withdraw_authority.key(), false), // Withdraw authority PDA
            AccountMeta::new(accounts.pool_reserve.key(), false), // Reserve stake account of the stake pool
            AccountMeta::new(accounts.user.key(), true), // Account providing the lamports to be deposited into the pool
            AccountMeta::new(accounts.user_pool_token_account.key(), false), // User account to receive pool tokens
            AccountMeta::new(accounts.fee_token_account.key(), false), // Account to receive fee tokens
            AccountMeta::new(accounts.referral_fee_token_account.key(), false), //Account to receive a portion of fee as referral fees
            AccountMeta::new(accounts.pool_mint.key(), false), // Pool token mint account
            AccountMeta::new_readonly(accounts.system_program.key(), false), // System program
            AccountMeta::new_readonly(accounts.token_program.key(), false), // Token program
            AccountMeta::new_readonly(deposit_authority_pda, true), // (Optional) Stake pool sol deposit authority (Staker program id)
        ],
        data: instruction_data,
    };

    // Invoke the DepositSol instruction
    let seeds: &[&[u8]] = &[b"deposit", &[deposit_authority_bump]];

    invoke_signed(
        &deposit_sol_ix,
        &[
            accounts.stake_pool.to_account_info(),
            accounts.withdraw_authority.to_account_info(),
            accounts.pool_reserve.to_account_info(),
            accounts.user.to_account_info(),
            accounts.user_pool_token_account.to_account_info(),
            accounts.fee_token_account.to_account_info(),
            accounts.referral_fee_token_account.to_account_info(),
            accounts.pool_mint.to_account_info(),
            accounts.system_program.to_account_info(),
            accounts.token_program.to_account_info(),
            accounts.deposit_authority.to_account_info(),
        ],
        &[seeds],
    )?;

    emit_cpi! {
        Deposited {
            amount,
        }
    };

    Ok(())
}

#[derive(Accounts)]
#[event_cpi]
pub struct DepositToSpecificValidator<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        init_if_needed,
        constraint = user_whitelist_account.status == WhitelistUserStatus::Whitelisted @ ErrorCode::UserNotWhitelisted,
        payer = user,
        space = ANCHOR_DISCRIMINATOR + UserStatus::INIT_SPACE,
        seeds = [b"user", user.key().as_ref()],
        bump
    )]
    pub user_whitelist_account: Box<Account<'info, UserStatus>>,

    #[account(
        mut,
        constraint = !access.is_paused @ ErrorCode::ContractPaused,
        seeds = [b"access"],
        bump,
    )]
    pub access: Box<Account<'info, Access>>,

    /// CHECK: the staker authority PDA
    #[account(
        seeds = [b"staker"],
        bump
    )]
    pub staker_authority: AccountInfo<'info>,

    /// CHECK: the stake pool account
    #[account(mut)]
    pub stake_pool: AccountInfo<'info>,

    /// CHECK: the deposit authority PDA
    #[account(mut)]
    pub deposit_authority: AccountInfo<'info>,

    /// CHECK: the withdraw authority
    #[account(mut)]
    pub withdraw_authority: AccountInfo<'info>,

    /// CHECK: the reserve account of the stake pool
    #[account(mut)]
    pub pool_reserve: AccountInfo<'info>,

    /// CHECK: User's pool token associated token account
    #[account(mut)]
    pub user_pool_token_account: AccountInfo<'info>,

    /// CHECK: Fee token account
    #[account(mut)]
    pub fee_token_account: AccountInfo<'info>,

    /// CHECK: Pool token mint
    #[account(mut)]
    pub pool_mint: AccountInfo<'info>,

    /// CHECK: Referral fee token account (can be same as fee). The referral fee is fixed at
    /// zero and never enabled (see README "Fees"), so no tokens are ever routed here.
    #[account(mut)]
    pub referral_fee_token_account: AccountInfo<'info>,

    /// CHECK: SPL Token program
    #[account(address = TOKEN_PROGRAM_ID)]
    pub token_program: AccountInfo<'info>,

    /// CHECK: Validator list account
    #[account(mut)]
    pub validator_list: AccountInfo<'info>,

    /// CHECK: Validator ephemera stake account
    #[account(mut)]
    pub ephemeral_stake_account: AccountInfo<'info>,

    /// CHECK: Validator transient stake account
    #[account(mut)]
    pub transient_stake_account: AccountInfo<'info>,

    /// CHECK: Validator stake account
    #[account(mut)]
    pub validator_stake_account: AccountInfo<'info>,

    /// CHECK: The vote account of the validator
    #[account(mut)]
    pub validator_vote_account: AccountInfo<'info>,

    /// CHECK: Clock sysvar
    #[account(address = clock::ID)]
    pub clock_sysvar: AccountInfo<'info>,

    /// CHECK: Stake history sysvar
    #[account(address = stake_history::ID)]
    pub stake_history_sysvar: AccountInfo<'info>,

    /// CHECK: Stake config sysvar
    #[account(address = stake::config::ID)]
    pub stake_config_sysvar: AccountInfo<'info>,

    /// CHECK: Stake program
    #[account(address = stake::program::ID)]
    pub stake_program: AccountInfo<'info>,

    /// CHECK: Stake Pool program
    #[account(address = STAKE_POOL_PROGRAM_ID)]
    pub stake_pool_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

/// Processes the `DepositToSpecificValidator` instruction
///
/// Permissionless by design: any whitelisted user may deposit to a chosen validator. As a
/// consequence, a user adding transient stake can briefly delay the stake manager's
/// rebalancing (stake *decrease*) on that validator for an epoch. This is an accepted,
/// self-healing trade-off under the permissioned/whitelisted model, not a vulnerability —
/// no user funds are at risk, no other user's deposit/withdraw path is affected, the actor
/// bears a real recurring cost (SOL + stake-account rent) and can be removed via whitelist
/// revocation, and the condition clears as epoch maintenance proceeds. See the
/// "Stake Management Bot" notes in the README.
///
/// `ephemeral_stake_seed` is the caller-supplied SPL ephemeral stake seed; passing a fresh
/// (e.g. random) seed each call lets callers route around a poisoned pool-global ephemeral PDA
/// instead of being stuck on a single hardcoded address.
pub fn process_deposit_to_specific_validator(
    ctx: Context<DepositToSpecificValidator>,
    amount: u64,
    transient_stake_seed: u64,
    ephemeral_stake_seed: u64,
) -> Result<()> {
    let accounts = &ctx.accounts;

    // derive the deposit authority PDA from the staker program
    let (deposit_authority_pda, deposit_authority_bump) =
        Pubkey::find_program_address(&[b"deposit"], ctx.program_id);

    let rent = Rent::get()?.minimum_balance(stake::state::StakeStateV2::size_of());
    let total_amount = amount + rent;

    // Prepare the DepositSol instruction
    let instruction_data = {
        let mut data = vec![14]; // Instruction index for DepositSol
        data.extend_from_slice(&total_amount.to_le_bytes()); // Deposit amount as u64
        data
    };

    let deposit_sol_ix = Instruction {
        program_id: STAKE_POOL_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(accounts.stake_pool.key(), false), // Stake pool
            AccountMeta::new_readonly(accounts.withdraw_authority.key(), false), // Withdraw authority PDA
            AccountMeta::new(accounts.pool_reserve.key(), false), // Reserve stake account of the stake pool
            AccountMeta::new(accounts.user.key(), true), // Account providing the lamports to be deposited into the pool
            AccountMeta::new(accounts.user_pool_token_account.key(), false), // User account to receive pool tokens
            AccountMeta::new(accounts.fee_token_account.key(), false), // Account to receive fee tokens
            AccountMeta::new(accounts.referral_fee_token_account.key(), false), //Account to receive a portion of fee as referral fees
            AccountMeta::new(accounts.pool_mint.key(), false), // Pool token mint account
            AccountMeta::new_readonly(accounts.system_program.key(), false), // System program
            AccountMeta::new_readonly(accounts.token_program.key(), false), // Token program
            AccountMeta::new_readonly(deposit_authority_pda, true), // (Optional) Stake pool sol deposit authority (Staker program id)
        ],
        data: instruction_data,
    };

    // Invoke the DepositSol instruction
    let seeds: &[&[u8]] = &[b"deposit", &[deposit_authority_bump]];

    invoke_signed(
        &deposit_sol_ix,
        &[
            accounts.stake_pool.to_account_info(),
            accounts.withdraw_authority.to_account_info(),
            accounts.pool_reserve.to_account_info(),
            accounts.user.to_account_info(),
            accounts.user_pool_token_account.to_account_info(),
            accounts.fee_token_account.to_account_info(),
            accounts.referral_fee_token_account.to_account_info(),
            accounts.pool_mint.to_account_info(),
            accounts.system_program.to_account_info(),
            accounts.token_program.to_account_info(),
            accounts.deposit_authority.to_account_info(),
        ],
        &[seeds],
    )?;

    let instruction_data = {
        let mut data = vec![19]; // index for IncreaseAdditionalValidatorStake
        data.extend_from_slice(&amount.to_le_bytes());
        data.extend_from_slice(&transient_stake_seed.to_le_bytes());
        data.extend_from_slice(&ephemeral_stake_seed.to_le_bytes());
        data
    };
    let increase_validator_stake_ix = Instruction {
        program_id: STAKE_POOL_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new_readonly(accounts.stake_pool.key(), false),
            AccountMeta::new_readonly(accounts.staker_authority.key(), true),
            AccountMeta::new_readonly(accounts.withdraw_authority.key(), false),
            AccountMeta::new(accounts.validator_list.key(), false),
            AccountMeta::new(accounts.pool_reserve.key(), false),
            AccountMeta::new(accounts.ephemeral_stake_account.key(), false),
            AccountMeta::new(accounts.transient_stake_account.key(), false),
            AccountMeta::new_readonly(accounts.validator_stake_account.key(), false),
            AccountMeta::new_readonly(accounts.validator_vote_account.key(), false),
            AccountMeta::new_readonly(accounts.clock_sysvar.key(), false),
            AccountMeta::new_readonly(accounts.stake_history_sysvar.key(), false),
            AccountMeta::new_readonly(accounts.stake_config_sysvar.key(), false),
            AccountMeta::new_readonly(accounts.system_program.key(), false),
            AccountMeta::new_readonly(accounts.stake_program.key(), false),
        ],
        data: instruction_data,
    };

    // invoke the IncreaseAdditionalValidatorStake instruction
    let seeds: &[&[u8]] = &[b"staker", &[ctx.bumps.staker_authority]];
    invoke_signed(
        &increase_validator_stake_ix,
        &[
            accounts.stake_pool.clone(),
            accounts.staker_authority.clone(),
            accounts.withdraw_authority.clone(),
            accounts.validator_list.clone(),
            accounts.pool_reserve.clone(),
            accounts.ephemeral_stake_account.clone(),
            accounts.transient_stake_account.clone(),
            accounts.validator_stake_account.clone(),
            accounts.validator_vote_account.clone(),
            accounts.clock_sysvar.clone(),
            accounts.stake_history_sysvar.clone(),
            accounts.stake_config_sysvar.clone(),
            accounts.system_program.to_account_info(),
            accounts.stake_program.clone(),
        ],
        &[seeds],
    )?;

    emit_cpi! {
        DepositedToSpecificValidator {
            amount,
            validator: accounts.validator_vote_account.key(),
        }
    };
    Ok(())
}

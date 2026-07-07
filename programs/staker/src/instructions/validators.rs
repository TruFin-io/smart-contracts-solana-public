use crate::{
    constants::MINIMUM_ACTIVE_STAKE, constants::STAKE_POOL_PROGRAM_ID, error::ErrorCode, state::*,
};
use anchor_lang::{
    prelude::*,
    solana_program::{
        instruction::Instruction,
        program::{invoke, invoke_signed},
        stake, system_instruction,
        sysvar::{clock, rent, stake_history},
    },
};

#[derive(Accounts)]
#[event_cpi]
pub struct AddValidator<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = owner @ ErrorCode::NotAuthorized,
        seeds = [b"access"],
        bump
    )]
    pub access: Account<'info, Access>,

    /// CHECK: The stake pool account
    #[account(mut)]
    pub stake_pool: AccountInfo<'info>,

    /// CHECK: The Staker authority PDA
    #[account(
        seeds = [b"staker"],
        bump
    )]
    pub staker_authority: AccountInfo<'info>,

    /// CHECK: Reserve stake account of the pool
    #[account(mut)]
    pub reserve_stake: AccountInfo<'info>,

    /// CHECK:  Stake pool withdraw authority
    #[account()]
    pub withdraw_authority: AccountInfo<'info>,

    /// CHECK: Validator stake list account
    #[account(mut)]
    pub validator_list: AccountInfo<'info>,

    /// CHECK: The stake account to add to the pool
    #[account(mut)]
    pub validator_stake_account: AccountInfo<'info>,

    /// CHECK: The vote account of the validator
    #[account(mut)]
    pub validator_vote_account: AccountInfo<'info>,

    /// CHECK: Rent sysvar
    #[account(address = rent::ID)]
    pub rent_sysvar: AccountInfo<'info>,

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

pub fn process_add_validator(ctx: Context<AddValidator>, validator_seed: u32) -> Result<()> {
    let accounts = &ctx.accounts;

    // calculate the lamports needed to fund the new validator stake account
    let initial_stake_account_balance = {
        let rent = Rent::get()?.minimum_balance(stake::state::StakeStateV2::size_of());
        let stake_minimum_delegation = stake::tools::get_minimum_delegation()?;
        let effective_minimum = std::cmp::max(stake_minimum_delegation, MINIMUM_ACTIVE_STAKE);
        rent + effective_minimum
    };

    // transfer the required SOL to the reserve stake account
    invoke(
        &system_instruction::transfer(
            accounts.owner.key,
            accounts.reserve_stake.key,
            initial_stake_account_balance,
        ),
        &[
            accounts.owner.to_account_info(),
            accounts.reserve_stake.to_account_info(),
            accounts.system_program.to_account_info(),
        ],
    )?;

    let instruction_data = {
        let mut data = vec![1]; // index for AddValidatorToPool
        data.extend_from_slice(&validator_seed.to_le_bytes()); //
        data
    };

    let add_validator_ix = Instruction {
        program_id: STAKE_POOL_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(accounts.stake_pool.key(), false),
            AccountMeta::new_readonly(accounts.staker_authority.key(), true),
            AccountMeta::new(accounts.reserve_stake.key(), false),
            AccountMeta::new_readonly(accounts.withdraw_authority.key(), false),
            AccountMeta::new(accounts.validator_list.key(), false),
            AccountMeta::new(accounts.validator_stake_account.key(), false),
            AccountMeta::new_readonly(accounts.validator_vote_account.key(), false),
            AccountMeta::new_readonly(accounts.rent_sysvar.key(), false),
            AccountMeta::new_readonly(accounts.clock_sysvar.key(), false),
            AccountMeta::new_readonly(accounts.stake_history_sysvar.key(), false),
            AccountMeta::new_readonly(accounts.stake_config_sysvar.key(), false),
            AccountMeta::new_readonly(accounts.system_program.key(), false),
            AccountMeta::new_readonly(accounts.stake_program.key(), false),
        ],
        data: instruction_data,
    };

    // invoke the AddValidatorToPool instruction
    let seeds: &[&[u8]] = &[b"staker", &[ctx.bumps.staker_authority]];
    invoke_signed(
        &add_validator_ix,
        &[
            accounts.stake_pool.clone(),
            accounts.staker_authority.clone(),
            accounts.reserve_stake.clone(),
            accounts.withdraw_authority.clone(),
            accounts.validator_list.clone(),
            accounts.validator_stake_account.clone(),
            accounts.validator_vote_account.clone(),
            accounts.rent_sysvar.clone(),
            accounts.clock_sysvar.clone(),
            accounts.stake_history_sysvar.clone(),
            accounts.stake_config_sysvar.clone(),
            accounts.system_program.to_account_info(),
            accounts.stake_program.clone(),
        ],
        &[seeds], // Seeds for PDA
    )?;

    emit_cpi! {
        ValidatorAdded {
            validator: accounts.validator_vote_account.key(),
        }
    };

    Ok(())
}

#[derive(Accounts)]
#[event_cpi]
pub struct RemoveValidator<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        has_one = owner @ ErrorCode::NotAuthorized,
        seeds = [b"access"],
        bump
    )]
    pub access: Account<'info, Access>,

    /// CHECK: The stake pool account
    #[account(mut)]
    pub stake_pool: AccountInfo<'info>,

    /// CHECK: The PDA of the program as staker authority
    #[account(
        seeds = [b"staker"],
        bump
    )]
    pub staker_authority: AccountInfo<'info>,

    /// CHECK:  Stake pool withdraw authority
    #[account()]
    pub withdraw_authority: AccountInfo<'info>,

    /// CHECK: Validator stake list account
    #[account(mut)]
    pub validator_list: AccountInfo<'info>,

    /// CHECK: Stake account to remove from the pool
    #[account(mut)]
    pub validator_stake_account: AccountInfo<'info>,

    /// CHECK: Transient stake account, to deactivate if necessary
    #[account(mut)]
    pub transient_stake_account: AccountInfo<'info>,

    /// CHECK: Clock sysvar
    #[account(address = clock::ID)]
    pub clock_sysvar: AccountInfo<'info>,

    /// CHECK: Stake program
    #[account(address = stake::program::ID)]
    pub stake_program: AccountInfo<'info>,

    /// CHECK: Stake pool program
    #[account(address = STAKE_POOL_PROGRAM_ID)]
    pub stake_pool_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

/// Processes the `RemoveValidator` instruction
pub fn process_remove_validator(ctx: Context<RemoveValidator>) -> Result<()> {
    let accounts = &ctx.accounts;

    let remove_validator_ix = Instruction {
        program_id: STAKE_POOL_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(accounts.stake_pool.key(), false),
            AccountMeta::new_readonly(accounts.staker_authority.key(), true),
            AccountMeta::new_readonly(accounts.withdraw_authority.key(), false),
            AccountMeta::new(accounts.validator_list.key(), false),
            AccountMeta::new(accounts.validator_stake_account.key(), false),
            AccountMeta::new(accounts.transient_stake_account.key(), false),
            AccountMeta::new_readonly(accounts.clock_sysvar.key(), false),
            AccountMeta::new_readonly(accounts.stake_program.key(), false),
        ],
        data: vec![2], // index for RemoveValidatorFromPool
    };

    // invoke the RemoveValidatorFromPool instruction
    let seeds: &[&[u8]] = &[b"staker", &[ctx.bumps.staker_authority]];
    invoke_signed(
        &remove_validator_ix,
        &[
            accounts.stake_pool.clone(),
            accounts.staker_authority.clone(),
            accounts.withdraw_authority.clone(),
            accounts.validator_list.clone(),
            accounts.validator_stake_account.clone(),
            accounts.transient_stake_account.clone(),
            accounts.clock_sysvar.clone(),
            accounts.stake_program.clone(),
        ],
        &[seeds],
    )?;

    emit_cpi! {
        ValidatorRemoved {
            stake_account: accounts.validator_stake_account.key(),
        }
    };

    Ok(())
}

#[derive(Accounts)]
#[event_cpi]
pub struct IncreaseValidatorStake<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"stake_manager", signer.key().as_ref()],
        bump
    )]
    pub stake_manager: Account<'info, StakeManager>,

    /// CHECK: The stake pool
    #[account(mut)]
    pub stake_pool: AccountInfo<'info>,

    /// CHECK: Stake pool staker authority
    #[account(
        seeds = [b"staker"],
        bump
    )]
    pub staker_authority: AccountInfo<'info>,

    /// CHECK: Stake pool withdraw authority
    #[account()]
    pub withdraw_authority: AccountInfo<'info>,

    /// CHECK: Validator list account
    #[account(mut)]
    pub validator_list: AccountInfo<'info>,

    /// CHECK: Pool reserve stake account
    #[account(mut)]
    pub reserve_stake: AccountInfo<'info>,

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

/// Processes the `IncreaseValidatorStake` instruction
pub fn process_increase_validator_stake(
    ctx: Context<IncreaseValidatorStake>,
    amount: u64,
    transient_stake_seed: u64,
    ephemeral_stake_seed: u64,
) -> Result<()> {
    let accounts = &ctx.accounts;

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
            AccountMeta::new(accounts.stake_pool.key(), false),
            AccountMeta::new_readonly(accounts.staker_authority.key(), true),
            AccountMeta::new_readonly(accounts.withdraw_authority.key(), false),
            AccountMeta::new(accounts.validator_list.key(), false),
            AccountMeta::new(accounts.reserve_stake.key(), false),
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
            accounts.reserve_stake.clone(),
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
        ValidatorStakeIncreased {
            validator: accounts.validator_vote_account.key(),
            amount
        }
    };

    Ok(())
}

#[derive(Accounts)]
#[event_cpi]
pub struct DecreaseValidatorStake<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"stake_manager", signer.key().as_ref()],
        bump
    )]
    pub stake_manager: Account<'info, StakeManager>,

    /// CHECK: The stake pool
    #[account(mut)]
    pub stake_pool: AccountInfo<'info>,

    /// CHECK: Stake pool staker authority
    #[account(
        seeds = [b"staker"],
        bump
    )]
    pub staker_authority: AccountInfo<'info>,

    /// CHECK: Stake pool withdraw authority
    #[account()]
    pub withdraw_authority: AccountInfo<'info>,

    /// CHECK: Validator list account
    #[account(mut)]
    pub validator_list: AccountInfo<'info>,

    /// CHECK :Stake pool reserve stake
    #[account(mut)]
    pub reserve_stake: AccountInfo<'info>,

    /// CHECK: Validator stake account
    #[account(mut)]
    pub validator_stake_account: AccountInfo<'info>,

    /// CHECK: Validator ephemeral stake account
    #[account(mut)]
    pub ephemeral_stake_account: AccountInfo<'info>,

    /// CHECK: Validator transient stake account
    #[account(mut)]
    pub transient_stake_account: AccountInfo<'info>,

    /// CHECK: The vote account of the validator
    #[account(mut)]
    pub validator_vote_account: AccountInfo<'info>,

    /// CHECK: Clock sysvar
    #[account(address = clock::ID)]
    pub clock_sysvar: AccountInfo<'info>,

    /// CHECK: Stake history sysvar
    #[account(address = stake_history::ID)]
    pub stake_history_sysvar: AccountInfo<'info>,

    /// CHECK: Stake program
    #[account(address = stake::program::ID)]
    pub stake_program: AccountInfo<'info>,

    /// CHECK: Stake Pool program
    #[account(address = STAKE_POOL_PROGRAM_ID)]
    pub stake_pool_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

/// Processes the `DecreaseValidatorStake` instruction
pub fn process_decrease_validator_stake(
    ctx: Context<DecreaseValidatorStake>,
    amount: u64,
    transient_stake_seed: u64,
    ephemeral_stake_seed: u64,
) -> Result<()> {
    let accounts = &ctx.accounts;

    let instruction_data = {
        let mut data = vec![20]; // index for DecreaseAdditionalValidatorStake
        data.extend_from_slice(&amount.to_le_bytes());
        data.extend_from_slice(&transient_stake_seed.to_le_bytes());
        data.extend_from_slice(&ephemeral_stake_seed.to_le_bytes());
        data
    };

    let decrease_validator_stake_ix = Instruction {
        program_id: STAKE_POOL_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(accounts.stake_pool.key(), false),
            AccountMeta::new_readonly(accounts.staker_authority.key(), true),
            AccountMeta::new_readonly(accounts.withdraw_authority.key(), false),
            AccountMeta::new(accounts.validator_list.key(), false),
            AccountMeta::new(accounts.reserve_stake.key(), false),
            AccountMeta::new(accounts.validator_stake_account.key(), false),
            AccountMeta::new(accounts.ephemeral_stake_account.key(), false),
            AccountMeta::new(accounts.transient_stake_account.key(), false),
            AccountMeta::new_readonly(accounts.clock_sysvar.key(), false),
            AccountMeta::new_readonly(accounts.stake_history_sysvar.key(), false),
            AccountMeta::new_readonly(accounts.system_program.key(), false),
            AccountMeta::new_readonly(accounts.stake_program.key(), false),
        ],
        data: instruction_data,
    };

    // invoke the DecreaseAdditionalValidatorStake instruction
    let seeds: &[&[u8]] = &[b"staker", &[ctx.bumps.staker_authority]];
    invoke_signed(
        &decrease_validator_stake_ix,
        &[
            accounts.stake_pool.clone(),
            accounts.staker_authority.clone(),
            accounts.withdraw_authority.clone(),
            accounts.validator_list.clone(),
            accounts.reserve_stake.clone(),
            accounts.validator_stake_account.clone(),
            accounts.ephemeral_stake_account.clone(),
            accounts.transient_stake_account.clone(),
            accounts.clock_sysvar.clone(),
            accounts.stake_history_sysvar.clone(),
            accounts.system_program.to_account_info(),
            accounts.stake_program.clone(),
        ],
        &[seeds],
    )?;

    emit_cpi! {
        ValidatorStakeDecreased {
            validator: accounts.validator_vote_account.key(),
            amount
        }
    };

    Ok(())
}

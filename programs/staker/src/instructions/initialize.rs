use crate::{state::*, ANCHOR_DISCRIMINATOR};
use anchor_lang::prelude::*;
use anchor_spl::token_interface::Token2022;

#[derive(Accounts)]
#[event_cpi]
pub struct InitializeStaker<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        init,
        payer = signer,
        space = ANCHOR_DISCRIMINATOR + Access::INIT_SPACE,
        seeds = [b"access"],
        bump
    )]
    pub access: Box<Account<'info, Access>>,

    #[account(
        init,
        payer = signer,
        space = ANCHOR_DISCRIMINATOR + Agent::INIT_SPACE,
        seeds = [b"agent", owner_info.key().as_ref()],
        bump
    )]
    pub owner_agent_account: Account<'info, Agent>,

    /// CHECK: Owner account used for metadata authority
    #[account()]
    pub owner_info: AccountInfo<'info>,

    #[account(
        init,
        payer = signer,
        space = ANCHOR_DISCRIMINATOR + StakeManager::INIT_SPACE,
        seeds = [b"stake_manager", stake_manager_info.key().as_ref()],
        bump
    )]
    pub stake_manager: Account<'info, StakeManager>,

    /// CHECK: Account used for staker manager authority
    #[account()]
    pub stake_manager_info: AccountInfo<'info>,

    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

/// Processes the `InitializeStaker` instruction
///
/// Trusted, one-time deployment step that sets the initial `owner` and `stake_manager`. The
/// live program is already deployed and initialized, so there is no remaining front-run
/// window against it; the initialization-ordering risk was reviewed and accepted in audit.
/// A hypothetical re-initialization takes no user funds, and the program can be redeployed.
/// See "Authorities" in the README.
pub fn process_initialize_staker(ctx: Context<InitializeStaker>) -> Result<()> {
    let access_control = &mut ctx.accounts.access;
    access_control.owner = ctx.accounts.owner_info.key();
    access_control.is_paused = false;
    access_control.stake_manager = ctx.accounts.stake_manager_info.key();

    emit_cpi!(StakerInitialized {
        owner: ctx.accounts.owner_info.key(),
        stake_manager: ctx.accounts.stake_manager_info.key(),
    });
    Ok(())
}

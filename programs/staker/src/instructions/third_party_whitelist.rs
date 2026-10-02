use crate::{error::ErrorCode, state::*, ANCHOR_DISCRIMINATOR};
use anchor_lang::prelude::*;

#[derive(Accounts)]
#[event_cpi]
#[instruction(agent: Pubkey)]
pub struct AddThirdPartyAgent<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        init,
        payer = signer,
        space = ANCHOR_DISCRIMINATOR + ThirdPartyAgent::INIT_SPACE,
        seeds = [b"third_party_agent", agent.as_ref()],
        bump
    )]
    pub new_third_party_agent_account: Account<'info, ThirdPartyAgent>,

    // only a regular agent can register a third-party agent
    #[account(
        seeds = [b"agent", signer.key().as_ref()],
        bump
    )]
    pub agent_account: Account<'info, Agent>,

    pub system_program: Program<'info, System>,
}

/// Processes the `AddThirdPartyAgent` instruction
pub fn process_add_third_party_agent(
    ctx: Context<AddThirdPartyAgent>,
    agent: Pubkey,
) -> Result<()> {
    emit_cpi! {
        ThirdPartyAgentAdded { agent }
    };

    Ok(())
}

#[derive(Accounts)]
#[event_cpi]
#[instruction(agent: Pubkey)]
pub struct RemoveThirdPartyAgent<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"third_party_agent", agent.as_ref()],
        bump,
        close = signer
    )]
    pub third_party_agent_account_to_remove: Account<'info, ThirdPartyAgent>,

    // only a regular agent can remove a third-party agent
    #[account(
        seeds = [b"agent", signer.key().as_ref()],
        bump
    )]
    pub agent_account: Account<'info, Agent>,
}

/// Processes the `RemoveThirdPartyAgent` instruction
pub fn process_remove_third_party_agent(
    ctx: Context<RemoveThirdPartyAgent>,
    agent: Pubkey,
) -> Result<()> {
    emit_cpi! {
        ThirdPartyAgentRemoved { agent }
    };

    Ok(())
}

#[derive(Accounts)]
#[event_cpi]
#[instruction(user: Pubkey)]
pub struct ThirdPartyAddUserToWhitelist<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    // caller must be a registered third-party agent
    #[account(
        seeds = [b"third_party_agent", signer.key().as_ref()],
        bump
    )]
    pub third_party_agent_account: Account<'info, ThirdPartyAgent>,

    // claim the user for this agent — `init` fails if already claimed by anyone
    #[account(
        init,
        payer = signer,
        space = ANCHOR_DISCRIMINATOR + ThirdPartyUser::INIT_SPACE,
        seeds = [b"third_party_user", user.as_ref()],
        bump
    )]
    pub third_party_user: Account<'info, ThirdPartyUser>,

    // must be fresh: rejects users already Whitelisted or Blacklisted by anyone
    #[account(
        init_if_needed,
        constraint = user_whitelist_account.status == WhitelistUserStatus::None
            @ ErrorCode::UserNotEligibleForThirdPartyWhitelisting,
        payer = signer,
        space = ANCHOR_DISCRIMINATOR + UserStatus::INIT_SPACE,
        seeds = [b"user", user.as_ref()],
        bump
    )]
    pub user_whitelist_account: Account<'info, UserStatus>,

    pub system_program: Program<'info, System>,
}

/// Processes the `ThirdPartyAddUserToWhitelist` instruction
pub fn process_third_party_add_user_to_whitelist(
    ctx: Context<ThirdPartyAddUserToWhitelist>,
    user: Pubkey,
) -> Result<()> {
    let agent = ctx.accounts.signer.key();
    ctx.accounts.third_party_user.agent = agent;

    let user_status = &mut ctx.accounts.user_whitelist_account;
    let old_status = user_status.status.clone();
    user_status.status = WhitelistUserStatus::Whitelisted;

    emit_cpi! {
        ThirdPartyWhitelistingStatusChanged {
            user,
            agent,
            old_status,
            new_status: WhitelistUserStatus::Whitelisted
        }
    };

    Ok(())
}

#[derive(Accounts)]
#[event_cpi]
#[instruction(user: Pubkey)]
pub struct ThirdPartyAddUserToBlacklist<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    // caller must be a registered third-party agent
    #[account(
        seeds = [b"third_party_agent", signer.key().as_ref()],
        bump
    )]
    pub third_party_agent_account: Account<'info, ThirdPartyAgent>,

    // the user must already be owned by this agent
    #[account(
        seeds = [b"third_party_user", user.as_ref()],
        bump,
        constraint = third_party_user.agent == signer.key() @ ErrorCode::NotUserOwner
    )]
    pub third_party_user: Account<'info, ThirdPartyUser>,

    #[account(
        mut,
        constraint = user_whitelist_account.status != WhitelistUserStatus::Blacklisted
            @ ErrorCode::AlreadyBlacklisted,
        seeds = [b"user", user.as_ref()],
        bump
    )]
    pub user_whitelist_account: Account<'info, UserStatus>,
}

/// Processes the `ThirdPartyAddUserToBlacklist` instruction
pub fn process_third_party_add_user_to_blacklist(
    ctx: Context<ThirdPartyAddUserToBlacklist>,
    user: Pubkey,
) -> Result<()> {
    let agent = ctx.accounts.signer.key();

    let user_status = &mut ctx.accounts.user_whitelist_account;
    let old_status = user_status.status.clone();
    user_status.status = WhitelistUserStatus::Blacklisted;

    emit_cpi! {
        ThirdPartyWhitelistingStatusChanged {
            user,
            agent,
            old_status,
            new_status: WhitelistUserStatus::Blacklisted
        }
    };

    Ok(())
}

#[derive(Accounts)]
#[event_cpi]
#[instruction(user: Pubkey)]
pub struct ThirdPartyClearUserStatus<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    // caller must be a registered third-party agent
    #[account(
        seeds = [b"third_party_agent", signer.key().as_ref()],
        bump
    )]
    pub third_party_agent_account: Account<'info, ThirdPartyAgent>,

    // the user must already be owned by this agent; the claim is released on clear
    #[account(
        mut,
        seeds = [b"third_party_user", user.as_ref()],
        bump,
        constraint = third_party_user.agent == signer.key() @ ErrorCode::NotUserOwner,
        close = signer
    )]
    pub third_party_user: Account<'info, ThirdPartyUser>,

    // a custodian may release its own whitelisted user, but can never lift a
    // blacklist: only a regular TruFin agent can move a user out of Blacklisted
    #[account(
        mut,
        constraint = user_whitelist_account.status != WhitelistUserStatus::Blacklisted
            @ ErrorCode::CannotClearBlacklistedUser,
        seeds = [b"user", user.as_ref()],
        bump
    )]
    pub user_whitelist_account: Account<'info, UserStatus>,
}

/// Processes the `ThirdPartyClearUserStatus` instruction
pub fn process_third_party_clear_user_status(
    ctx: Context<ThirdPartyClearUserStatus>,
    user: Pubkey,
) -> Result<()> {
    let agent = ctx.accounts.signer.key();

    let user_status = &mut ctx.accounts.user_whitelist_account;
    let old_status = user_status.status.clone();
    user_status.status = WhitelistUserStatus::None;

    emit_cpi! {
        ThirdPartyWhitelistingStatusChanged {
            user,
            agent,
            old_status,
            new_status: WhitelistUserStatus::None
        }
    };

    Ok(())
}

#[derive(Accounts)]
#[event_cpi]
#[instruction(user: Pubkey)]
pub struct AgentReleaseThirdPartyUser<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    // only a regular agent can force-release a third-party user claim
    #[account(
        seeds = [b"agent", signer.key().as_ref()],
        bump
    )]
    pub agent_account: Account<'info, Agent>,

    // close the ownership claim regardless of which custodian owns it, so an
    // orphaned ThirdPartyUser (e.g. left by a removed custodian) can be released
    // and the user re-onboarded. UserStatus is left untouched — TruFin manages
    // it via the regular-agent whitelist instructions.
    #[account(
        mut,
        seeds = [b"third_party_user", user.as_ref()],
        bump,
        close = signer
    )]
    pub third_party_user: Account<'info, ThirdPartyUser>,
}

/// Processes the `AgentReleaseThirdPartyUser` instruction
pub fn process_agent_release_third_party_user(
    ctx: Context<AgentReleaseThirdPartyUser>,
    user: Pubkey,
) -> Result<()> {
    emit_cpi! {
        ThirdPartyUserReleased {
            user,
            agent: ctx.accounts.third_party_user.agent
        }
    };

    Ok(())
}

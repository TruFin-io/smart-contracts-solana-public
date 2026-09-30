use crate::state::types::WhitelistUserStatus;
use anchor_lang::prelude::*;

#[event]
pub struct StakerInitialized {
    pub owner: Pubkey,
    pub stake_manager: Pubkey,
}

#[event]
pub struct StakerPaused {}

#[event]
pub struct StakerUnpaused {}

#[event]
pub struct SetPendingOwner {
    pub current_owner: Pubkey,
    pub pending_owner: Pubkey,
}

#[event]
pub struct ClaimedOwnership {
    pub old_owner: Pubkey,
    pub new_owner: Pubkey,
}

#[event]
pub struct AgentAdded {
    pub new_agent: Pubkey,
}

#[event]
pub struct AgentRemoved {
    pub removed_agent: Pubkey,
}

#[event]
pub struct WhitelistingStatusChanged {
    pub user: Pubkey,
    pub old_status: WhitelistUserStatus,
    pub new_status: WhitelistUserStatus,
}

#[event]
pub struct ThirdPartyAgentAdded {
    pub agent: Pubkey,
}

#[event]
pub struct ThirdPartyAgentRemoved {
    pub agent: Pubkey,
}

#[event]
pub struct ThirdPartyWhitelistingStatusChanged {
    pub user: Pubkey,
    pub agent: Pubkey,
    pub old_status: WhitelistUserStatus,
    pub new_status: WhitelistUserStatus,
}

#[event]
pub struct ThirdPartyUserReleased {
    pub user: Pubkey,
    pub agent: Pubkey,
}

#[event]

pub struct ValidatorAdded {
    pub validator: Pubkey,
}

#[event]
pub struct ValidatorRemoved {
    pub stake_account: Pubkey,
}

#[event]
pub struct Deposited {
    pub amount: u64,
}

#[event]
pub struct DepositedToSpecificValidator {
    pub amount: u64,
    pub validator: Pubkey,
}

#[event]
pub struct StakeManagerSet {
    pub old_stake_manager: Pubkey,
    pub new_stake_manager: Pubkey,
}

#[event]
pub struct ValidatorStakeIncreased {
    pub validator: Pubkey,
    pub amount: u64,
}

#[event]
pub struct ValidatorStakeDecreased {
    pub validator: Pubkey,
    pub amount: u64,
}

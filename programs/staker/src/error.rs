use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Contract is paused")]
    ContractPaused,
    #[msg("Only the owner can call this method")]
    NotAuthorized,
    #[msg("Contract is not paused")]
    NotPaused,
    #[msg("No pending owner set")]
    PendingOwnerNotSet,
    #[msg("Only the pending owner can call this method")]
    NotPendingOwner,
    #[msg("Owner cannot be removed")]
    CannotRemoveOwner,
    #[msg("User is already whitelisted")]
    AlreadyWhitelisted,
    #[msg("User is already blacklisted")]
    AlreadyBlacklisted,
    #[msg("User status is already cleared")]
    AlreadyCleared,
    #[msg("User is not whitelisted")]
    UserNotWhitelisted,
    #[msg("User is not eligible for third-party whitelisting")]
    UserNotEligibleForThirdPartyWhitelisting,
    #[msg("Signer is not the owner of this third-party user")]
    NotUserOwner,
    #[msg("A third-party agent cannot clear a blacklisted user")]
    CannotClearBlacklistedUser,
}

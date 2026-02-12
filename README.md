# Solana Staker

## TruStake on Solana
The TruFin SOL staking vault provides users with a reliable way to stake SOL on the Solana network. Users can deposit SOL and receive a receipt in the form of the reward-bearing TruSOL token, which can be used to redeem staked SOL back into their wallet.
Users can either choose the validator they wish to delegate their SOL to or let the vault efficiently manage validator selection.

The TruFin SOL staking vault is built on top of the standard Solana Stake Pool Program
[SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy](https://explorer.solana.com/address/SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy) with the additional feature of users whitelisting.


## Whitelist
Users of our vault must be whitelisted to ensure they have completed offline AML/KYC checks and other onboarding requirements. The contract verifies whether a user is whitelisted during deposit operations. 
The whitelist mechanism allows TruFin to revoke a user's whitelist status if they exhibit malicious behavior, thereby safeguarding the integrity of the protocol.

## Pausability
The contract includes a pausability feature, enabling the owner to temporarily halt deposits to the pool.
This is useful in emergencies, allowing the protocol to suspend operations while remediation is carried out.

## Deposits and Withdrawals
- Deposits: Users deposit SOL to the stake pool through the Staker program, which enforces whitelist checks. Deposit-stake operations are not permitted.
- Withdrawals: TruSOL tokens can be redeemed for staked SOL directly from the stake pool by invoking the `WithdrawStake` instruction of the Stake Pool Program. SOL withdrawals are not permitted. Whitelist checks are not enforced on withdrawals.


## Backend Processes
We run two backend processes to ensure smooth operations:

### Pool Maintenance Bot
This bot runs at the start of each epoch to keep the pool updated by calling the `UpdateValidatorListBalance`, `UpdateStakePoolBalance` and `CleanupRemovedValidatorEntries` instructions of the pool.
Maintenance tasks include managing stake accounts, distributing staking rewards, paying out fees, and updating the TruSOL token price.

### Stake Management Bot
This bot optimises the allocation of active stake across validators by allocating liquid SOL in the pool reserve or reducing stake on underperforming validators based on performance metrics and other considerations.


## Authorities

### Owner 
The `owner` authority of the Staker program is set during contract initialization to a multi-signature account. 
The owner can:
- Pause and unpause the contract.
- Add or remove validators from the stake pool.
- Update the stake manager authority.

### Stake Manager
The `stake_manager` authority is set to a single-signature account at contract initialization.
It is used by backend processes to adjust stakes on validators. The owner can update this authority.

### Manager
The `manager` authority of the pool can:
- Set deposit, withdrawal and epoch fees.
- Set the account that will receive fees each epoch.
- Set the `staker` authority. 

The manager authority should be set to the `owner` account.

### Staker
The `staker` authority of the pool can:
- Add and remove validators.
- Adjust stake allocations on validators.

It must be set to the `staker PDA` of the Staker program, delegating control of these operations to the `owner` and `stake_manager` accounts.

### Deposit Authorities
`SOL deposit` and `Stake deposit` authorities are needed to deposit SOL and deposit stake into the pool.
They must be set to the `deposit PDA` of the Staker program, to ensure that all deposits are signed by the program, preventing direct user deposits.

### SOL Withdrawal
The `SOL withdrawal` authority of the pool controls withdrawals from the pool reserve.
It must be set to the `withdraw PDA` of the Staker program to prevent unauthorised withdrawals.
Our staker does not allow to withdraw SOL, users can withdraw stake directly from the pool.

---

# Build and Test

## Prerequisites

Before starting, make sure you have [rustup](https://rustup.rs/) along with a
recent `rustc` and `cargo` version installed. 
Currently, we are using version 1.81.0. 
You can verify your versions with:

```sh
rustc --version
cargo --version
```

Next, install the Solana CLI version 2.0.15:
```sh
sh -c "$(curl -sSfL https://release.anza.xyz/v2.0.15/install)"
solana --version
```

Finally, install the Anchor Version Manager and anchor-cli version 0.30.1:
```sh
cargo install --git https://github.com/coral-xyz/anchor avm --force
avm install 0.30.1
avm use 0.30.1

avm --version
anchor --version
```

You may need to run the following commands:
```sh
solana-keygen new --no-bip39-passphrase
yarn
```

## Build and Run tests

To build and test the project, run:
```sh
make build
make test
```

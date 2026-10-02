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


## Fees
The pool inherits the standard Solana Stake Pool Program's fee fields. TruStake uses only the epoch (reward) fee and the withdrawal fee. The **deposit fee and referral fee are intentionally fixed at zero and are never enabled** — they exist only because they are part of the underlying Stake Pool Program, not because TruStake operates a deposit-fee or referral program.

- Epoch (reward) fee: a percentage of staking rewards, paid to the manager fee account each epoch. Active.
- Withdrawal fee: a small percentage charged on `WithdrawStake`. Active.
- Deposit fee: `0`. Not used and will not be enabled.
- Referral fee: `0`. Not used and will not be enabled.

Because the deposit and referral fees are fixed at zero, no pool tokens are ever minted to a deposit-fee or referral-fee account during a deposit. Consequently the `referral_fee_token_account` passed into the deposit instructions is inert: it is a caller-supplied account (as the Stake Pool Program's `DepositSol` CPI requires), but with a zero referral fee nothing is ever routed to it, so whichever account it points to cannot affect any funds. These values are set at pool initialization (`scripts/init-pool.ts`) and are not changed.

### Why the epoch and withdrawal fees are load-bearing
The epoch and withdrawal fees are not only revenue: they are what make donation-based share-price manipulation unprofitable, so **neither will be set to zero**. The reserve stake account can be credited by anyone with a plain `SystemProgram.transfer`, and the permissionless `UpdateStakePoolBalance` folds any such unaccounted lamports into `total_lamports` as reward lamports. The epoch fee is charged on that delta, diluting a donor's own equity, and the withdrawal fee uses ceiling arithmetic, so a dust position cannot be redeemed at all — a one-token holding is consumed entirely by the fee. Together these make the classic donate-then-withdraw sequence non-profitable at any size.

## Deposit sizing and pool bootstrap
The Staker deliberately imposes no minimum deposit, mints no dead shares at initialization, and applies no virtual share offset. `process_deposit` enforces the whitelist and pause state and forwards the caller's amount to the Stake Pool Program's `DepositSol`; deposit sizing is left to the depositor.

The Stake Pool Program mints 1:1 when a pool holds no assets or has no token supply, and otherwise mints `floor(lamports * supply / total_lamports)`. The 1:1 branch, and the rounding behaviour that makes a very small supply exploitable, are therefore reachable only at a freshly initialised pool or after every holder has exited — which is why TruStake seeds its pool and maintains stake in it. A pool holding live stake and a real token supply prices deposits proportionally, and the floor rounding costs a depositor at most one token.

These properties are why no economic floor is enforced in the program: the conditions under which one would matter do not occur on a funded pool, deposits are restricted to whitelisted users who complete AML/KYC checks and whose access can be revoked, and the fee configuration above removes the profit from attempting to manufacture them.


## Backend Processes
We run two backend processes to ensure smooth operations:

### Pool Maintenance Bot
This bot runs at the start of each epoch to keep the pool updated by calling the `UpdateValidatorListBalance`, `UpdateStakePoolBalance` and `CleanupRemovedValidatorEntries` instructions of the pool.
Maintenance tasks include managing stake accounts, distributing staking rewards, paying out fees, and updating the TruSOL token price.

### Stake Management Bot
This bot optimises the allocation of active stake across validators by allocating liquid SOL in the pool reserve or reducing stake on underperforming validators based on performance metrics and other considerations.

Because depositing to a specific validator is permissionless, a whitelisted user can add transient stake to a validator and briefly delay this bot's stake *decrease* / rebalancing on that validator for an epoch. This is an accepted, self-healing trade-off rather than a vulnerability: the delayed operation is yield optimisation (not safety-critical), no user funds are at risk and no other user's deposit or withdrawal path is affected, the actor bears a real recurring cost (SOL plus stake-account rent) on every cycle and can be removed in a single transaction via whitelist revocation, and the condition clears automatically as epoch maintenance proceeds.

#### Ephemeral stake seed
The validator-specific instructions (`deposit_to_specific_validator`, `increase_validator_stake`, `decrease_validator_stake`) invoke the Stake Pool Program's *additional* stake operations, which use a short-lived **ephemeral** stake account. That account is a pool-global PDA derived from a caller-chosen `u64` seed, and the Stake Pool Program creates it with `Allocate`/`Assign`, which tolerates an address that already holds lamports. Each instruction therefore takes a required `ephemeral_seed`, and callers must pass a fresh (e.g. random) seed on every call together with the matching ephemeral account. This prevents a persistent denial of service in which someone pre-funds a single fixed ephemeral address to permanently block rebalancing: because the seed is not fixed, a poisoned address is simply abandoned in favour of a fresh one.


## Authorities

### Initialization
The `owner` and `stake_manager` authorities are set once, at deployment, by the `InitializeStaker` instruction. Initialization is a trusted, one-time deployment step: the live program is already deployed and initialized, so there is no remaining front-run window against it, and the initialization-ordering risk was reviewed and accepted in audit. A hypothetical re-initialization takes no user funds, and the program can be redeployed.

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

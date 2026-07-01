# Third-Party Whitelisting (Custodian Onboarding)

**Status:** Implemented (see §12/§13)
**Scope:** `staker` program (`programs/staker`). No vault changes.
**Author:** TruFin

---

## 1. Background & Motivation

Staking on TruFin is permissioned. A user may only deposit if their per-user
`UserStatus` PDA is `Whitelisted`. Today, whitelisting is performed by TruFin
itself: an authorised **agent** calls `add_user_to_whitelist` after the user
passes an off-chain KYC.

We now want to onboard **third parties** — e.g. custodians and wallet platforms
that serve their own end clients — and let those clients stake. The third party
has already KYC'd its own clients, so we want to delegate whitelisting to it,
**without** giving it control over TruFin's own users or over other third
parties' users.

### Current architecture (for reference)

- `Access` PDA `[b"access"]` — `owner`, `stake_manager`, `is_paused`, `pending_owner`.
- `Agent` marker PDA `[b"agent", agent]` — existence ⇒ caller is an agent.
- `UserStatus` PDA `[b"user", user]` — `status ∈ {None, Whitelisted, Blacklisted}`.
- Whitelist instructions (`add_user_to_whitelist`, `add_user_to_blacklist`,
  `clear_user_status`) require the signer to hold `[b"agent", signer]`. **Any
  agent can mutate any user.**
- `deposit` gates on the **signer's** `UserStatus` being `Whitelisted`
  (`programs/staker/src/instructions/staking.rs`).
- All vaults (`raydium-vault`/TruRLP, `trubill`, `trustrc`) read the *same*
  `UserStatus` PDA from the staker program. **The whitelist is a single shared
  source of truth across the staker and every vault.**

---

## 2. Goals / Non-Goals

### Goals
- Introduce a **third-party agent** role (e.g. a custodian) that can whitelist
  and blacklist **only its own users**.
- Let a custodian **onboard and deposit for a user in a single atomic
  transaction**, so the end user never experiences a separate "whitelist" step.
- Preserve TruFin's compliance guarantees: a third-party agent can never
  whitelist a user TruFin has blacklisted, nor touch users it does not own.
- Keep the change **surgical**: no migration of existing `UserStatus` accounts,
  no changes to `deposit` or to any vault.

### Non-Goals
- The **omnibus model** needs no new code (see §3). This spec covers the
  **segregated model** only.
- On-chain enforcement of KYC. KYC remains off-chain; a third-party agent's
  signature *is* the on-chain attestation that it KYC'd the user.
- Deposit-on-behalf where TruFin moves a user's funds. The user (or the
  custodian acting as the user's wallet) still signs the `deposit`.

---

## 3. Integration Models

| | Omnibus | Segregated (this spec) |
|---|---|---|
| On-chain addresses | 1 (the custodian's wallet) | 1 per end user |
| Who is whitelisted | The custodian's single address | Each end user's address |
| Per-user accounting | Off-chain, at the custodian | On-chain |
| Code required | **None** — whitelist the address as a normal user | Third-party agent role (below) |

**Omnibus** is already supported: whitelist the custodian's address with the
existing `add_user_to_whitelist`. The custodian holds the receipt tokens and
tracks its clients off-chain.

The rest of this document specifies the **segregated** model.

---

## 4. Design Overview

Three additions to the `staker` program:

1. **`ThirdPartyAgent` marker PDA** `[b"third_party_agent", agent]` — a role
   distinct from the full-power `Agent`. Registered/removed by a regular agent.

2. **`ThirdPartyUser` PDA** `[b"third_party_user", user]` storing
   `{ agent: Pubkey }` — records *which* third-party agent owns a user. This is
   what scopes a third-party agent's powers and enables off-boarding. It is a
   **new, separate** account: `UserStatus` is left untouched, so **no existing
   account is migrated** and `deposit`/vaults are unaffected.

3. **Three third-party instructions** mirroring the existing agent ones but
   scoped by ownership: `third_party_add_user_to_whitelist`,
   `third_party_add_user_to_blacklist`, `third_party_clear_user_status`.

### Why a separate `ThirdPartyUser` PDA (not a field on `UserStatus`)

Adding `whitelisted_by: Option<Pubkey>` to `UserStatus` was considered and
rejected: it changes `UserStatus::INIT_SPACE`, forcing a realloc/migration of
**every existing live `UserStatus` account** across the staker and all vaults,
and a code change in every instruction that initialises one. A separate marker
PDA is additive, isolates third-party logic, matches the existing
marker-PDA pattern (`Agent`, `StakeManager`), and — because it stores `agent` —
lets us enumerate a custodian's users off-chain via `getProgramAccounts` for
bulk off-boarding.

---

## 5. The Atomic Onboarding-and-Deposit Transaction

A custodian onboarding and depositing for a brand-new user submits **one
transaction with two instructions**:

| # | Instruction | Signer | Effect |
|---|---|---|---|
| 1 | `third_party_add_user_to_whitelist(user)` | the **third-party agent** | Creates `ThirdPartyUser{agent}` and sets `UserStatus[user] = Whitelisted` |
| 2 | `deposit` (existing, unchanged) | the **user** (their wallet) | Gates on `UserStatus[user] == Whitelisted`, moves funds |

Both instructions live in the same transaction, so they **succeed or fail
atomically**. Instruction 1 creates the `UserStatus` PDA, which instruction 2
then reads — Solana executes instructions in order within a transaction.

In a Wallet-as-a-Service setup the custodian controls **both** the third-party
agent key and the user's wallet key, so it composes and signs this single
transaction itself. If the user self-custodies, the transaction simply carries
two real signers (agent + user); it remains one atomic transaction.

> **`deposit` is not modified.** It still checks `UserStatus[signer] ==
> Whitelisted`. All the new logic is on the whitelisting side.

### 5.1 First deposit vs. subsequent deposits

Instruction 1 is a **one-time onboarding step**, not part of every deposit:

- **First time:** the two-instruction transaction above. Instruction 1 creates
  `ThirdPartyUser` and flips `UserStatus` to `Whitelisted`.
- **Every deposit after that:** just the plain, single `deposit` instruction —
  the user is already `Whitelisted`. **Do not** re-send instruction 1: it would
  fail, because `ThirdPartyUser` already exists (`init`) and `UserStatus.status`
  is no longer `None` (eligibility constraint, §6.3).

Integrators should include instruction 1 only when onboarding — i.e. when the
user's `ThirdPartyUser` PDA does not yet exist.

### 5.2 Transaction semantics

- **Ordering is required:** instruction 1 must precede instruction 2. Solana
  executes a transaction's instructions sequentially and commits each one's
  account changes before the next, so instruction 2 observes the `Whitelisted`
  status written by instruction 1.
- **Atomicity covers pause:** `deposit` is pause-gated (`!access.is_paused`);
  whitelisting is not. If the program is paused, instruction 2 fails and the
  whole transaction reverts — including instruction 1 — so a paused deposit can
  never leave a user whitelisted-but-not-deposited as a side effect.

---

## 6. Detailed Changes

### 6.1 New accounts

```rust
// marker PDA: existence ⇒ caller is a third-party agent
#[account]
#[derive(InitSpace)]
pub struct ThirdPartyAgent {}            // seeds = [b"third_party_agent", agent]

// records which third-party agent owns a user
#[account]
#[derive(InitSpace)]
pub struct ThirdPartyUser {              // seeds = [b"third_party_user", user]
    pub agent: Pubkey,
}
```

`UserStatus` and `WhitelistUserStatus` are unchanged.

### 6.2 Agent management (regular agents only)

Third-party agents are onboarded **manually by TruFin** (a regular agent) — there
is no self-service registration.

- `add_third_party_agent(agent: Pubkey)` — signer must hold `[b"agent", signer]`;
  `init`s `[b"third_party_agent", agent]`.
- `remove_third_party_agent(agent: Pubkey)` — signer must hold `[b"agent", signer]`;
  `close`s the marker PDA.

### 6.3 `third_party_add_user_to_whitelist(user: Pubkey)`

Illustrative account context:

```rust
#[derive(Accounts)]
#[event_cpi]
#[instruction(user: Pubkey)]
pub struct ThirdPartyAddUserToWhitelist<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    // caller must be a registered third-party agent
    #[account(seeds = [b"third_party_agent", signer.key().as_ref()], bump)]
    pub third_party_agent_account: Account<'info, ThirdPartyAgent>,

    // claim the user for this agent — `init` fails if already claimed by anyone
    #[account(
        init,
        payer = signer,
        space = ANCHOR_DISCRIMINATOR + ThirdPartyUser::INIT_SPACE,
        seeds = [b"third_party_user", user.as_ref()],
        bump,
    )]
    pub third_party_user: Account<'info, ThirdPartyUser>,

    // must be fresh: rejects users already Whitelisted or Blacklisted by anyone
    #[account(
        init_if_needed,
        payer = signer,
        space = ANCHOR_DISCRIMINATOR + UserStatus::INIT_SPACE,
        constraint = user_whitelist_account.status == WhitelistUserStatus::None
            @ ErrorCode::UserNotEligibleForThirdPartyWhitelisting,
        seeds = [b"user", user.as_ref()],
        bump,
    )]
    pub user_whitelist_account: Account<'info, UserStatus>,

    pub system_program: Program<'info, System>,
}
```

Handler: set `third_party_user.agent = signer.key()`, set
`user_whitelist_account.status = Whitelisted`, emit
`ThirdPartyWhitelistingStatusChanged` (§6.5).

**The eligibility rule is the security crux.** Requiring `status == None`:
- blocks re-whitelisting a **`Blacklisted`** user (no compliance bypass), and
- blocks **poaching** a user already whitelisted by TruFin or another custodian.

### 6.4 `third_party_add_user_to_blacklist(user)` / `third_party_clear_user_status(user)`

Same shape, but instead of `init` on `ThirdPartyUser` they require it to already
exist and be owned by the signer:

```rust
#[account(
    seeds = [b"third_party_user", user.as_ref()],
    bump,
    constraint = third_party_user.agent == signer.key() @ ErrorCode::NotUserOwner,
)]
pub third_party_user: Account<'info, ThirdPartyUser>,
```

- **blacklist**: sets `UserStatus.status = Blacklisted` (reject if already
  blacklisted).
- **clear**: sets `UserStatus.status = None` and **`close`s** the
  `ThirdPartyUser` PDA, releasing the claim so the user can be re-onboarded.
  **Rejects a `Blacklisted` user** (`CannotClearBlacklistedUser`): otherwise a
  custodian could clear a TruFin-applied blacklist to `None` and then
  re-whitelist (since `status == None` passes the §6.3 eligibility check),
  bypassing the blacklist. Only a regular agent's `clear_user_status` can lift
  a blacklist. This guard is what actually enforces the §8 invariant for the
  clear path — the eligibility check alone only covers whitelisting.

> **Blacklist = permanent ban, clear = the reversible off-board path.** For a
> third-party agent these two operations are deliberately asymmetric: `clear`
> releases the claim and is the normal way to off-board a user, whereas a
> blacklist (whether applied by the custodian itself or by TruFin) is permanent
> *as far as the custodian is concerned* — a custodian can never reverse a
> blacklist. Lifting any blacklist is a TruFin-only action via the regular-agent
> `clear_user_status`.

### 6.5 `agent_release_third_party_user(user)` (regular agents only)

A regular agent can force-release **any** `ThirdPartyUser` claim, regardless of
which custodian owns it:

```rust
#[account(
    mut,
    seeds = [b"third_party_user", user.as_ref()],
    bump,
    close = signer,
)]
pub third_party_user: Account<'info, ThirdPartyUser>,
```

Signer must hold `[b"agent", signer]`. The handler `close`s the `ThirdPartyUser`
PDA and emits `ThirdPartyUserReleased { user, agent }` (the `agent` is the
custodian that owned the claim). **`UserStatus` is left untouched** — TruFin
already controls it via the regular-agent whitelist instructions.

This is the on-chain recovery path for an **orphaned** `ThirdPartyUser` — e.g.
one left behind when a custodian is removed (§9) — letting TruFin reclaim the
PDA rent and re-enable custodian onboarding for that user without needing the
(possibly removed or unavailable) owning custodian.

### 6.6 Events

All **new** events, so the existing `WhitelistingStatusChanged` event and its
handlers are left untouched:

- `ThirdPartyAgentAdded { agent }`, `ThirdPartyAgentRemoved { agent }`.
- `ThirdPartyWhitelistingStatusChanged { user, agent, old_status, new_status }`
  — emitted by all three third-party user instructions. The `agent` field is the
  on-chain attestation of *which* custodian made the change (the KYC record).
- `ThirdPartyUserReleased { user, agent }` — emitted by
  `agent_release_third_party_user`.

### 6.7 New error codes

- `UserNotEligibleForThirdPartyWhitelisting` — `UserStatus.status != None`.
- `NotUserOwner` — `ThirdPartyUser.agent != signer`.
- `CannotClearBlacklistedUser` — a third-party agent tried to clear a
  `Blacklisted` user (§6.4).

---

## 7. Authorization Matrix

| Action | Owner | Agent | Third-party agent |
|---|:---:|:---:|:---:|
| Add/remove agent | ✓ | ✓ | ✗ |
| Add/remove third-party agent | ✓ | ✓ | ✗ |
| Whitelist / blacklist / clear **any** user | ✓ | ✓ | ✗ |
| Whitelist a **fresh** user (`status == None`) | ✓ | ✓ | ✓ |
| Blacklist / clear a user **it owns** | ✓ | ✓ | ✓ |
| Touch a user it does **not** own | ✓ | ✓ | ✗ |
| Force-release **any** `ThirdPartyUser` claim (`agent_release_third_party_user`) | ✓ | ✓ | ✗ |

Regular agents retain full, unscoped power. Third-party agents are strictly
scoped to fresh users (to onboard) and to users they own (to manage).

---

## 8. Security Considerations & Edge Cases

- **Blacklist is sacrosanct.** A third-party agent can never move a user out of
  `Blacklisted`. Two checks together enforce this: the `status == None`
  eligibility check blocks re-**whitelisting** (§6.3), and the
  `CannotClearBlacklistedUser` guard blocks **clearing** a blacklisted user to
  `None` (§6.4) — without the latter a custodian could clear-then-re-whitelist
  to bypass the blacklist. A regular agent's blacklist therefore always
  overrides a custodian.
- **No poaching.** `ThirdPartyUser` uses `init`, so two custodians can never
  both claim the same user, and a custodian can never claim a TruFin-direct user.
- **`init_if_needed` reinitialisation.** `UserStatus` uses `init_if_needed`
  guarded by the `status == None` constraint, consistent with the existing
  whitelist instructions; verify no reinit path can resurrect a closed account
  with stale data.
- **Protocol-wide access (accepted trade-off).** The whitelist is one shared
  `UserStatus` used by the staker and every vault, and whitelisting is delegated
  to custodians — so a single custodian signature grants the user access
  protocol-wide. We only onboard custodians that contractually KYC their users
  and accept TruFin's blacklist override. TruFin's blacklist always wins
  (§6.4), and TruFin can release any claim or off-board a custodian at any time
  (§6.5, §9).
- **Orphaned `ThirdPartyUser` on agent removal.** `remove_third_party_agent`
  doesn't check for outstanding users, so removing a custodian can leave its
  `ThirdPartyUser` PDAs orphaned (blocking re-onboarding, locking the rent).
  TruFin still controls those users via the regular-agent instructions and can
  reclaim each orphan with `agent_release_third_party_user` (§6.5); the §9
  off-boarding order avoids creating them.
- **Pause.** Whitelisting isn't pause-gated; deposits remain pause-gated as
  before.

---

## 9. Off-boarding a Custodian

There is no on-chain iteration, so revoking an entire custodian is an off-chain
sweep. **The order is a hard requirement:** all of a custodian's users must be
released *before* the agent is removed.

1. Enumerate the custodian's users via `getProgramAccounts` on `ThirdPartyUser`
   filtered by `agent`.
2. For each, call `third_party_clear_user_status` (or
   `third_party_add_user_to_blacklist` as appropriate) to release the claim.
3. **Only then** call `remove_third_party_agent` to retire the role.

> **Why the order is mandatory.** `remove_third_party_agent` does not verify the
> agent owns no users (there is no cheap on-chain way to do so without a per-agent
> counter on the whitelist hot path). If the agent is removed first, its
> `ThirdPartyUser` PDAs are **orphaned**: the custodian-scoped instructions can
> no longer satisfy the `third_party_agent` seed check, so those users can't be
> released through the custodian path, and the `init` on `ThirdPartyUser` blocks
> re-onboarding.
>
> **Recovery if it happens.** TruFin still controls those users via the
> regular-agent instructions (`add_user_to_whitelist` / `_blacklist` /
> `clear_user_status`, which act on `UserStatus`), and can release each orphaned
> claim on-chain with **`agent_release_third_party_user`** (§6.5) — recovering
> the rent and re-enabling custodian onboarding. So the ordering protects against
> dust + operational friction, not loss of control.

> Note the limit: bulk revocation is **operational**, not atomic. If a custodian
> relationship must be killed instantly and globally, that requires a separate
> mechanism (e.g. a per-agent "active" flag checked at deposit time) — **out of
> scope** here; flag if needed.

---

## 10. Open Questions

- **Wallet type.** This design assumes each user address is an MPC/single-key
  wallet that can be a transaction `Signer`/fee-payer. A custodian holding funds
  in an on-chain multisig **vault PDA** cannot directly satisfy `deposit`'s
  signer/payer requirements and would need a separate design — confirm per
  custodian before integrating.

---

## 11. Out of Scope

- Omnibus integration (no code needed).
- Vault changes (none).
- Migration of existing `UserStatus` accounts (the design deliberately avoids it).
- On-chain KYC or identity attestations beyond the agent's signature + event.

---

## 12. Implementation Checklist (file map)

All changes are in `programs/staker/`. `init_if_needed` is already enabled in
this crate (used by the existing whitelist/deposit instructions), so no new
feature flags are needed. **Implemented** — all changes landed in a new
`src/instructions/third_party_whitelist.rs`.

- [x] `src/state/types.rs` — add `ThirdPartyAgent {}` and
      `ThirdPartyUser { agent: Pubkey }` (both `#[account] #[derive(InitSpace)]`).
      Leave `UserStatus` / `WhitelistUserStatus` unchanged.
- [x] `src/state/events.rs` — add `ThirdPartyAgentAdded`,
      `ThirdPartyAgentRemoved`, `ThirdPartyWhitelistingStatusChanged`,
      `ThirdPartyUserReleased` (§6.6).
- [x] `src/error.rs` — add `UserNotEligibleForThirdPartyWhitelisting`,
      `NotUserOwner`, `CannotClearBlacklistedUser` (§6.7).
- [x] `src/instructions/third_party_whitelist.rs` — the six `#[derive(Accounts)]`
      contexts + handlers (`add_third_party_agent`, `remove_third_party_agent`,
      `third_party_add_user_to_whitelist`, `third_party_add_user_to_blacklist`,
      `third_party_clear_user_status`, `agent_release_third_party_user`),
      mirroring the existing `whitelist.rs` structure, wired in
      `src/instructions/mod.rs`.
- [x] `src/lib.rs` — the six program entrypoints delegating to the handlers.
- [x] `tests/third_party_whitelist.test.ts` — see §13.

### 13. Test checklist

All implemented in `tests/third_party_whitelist.test.ts` (11 passing). The
whitelist/scoping tests need no stake pool; the deposit/pause tests are in a
nested suite that creates one.

- [x] Register/remove a third-party agent (regular agent only; a third-party
      agent or a random signer is rejected).
- [x] Atomic onboarding-and-deposit: one transaction `[ix1 agent-signed,
      ix2 user-signed]` whitelists then deposits for a fresh user.
- [x] Subsequent deposit: plain `deposit` succeeds; re-sending ix1 for an
      already-onboarded user fails (§5.1).
- [x] Eligibility: third-party whitelisting is rejected when the user is already
      `Whitelisted` (by TruFin **or another custodian**) or `Blacklisted`.
- [x] Scoping: a third-party agent can blacklist/clear a user **it owns** but is
      rejected (`NotUserOwner`) for a user owned by another agent or by TruFin.
- [x] Blacklist override: a regular agent can blacklist a custodian's user, and
      the custodian cannot then re-whitelist it (nor clear it —
      `CannotClearBlacklistedUser`, §6.4).
- [x] Clear closes `ThirdPartyUser` and allows clean re-onboarding.
- [x] Agent release: a regular agent can force-release any custodian's
      `ThirdPartyUser` claim; a non-agent is rejected (§6.5).
- [x] Pause: the atomic transaction reverts entirely when the program is paused
      (no whitelisted-but-not-deposited residue).

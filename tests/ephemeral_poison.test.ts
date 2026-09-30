import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  StakeProgram,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { Staker } from "../target/types/staker";
import {
  STAKE_POOL_PROGRAM_ID,
  initStaker,
  createStakePool,
  addUserToWhitelist,
  requestAirdrop,
  setupConfirmedProvider,
  getEvent,
  findEphemeralStakeAccount,
  findTransientStakeAccount,
  findValidatorStakeAccount,
  randomStakeSeed,
  moveEpochForwardAndUpdatePool,
} from "./helpers";
import { CreateStakePoolResponse } from "./stake_pool/types";

import { assert } from "chai";
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
} from "@solana/spl-token";

/**
 * Immunefi #84657 - hardcoded ephemeral stake seed.
 *
 * The validator-specific paths (deposit_to_specific_validator / increase / decrease) used to
 * hardcode the SPL Stake Pool ephemeral stake seed to 0. Because that ephemeral PDA is
 * pool-global and SPL creates it with Allocate+Assign (which tolerates a pre-funded address),
 * anyone could pre-fund the seed-0 PDA, let one legitimate increase leave a residual behind,
 * and permanently block every validator-specific path (system Allocate "already in use").
 *
 * The fix makes the ephemeral seed a required `ephemeral_seed: u64`, so callers pass a fresh
 * (e.g. random) seed on every call instead of a hardcoded 0. A poisoned address can no longer
 * permanently DoS the program: the stake manager routes around it by choosing a different seed
 * (no redeploy).
 *
 * This test proves:
 *   1. A specific ephemeral seed can still be poisoned (the residual persists) - the underlying
 *      SPL behaviour is unchanged.
 *   2. That poisoned seed alone no longer blocks the program: an increase with a *fresh* seed
 *      succeeds while the poisoned PDA is left untouched.
 */
describe("ephemeral stake seed poisoning is mitigated by seed rotation (Immunefi #84657)", () => {
  const provider = setupConfirmedProvider();
  const connection = provider.connection;

  let program: anchor.Program<Staker>;
  let owner: anchor.Wallet;
  let manager: Keypair;
  let stakeManager: Keypair;
  let user: Keypair;
  let attacker: Keypair;

  let stakerAuthorityPDA: PublicKey;
  let stakePoolInfo: CreateStakePoolResponse;
  let validatorVoteAccount: PublicKey;

  let transientStakeAccount: PublicKey; // seed-0 (the program keeps transient seed 0)
  let validatorStakeAccount: PublicKey;

  before(async () => {
    owner = provider.wallet as anchor.Wallet;
    manager = Keypair.generate();
    stakeManager = Keypair.generate();
    user = Keypair.generate();
    attacker = Keypair.generate();

    await requestAirdrop(connection, user.publicKey, 20);
    await requestAirdrop(connection, attacker.publicKey, 20);

    // pick a local validator vote account
    const voteAccounts = (await connection.getVoteAccounts())?.current;
    if (!voteAccounts || voteAccounts.length === 0) {
      throw new Error("No vote account found");
    }
    validatorVoteAccount = new anchor.web3.PublicKey(voteAccounts[0].votePubkey);

    program = await initStaker(owner.publicKey, stakeManager.publicKey);

    const staker = Keypair.generate();
    stakePoolInfo = await createStakePool(program.programId, manager, staker);

    [stakerAuthorityPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("staker")],
      program.programId
    );

    // hand the pool's staker authority to the program PDA
    const setStakerIx = new TransactionInstruction({
      programId: STAKE_POOL_PROGRAM_ID,
      keys: [
        { pubkey: stakePoolInfo.accounts.stakePoolAccount, isSigner: false, isWritable: true },
        { pubkey: manager.publicKey, isSigner: true, isWritable: false },
        { pubkey: stakerAuthorityPDA, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(Uint8Array.of(13)), // SetStaker
    });
    await provider.sendAndConfirm(new Transaction().add(setStakerIx), [manager]);

    validatorStakeAccount = findValidatorStakeAccount(
      validatorVoteAccount,
      stakePoolInfo.accounts.stakePoolAccount
    );

    await program.methods
      .addValidator(0)
      .accounts({
        stakePool: stakePoolInfo.accounts.stakePoolAccount,
        reserveStake: stakePoolInfo.accounts.reserveStakeAccount,
        withdrawAuthority: stakePoolInfo.accounts.withdrawAuthorityAccount,
        validatorList: stakePoolInfo.accounts.validatorListAccount,
        validatorStakeAccount,
        validatorVoteAccount,
      })
      .signers([owner.payer])
      .rpc();

    // whitelist the user and fund the reserve with a plain deposit
    await addUserToWhitelist(program, user.publicKey);

    const userPoolTokenATA = await getAssociatedTokenAddress(
      stakePoolInfo.accounts.poolMintAccount,
      user.publicKey
    );
    await provider.sendAndConfirm(
      new anchor.web3.Transaction().add(
        createAssociatedTokenAccountInstruction(
          user.publicKey,
          userPoolTokenATA,
          user.publicKey,
          stakePoolInfo.accounts.poolMintAccount
        )
      ),
      [user]
    );

    await program.methods
      .deposit(new BN(10 * LAMPORTS_PER_SOL))
      .accounts({
        user: user.publicKey,
        stakePool: stakePoolInfo.accounts.stakePoolAccount,
        depositAuthority: stakePoolInfo.accounts.depositAuthorityAccount,
        withdrawAuthority: stakePoolInfo.accounts.withdrawAuthorityAccount,
        poolReserve: stakePoolInfo.accounts.reserveStakeAccount,
        userPoolTokenAccount: userPoolTokenATA,
        feeTokenAccount: stakePoolInfo.accounts.feesTokenAccount,
        poolMint: stakePoolInfo.accounts.poolMintAccount,
        referralFeeTokenAccount: stakePoolInfo.accounts.feesTokenAccount,
      })
      .signers([user])
      .rpc();

    transientStakeAccount = findTransientStakeAccount(
      validatorVoteAccount,
      stakePoolInfo.accounts.stakePoolAccount,
      0
    );
  });

  // Accounts for increase/decreaseValidatorStake (identical set), ephemeral PDA from `ephemeralSeed`.
  const rebalanceAccounts = (ephemeralSeed: number | BN) => ({
    signer: stakeManager.publicKey,
    validatorVoteAccount,
    stakePool: stakePoolInfo.accounts.stakePoolAccount,
    reserveStake: stakePoolInfo.accounts.reserveStakeAccount,
    withdrawAuthority: stakePoolInfo.accounts.withdrawAuthorityAccount,
    validatorList: stakePoolInfo.accounts.validatorListAccount,
    validatorStakeAccount,
    transientStakeAccount,
    ephemeralStakeAccount: findEphemeralStakeAccount(
      stakePoolInfo.accounts.stakePoolAccount,
      ephemeralSeed
    ),
  });

  // Accounts for depositToSpecificValidator, ephemeral PDA from `ephemeralSeed`.
  const depositAccounts = (userPoolTokenAccount: PublicKey, ephemeralSeed: number | BN) => ({
    user: user.publicKey,
    stakePool: stakePoolInfo.accounts.stakePoolAccount,
    depositAuthority: stakePoolInfo.accounts.depositAuthorityAccount,
    withdrawAuthority: stakePoolInfo.accounts.withdrawAuthorityAccount,
    poolReserve: stakePoolInfo.accounts.reserveStakeAccount,
    userPoolTokenAccount,
    feeTokenAccount: stakePoolInfo.accounts.feesTokenAccount,
    poolMint: stakePoolInfo.accounts.poolMintAccount,
    referralFeeTokenAccount: stakePoolInfo.accounts.feesTokenAccount,
    validatorList: stakePoolInfo.accounts.validatorListAccount,
    ephemeralStakeAccount: findEphemeralStakeAccount(
      stakePoolInfo.accounts.stakePoolAccount,
      ephemeralSeed
    ),
    transientStakeAccount,
    validatorStakeAccount,
    validatorVoteAccount,
  });

  it("a poisoned ephemeral seed no longer permanently blocks rebalancing - the manager routes around it with a fresh seed", async () => {
    const stakeRent = await connection.getMinimumBalanceForRentExemption(StakeProgram.space);
    const minDelegation = (await connection.getStakeMinimumDelegation()).value;
    const prefund = stakeRent + minDelegation;

    // The seed the program used to hardcode; an attacker can still occupy this one address.
    const poisonSeed = 0;
    const ephemeralPoison = findEphemeralStakeAccount(
      stakePoolInfo.accounts.stakePoolAccount,
      poisonSeed
    );

    // 1. permissionless pre-fund of the poison seed's ephemeral PDA
    assert.isNull(await connection.getAccountInfo(ephemeralPoison));
    await provider.sendAndConfirm(
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: attacker.publicKey,
          toPubkey: ephemeralPoison,
          lamports: prefund,
        })
      ),
      [attacker]
    );

    // 2. a legitimate increase using that seed leaves the residual behind -> poisoned
    await provider.sendAndConfirm(
      await program.methods
        .increaseValidatorStake(new BN(2 * LAMPORTS_PER_SOL), new BN(poisonSeed))
        .accounts(rebalanceAccounts(poisonSeed))
        .transaction(),
      [stakeManager]
    );
    const poisoned = await connection.getAccountInfo(ephemeralPoison);
    assert.ok(poisoned, "ephemeral account was NOT drained - it persists");
    assert.isTrue(poisoned.owner.equals(StakeProgram.programId));
    assert.equal(poisoned.data.length, StakeProgram.space);
    assert.equal(poisoned.lamports, prefund);

    // 3. reusing the poisoned seed still fails (system Allocate "already in use")
    const blockedTx = await program.methods
      .increaseValidatorStake(new BN(1 * LAMPORTS_PER_SOL), new BN(poisonSeed))
      .accounts(rebalanceAccounts(poisonSeed))
      .transaction();
    blockedTx.feePayer = owner.publicKey;
    blockedTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    blockedTx.sign(owner.payer, stakeManager);
    const blockedSim = await connection.simulateTransaction(blockedTx);
    assert.ok(blockedSim.value.err, "reusing the poisoned seed must fail");
    assert.isTrue(
      (blockedSim.value.logs ?? []).some((l) => l.includes("already in use")),
      "expected an 'already in use' Allocate failure on the poisoned seed"
    );

    // Clear the transient created by the poison increase so the fresh-seed increase below is a
    // clean no-transient split. Otherwise it would merge into that transient, which fails once an
    // epoch rolls over (the transient is no longer activating) - flaky on slow CI runners.
    await moveEpochForwardAndUpdatePool(
      connection,
      stakePoolInfo.accounts,
      validatorVoteAccount
    );

    // 4. THE FIX: a fresh seed routes around the poison - no redeploy, increase succeeds
    const freshSeed = randomStakeSeed(); // fresh random u64 seed
    const sig = await provider.sendAndConfirm(
      await program.methods
        .increaseValidatorStake(new BN(1 * LAMPORTS_PER_SOL), freshSeed)
        .accounts(rebalanceAccounts(freshSeed))
        .transaction(),
      [stakeManager]
    );
    const event = await getEvent(program, sig, "validatorStakeIncreased");
    assert.ok(event, "increase with a fresh seed should emit the event");
    assert.strictEqual(event.data.validator.toBase58(), validatorVoteAccount.toBase58());

    // the fresh ephemeral was consumed cleanly (drained/deallocated), not left poisoned
    assert.isNull(
      await connection.getAccountInfo(
        findEphemeralStakeAccount(stakePoolInfo.accounts.stakePoolAccount, freshSeed)
      ),
      "fresh ephemeral should be drained after a normal increase"
    );

    // we routed around the poison, we did not clean it: it is still occupied
    const stillPoisoned = await connection.getAccountInfo(ephemeralPoison);
    assert.ok(stillPoisoned);
    assert.isTrue(stillPoisoned.owner.equals(StakeProgram.programId));
  });

  // seed 0 was poisoned by the increase test above and is never cleaned (the ephemeral is not
  // touched by epoch maintenance), so the two tests below reuse it to prove the other two
  // validator-specific paths use the same ephemeral seed and can route around a poisoned one.
  it("deposit_to_specific_validator: a poisoned seed is blocked, a fresh seed routes around it", async () => {
    const ephemeralPoison = findEphemeralStakeAccount(stakePoolInfo.accounts.stakePoolAccount, 0);
    const poisoned = await connection.getAccountInfo(ephemeralPoison);
    assert.ok(
      poisoned && poisoned.owner.equals(StakeProgram.programId),
      "precondition: seed 0 should still be poisoned"
    );

    // Clear any transient stake left by the previous test so the fresh-seed deposit below is a
    // clean no-transient split (epoch-timing independent on slow CI runners).
    await moveEpochForwardAndUpdatePool(
      connection,
      stakePoolInfo.accounts,
      validatorVoteAccount
    );

    const userPoolTokenATA = await getAssociatedTokenAddress(
      stakePoolInfo.accounts.poolMintAccount,
      user.publicKey
    );
    const depositAmount = new BN(2 * LAMPORTS_PER_SOL);

    // reusing the poisoned seed 0 -> fails at system Allocate before any funds move
    const blockedTx = await program.methods
      .depositToSpecificValidator(depositAmount, new BN(0))
      .accounts(depositAccounts(userPoolTokenATA, 0))
      .transaction();
    blockedTx.feePayer = user.publicKey;
    blockedTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    blockedTx.sign(user);
    const blockedSim = await connection.simulateTransaction(blockedTx);
    assert.ok(blockedSim.value.err, "deposit reusing the poisoned seed must fail");
    assert.isTrue(
      (blockedSim.value.logs ?? []).some((l) => l.includes("already in use")),
      "expected an 'already in use' Allocate failure on the poisoned seed"
    );

    // a fresh seed routes around the poison -> deposit succeeds
    const freshSeed = randomStakeSeed();
    const sig = await provider.sendAndConfirm(
      await program.methods
        .depositToSpecificValidator(depositAmount, freshSeed)
        .accounts(depositAccounts(userPoolTokenATA, freshSeed))
        .transaction(),
      [user]
    );
    const event = await getEvent(program, sig, "depositedToSpecificValidator");
    assert.ok(event, "deposit with a fresh seed should emit the event");
    assert.strictEqual(event.data.validator.toBase58(), validatorVoteAccount.toBase58());
  });

  it("decrease_validator_stake: a poisoned seed is blocked, a fresh seed routes around it", async () => {
    // Activate the stake accumulated above so there is active stake to decrease from. This also
    // confirms the seed-0 poison survives epoch maintenance (the ephemeral is never swept).
    await moveEpochForwardAndUpdatePool(
      connection,
      stakePoolInfo.accounts,
      validatorVoteAccount
    );
    const ephemeralPoison = findEphemeralStakeAccount(stakePoolInfo.accounts.stakePoolAccount, 0);
    const poisoned = await connection.getAccountInfo(ephemeralPoison);
    assert.ok(
      poisoned && poisoned.owner.equals(StakeProgram.programId),
      "seed 0 poison should survive the epoch"
    );

    const decreaseAmount = new BN(1 * LAMPORTS_PER_SOL);

    // reusing the poisoned seed 0 -> fails at system Allocate
    const blockedTx = await program.methods
      .decreaseValidatorStake(decreaseAmount, new BN(0))
      .accounts(rebalanceAccounts(0))
      .transaction();
    blockedTx.feePayer = owner.publicKey;
    blockedTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    blockedTx.sign(owner.payer, stakeManager);
    const blockedSim = await connection.simulateTransaction(blockedTx);
    assert.ok(blockedSim.value.err, "decrease reusing the poisoned seed must fail");
    assert.isTrue(
      (blockedSim.value.logs ?? []).some((l) => l.includes("already in use")),
      "expected an 'already in use' Allocate failure on the poisoned seed"
    );

    // a fresh seed routes around the poison -> decrease succeeds
    const freshSeed = randomStakeSeed();
    const sig = await provider.sendAndConfirm(
      await program.methods
        .decreaseValidatorStake(decreaseAmount, freshSeed)
        .accounts(rebalanceAccounts(freshSeed))
        .transaction(),
      [stakeManager]
    );
    const event = await getEvent(program, sig, "validatorStakeDecreased");
    assert.ok(event, "decrease with a fresh seed should emit the event");
    assert.strictEqual(event.data.validator.toBase58(), validatorVoteAccount.toBase58());
  });
});

import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram, StakeProgram } from '@solana/web3.js';
import { Staker } from "../target/types/staker";
import { STAKE_POOL_PROGRAM_ID, initStaker, createStakePool, updateValidatorListBalance, getStakePool, decodeValidatorListAccount, getEvent } from "./helpers";
import { CreateStakePoolResponse, StakeStatus } from "./stake_pool/types";

import { assert } from "chai";

describe("validators", () => {

  const provider = anchor.AnchorProvider.env();
  const connection = provider.connection;

  let program: anchor.Program<Staker>;
  let owner: anchor.Wallet;
  let manager: Keypair;
  let stakeManager: Keypair;
  let staker: Keypair;

  let stakerAuthorityPDA: PublicKey;
  let stakePoolInfo: CreateStakePoolResponse;

  let validatorVoteAccount: PublicKey;

  before(async () => {

    owner = provider.wallet as anchor.Wallet
    manager = Keypair.generate();
    stakeManager = Keypair.generate();
    staker = Keypair.generate();

    // get local validator account
    const voteAccountsAll = await connection.getVoteAccounts();
    let voteAccounts = voteAccountsAll?.current;
    if (voteAccounts?.length == 0) {
      throw new Error("No vote account found");
    }
    validatorVoteAccount = new anchor.web3.PublicKey(voteAccounts[0].votePubkey);
    program = await initStaker(owner.publicKey, stakeManager.publicKey);

    // create the stake pool with the manager and staker authorities
    stakePoolInfo = await createStakePool(
      program.programId,
      manager, // Manager authority
      staker, // The initial staker authority
    );

    [stakerAuthorityPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("staker")],
      program.programId
    );
  });


  it("Sets staker PDA as the new staker authorithy", async () => {
    // build the SetStaker instruction
    const setStakerIx = new TransactionInstruction({
      programId: STAKE_POOL_PROGRAM_ID,
      keys: [
        { pubkey: stakePoolInfo.accounts.stakePoolAccount, isSigner: false, isWritable: true }, // Stake pool
        { pubkey: manager.publicKey, isSigner: true, isWritable: false }, // Manager
        { pubkey: stakerAuthorityPDA, isSigner: false, isWritable: false }, // The new pool staker authority
      ],
      data: Buffer.from(Uint8Array.of(13)), // SetStaker instruction index
    });

    // send the SetStaker transaction
    const setStakerTx = new Transaction().add(setStakerIx);
    let tx = await provider.sendAndConfirm(setStakerTx, [manager]);
    assert.ok(tx);

    const pool = await getStakePool(connection, stakePoolInfo.accounts.stakePoolAccount);
    assert.equal(pool.staker.toBase58(), stakerAuthorityPDA.toBase58());
  });


  it("Non-owner adding a validator fails", async () => {
    const user = Keypair.generate()

    const [validatorStakeAccount] = PublicKey.findProgramAddressSync([
      validatorVoteAccount.toBuffer(),
      stakePoolInfo.accounts.stakePoolAccount.toBuffer(),
    ],
      STAKE_POOL_PROGRAM_ID
    );

    try {
      const validatorSeed = 0;
      await program.methods.addValidator(validatorSeed)
        .accountsPartial({
          owner: user.publicKey,
          stakePool: stakePoolInfo.accounts.stakePoolAccount,
          reserveStake: stakePoolInfo.accounts.reserveStakeAccount,
          withdrawAuthority: stakePoolInfo.accounts.withdrawAuthorityAccount,
          validatorList: stakePoolInfo.accounts.validatorListAccount,
          validatorStakeAccount: validatorStakeAccount,
          validatorVoteAccount: validatorVoteAccount,
        })
        .signers([user])
        .rpc();

      throw new Error("Add validator should fail");
    } catch (e) {
      assert.strictEqual(e.error.errorCode.code, "NotAuthorized");
    }
  });

  it("Adds a validator to the pool", async () => {
    // check that the pool has no validators
    const pool = await getStakePool(connection, stakePoolInfo.accounts.stakePoolAccount);
    const validatorList = await decodeValidatorListAccount(connection, pool.validatorList);
    assert.equal(validatorList.validators.length, 0);

    const [validatorStakeAccount] = PublicKey.findProgramAddressSync([
      validatorVoteAccount.toBuffer(),
      stakePoolInfo.accounts.stakePoolAccount.toBuffer(),
    ],
      STAKE_POOL_PROGRAM_ID
    );

    // send the addValidator transaction
    const validatorSeed = 0; // optional non-zero u32 seed used for generating the validator
    const tx = await program.methods.addValidator(validatorSeed)
      .accounts({
        stakePool: stakePoolInfo.accounts.stakePoolAccount,
        reserveStake: stakePoolInfo.accounts.reserveStakeAccount,
        withdrawAuthority: stakePoolInfo.accounts.withdrawAuthorityAccount,
        validatorList: stakePoolInfo.accounts.validatorListAccount,
        validatorStakeAccount: validatorStakeAccount,
        validatorVoteAccount: validatorVoteAccount,
      })
      .signers([owner.payer])
      .transaction();

    const txHash = await program.provider.sendAndConfirm(tx, [owner.payer], {
      commitment: "confirmed",
    })

    assert.ok(txHash);

    // verify the ValidatorAdded event was emitted with the correct data
    const event = await getEvent(program, txHash, "validatorAdded");
    assert.ok(event);
    assert.strictEqual(event.data.validator.toBase58(), validatorVoteAccount.toBase58());

    // verify the validator was added to the pool
    const poolAfter = await getStakePool(connection, stakePoolInfo.accounts.stakePoolAccount);
    const validatorListAfter = await decodeValidatorListAccount(connection, poolAfter.validatorList);
    assert.equal(validatorListAfter.validators.length, 1);
    assert.equal(validatorListAfter.validators[0].vote_account_address.toBase58(), validatorVoteAccount.toBase58());
  });


  it("Non-owner removing a validator fails", async () => {
    const user = Keypair.generate()

    const transientStakeSeed = 0;
    const [transientStakeAccount] = await PublicKey.findProgramAddressSync(
      [
        Buffer.from("transient"),
        validatorVoteAccount.toBuffer(),
        stakePoolInfo.accounts.stakePoolAccount.toBuffer(),
        new BN(transientStakeSeed).toArrayLike(Buffer, "le", 8),
      ],
      STAKE_POOL_PROGRAM_ID
    );

    // derive the validator stake account PDA
    const [validatorStakeAccount] = PublicKey.findProgramAddressSync([
      validatorVoteAccount.toBuffer(),
      stakePoolInfo.accounts.stakePoolAccount.toBuffer(),
    ],
      STAKE_POOL_PROGRAM_ID
    );

    try {
      await program.methods.removeValidator()
      .accountsPartial({
        owner: user.publicKey,
        stakePool: stakePoolInfo.accounts.stakePoolAccount,
        withdrawAuthority: stakePoolInfo.accounts.withdrawAuthorityAccount,
        validatorList: stakePoolInfo.accounts.validatorListAccount,
        validatorStakeAccount: validatorStakeAccount,
        transientStakeAccount: transientStakeAccount,
      })
      .signers([user])
      .rpc();

      throw new Error("Remove validator should fail");
    } catch (e) {
      assert.strictEqual(e.error.errorCode.code, "NotAuthorized");
    }
  });


  it("Removes a validator stake account from the pool", async () => {
    const transientStakeSeed = 0;
    const [transientStakeAccount] = await PublicKey.findProgramAddressSync(
      [
        Buffer.from("transient"),
        validatorVoteAccount.toBuffer(),
        stakePoolInfo.accounts.stakePoolAccount.toBuffer(),
        new BN(transientStakeSeed).toArrayLike(Buffer, "le", 8),
      ],
      STAKE_POOL_PROGRAM_ID
    );

    // derive the validator stake account PDA
    const [validatorStakeAccount] = PublicKey.findProgramAddressSync([
      validatorVoteAccount.toBuffer(),
      stakePoolInfo.accounts.stakePoolAccount.toBuffer(),
    ],
      STAKE_POOL_PROGRAM_ID
    );

    // send the removeValidator transaction
    const tx = await program.methods.removeValidator()
      .accounts({
        stakePool: stakePoolInfo.accounts.stakePoolAccount,
        withdrawAuthority: stakePoolInfo.accounts.withdrawAuthorityAccount,
        validatorList: stakePoolInfo.accounts.validatorListAccount,
        validatorStakeAccount: validatorStakeAccount,
        transientStakeAccount: transientStakeAccount,
      })
      .signers([owner.payer])
      .transaction();

    const txHash = await program.provider.sendAndConfirm(tx, [owner.payer], {
      commitment: "confirmed",
    })
    assert.ok(txHash);

    // verify the ValidatorRemoved event was emitted with the correct data
    const event = await getEvent(program, txHash, "validatorRemoved");
    assert.ok(event);
    assert.strictEqual(event.data.stakeAccount.toBase58(), validatorStakeAccount.toBase58());

    // verify that the validator stake account is deactivating
    const pool = await getStakePool(connection, stakePoolInfo.accounts.stakePoolAccount);
    const validatorList = await decodeValidatorListAccount(connection, pool.validatorList);
    const validator = validatorList.validators[0];
    assert.equal(validator.status, StakeStatus.DeactivatingValidator);
  });


  it("Cleanup removed validator entries", async () => {
    const user = Keypair.generate()

    // update the validator list to transition the deactivated stake accounts into ReadyForRemoval state
    await updateValidatorListBalance(
      validatorVoteAccount,
      stakePoolInfo.accounts.stakePoolAccount,
      stakePoolInfo.accounts.withdrawAuthorityAccount,
      stakePoolInfo.accounts.validatorListAccount,
      stakePoolInfo.accounts.reserveStakeAccount
    );

    // verify that the stake account is ReadyForRemoval
    const validatorListPre = await decodeValidatorListAccount(connection, stakePoolInfo.accounts.validatorListAccount);
    const validatorPre = validatorListPre.validators[0];
    assert.equal(validatorPre.status, StakeStatus.ReadyForRemoval);

    const cleanupIx = new TransactionInstruction({
      programId: STAKE_POOL_PROGRAM_ID,
      keys: [
        { pubkey: stakePoolInfo.accounts.stakePoolAccount, isSigner: false, isWritable: false }, // Stake pool
        { pubkey: stakePoolInfo.accounts.validatorListAccount, isSigner: false, isWritable: true }, // validator list
        { pubkey: user.publicKey, isSigner: true, isWritable: true }, // the user
      ],
      data: Buffer.from(Uint8Array.of(8)), // CleanupRemovedValidatorEntries instruction index
    });

    // send the CleanupRemovedValidatorEntries transaction
    const tx = new Transaction().add(cleanupIx);
    let txSig = await provider.sendAndConfirm(tx, [user]);
    assert.ok(txSig);

    // verify the validator was removed from the pool
    const validatorListPost = await decodeValidatorListAccount(connection, stakePoolInfo.accounts.validatorListAccount);
    assert.equal(validatorListPost.validators.length, 0);
  });

  it("AddValidator fails when signer has insufficient lamports", async () => {
    // Minimum amount of staked lamports required in a validator stake account to allow for merges
    // without a mismatch on credits observed
    const MINIMUM_ACTIVE_STAKE = 1_000_000;

    // Stake minimum delegation, currently 1 SOL in testnet, 1 lamport in devnet and mainnet
    const stakeMinDelegation = await connection.getStakeMinimumDelegation();

    // The minimum delegation must be at least the minimum active stake
    const minDelegation = Math.max(stakeMinDelegation.value, MINIMUM_ACTIVE_STAKE);
    const stakeAccountRent = await connection.getMinimumBalanceForRentExemption(StakeProgram.space);

    // The minimum balance required in a stake account is the minimum delegation plus rent
    const minLamportsRequired = minDelegation + stakeAccountRent;

    // Get current owner balance
    const currentBalance = await connection.getBalance(owner.publicKey);

    // We want the owner to have exactly minLamportsRequired - 1 lamports
    // after paying for the transaction fee.
    const targetBalance = minLamportsRequired - 1;
    const txFee = 5000; // Base fee per signature on Solana
    const drainAmount = currentBalance - targetBalance - txFee;

    if (drainAmount > 0) {
      const drainAccount = Keypair.generate();

      await provider.sendAndConfirm(
        new Transaction().add(
          SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: drainAccount.publicKey, lamports: drainAmount })
        ),
        [owner.payer]
      );
    }

    // Guard against fee estimation mismatch by draining any excess once more.
    let newBal = await connection.getBalance(owner.publicKey);
    if (newBal > targetBalance) {
      const extraDrain = newBal - targetBalance - txFee;
      if (extraDrain > 0) {
        const drainAccount2 = Keypair.generate();
        await provider.sendAndConfirm(
          new Transaction().add(
            SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: drainAccount2.publicKey, lamports: extraDrain })
          ),
          [owner.payer]
        );
        newBal = await connection.getBalance(owner.publicKey);
      }
    }

    console.log("newBal: ", newBal);
    console.log("target: ", targetBalance);

    const [validatorStakeAccount] = PublicKey.findProgramAddressSync([
      validatorVoteAccount.toBuffer(),
      stakePoolInfo.accounts.stakePoolAccount.toBuffer(),
    ],
      STAKE_POOL_PROGRAM_ID
    );

    try {
      // send the addValidator transaction
      const validatorSeed = 0; // optional non-zero u32 seed used for generating the validator
      await program.methods.addValidator(validatorSeed)
        .accounts({
          stakePool: stakePoolInfo.accounts.stakePoolAccount,
          reserveStake: stakePoolInfo.accounts.reserveStakeAccount,
          withdrawAuthority: stakePoolInfo.accounts.withdrawAuthorityAccount,
          validatorList: stakePoolInfo.accounts.validatorListAccount,
          validatorStakeAccount: validatorStakeAccount,
          validatorVoteAccount: validatorVoteAccount,
        })
        .signers([owner.payer])
        .rpc();

      throw new Error("Add validator should fail with insufficient lamports");
    } catch (e) {
      assert.ok(e.message.includes("insufficient lamports"));
    }
  });
});

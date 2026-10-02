import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, StakeProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { Staker } from "../target/types/staker";
import { STAKE_POOL_PROGRAM_ID, initStaker, createStakePool, addUserToWhitelist, requestAirdrop, getEvent, moveEpochForwardAndUpdatePool , setupConfirmedProvider} from "./helpers";
import { CreateStakePoolResponse } from "./stake_pool/types";

import { assert } from "chai";
import { createAssociatedTokenAccountInstruction, getAssociatedTokenAddress } from "@solana/spl-token";

describe("validator stake", () => {

  const provider = setupConfirmedProvider();
  const connection = provider.connection;

  let program: anchor.Program<Staker>;
  let owner: anchor.Wallet;
  let manager: Keypair;
  let stakeManager: Keypair;
  let user: Keypair;

  let stakerAuthorityPDA: PublicKey;
  let stakePoolInfo: CreateStakePoolResponse;

  let validatorVoteAccount: PublicKey;

  before(async () => {

    owner = provider.wallet as anchor.Wallet
    manager = Keypair.generate();
    stakeManager = Keypair.generate();
    user = Keypair.generate();
   
    // airdrop some SOL to the user
    await requestAirdrop(connection, user.publicKey, 20);

    // get local validator account
    const voteAccountsAll = await connection.getVoteAccounts();
    let voteAccounts = voteAccountsAll?.current;
    if (voteAccounts?.length == 0) {
      throw new Error("No vote account found");
    }
    validatorVoteAccount = new anchor.web3.PublicKey(voteAccounts[0].votePubkey);
    program = await initStaker(owner.publicKey, stakeManager.publicKey);

    // create the stake pool
    const staker = Keypair.generate(); // initial staker authority
    stakePoolInfo = await createStakePool(
      program.programId,
      manager,
      staker,
    );

    // derive the staker authority PDA
    [stakerAuthorityPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("staker")],
      program.programId
    );

    // sets stakerAuthorityPDA as the new staker authority of the pool
    const setStakerIx = new TransactionInstruction({
      programId: STAKE_POOL_PROGRAM_ID,
      keys: [
        { pubkey: stakePoolInfo.accounts.stakePoolAccount, isSigner: false, isWritable: true }, // Stake pool
        { pubkey: manager.publicKey, isSigner: true, isWritable: false }, // Manager
        { pubkey: stakerAuthorityPDA, isSigner: false, isWritable: false }, // The new pool staker authority
      ],
      data: Buffer.from(Uint8Array.of(13)), // SetStaker instruction index
    });

    const setStakerTx = new Transaction().add(setStakerIx);
    let tx = await provider.sendAndConfirm(setStakerTx, [manager]);
    assert.ok(tx);

    // derive the validator stake account for a new validator
    const [validatorStakeAccount] = PublicKey.findProgramAddressSync([
      validatorVoteAccount.toBuffer(),
      stakePoolInfo.accounts.stakePoolAccount.toBuffer(),
    ],
      STAKE_POOL_PROGRAM_ID
    );

    // add the validator to the pool
    const validatorSeed = 0;
    const addValidatorTx = await program.methods.addValidator(validatorSeed)
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
    assert.ok(addValidatorTx);

    // whitelist a user
    await addUserToWhitelist(program, user.publicKey);

    // user creates an associated token account to hold the stake pool tokens
    const userPoolTokenATA = await getAssociatedTokenAddress(
      stakePoolInfo.accounts.poolMintAccount,
      user.publicKey // Owner (user)
    );

    const createATATx = new anchor.web3.Transaction().add(
      createAssociatedTokenAccountInstruction(
        user.publicKey,
        userPoolTokenATA,
        user.publicKey,
        stakePoolInfo.accounts.poolMintAccount
      )
    );
    await provider.sendAndConfirm(createATATx, [user]);

    // user deposits 10 SOL to the pool reserve account
    const depositAmount = new BN(10 * LAMPORTS_PER_SOL);
    const depositTx = await program.methods
      .deposit(depositAmount)
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

      assert.ok(depositTx);
  });


  it("Non stake-manager trying to increase validator stake fails", async () => {
    const user  = Keypair.generate();

    // derive the transient stake account PDA
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

    // derive the ephemeral stake account PDA
    const ephemeralStakeSeed = 0;
    const [ephemeralStakeAccount] = await PublicKey.findProgramAddressSync(
      [
        Buffer.from("ephemeral"),
        stakePoolInfo.accounts.stakePoolAccount.toBuffer(),
        new BN(ephemeralStakeSeed).toArrayLike(Buffer, "le", 8),
      ],
      STAKE_POOL_PROGRAM_ID
    );
    
    // derive the stake account PDA
    const [validatorStakeAccount] = PublicKey.findProgramAddressSync([
      validatorVoteAccount.toBuffer(),
      stakePoolInfo.accounts.stakePoolAccount.toBuffer(),
    ],
      STAKE_POOL_PROGRAM_ID
    );

    try {
      await program.methods.increaseValidatorStake(new BN(1 * LAMPORTS_PER_SOL), new BN(0))
      .accounts({
        signer: user.publicKey,
        validatorVoteAccount: validatorVoteAccount,

        stakePool: stakePoolInfo.accounts.stakePoolAccount,
        reserveStake: stakePoolInfo.accounts.reserveStakeAccount,
        withdrawAuthority: stakePoolInfo.accounts.withdrawAuthorityAccount,
        validatorList: stakePoolInfo.accounts.validatorListAccount,
        validatorStakeAccount: validatorStakeAccount,
        transientStakeAccount: transientStakeAccount,
        ephemeralStakeAccount: ephemeralStakeAccount,
      })
      .signers([user])
      .rpc();

    } catch (e) {
      // the stake_manager pda deriverd with this user, who is not the stake manager, does not exist.
      assert.strictEqual(e.error.errorCode.code, "AccountNotInitialized");
    }
  });

  it("Stake-manager increases validator stake", async () => {
    // derive the transient stake account PDA
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

    // derive the ephemeral stake account PDA
    const ephemeralStakeSeed = 0;
    const [ephemeralStakeAccount] = await PublicKey.findProgramAddressSync(
      [
        Buffer.from("ephemeral"),
        stakePoolInfo.accounts.stakePoolAccount.toBuffer(),
        new BN(ephemeralStakeSeed).toArrayLike(Buffer, "le", 8),
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

    const poolReserveBalancePre = await connection.getBalance(
      stakePoolInfo.accounts.reserveStakeAccount
    );

    // the transient stake account should not have any balance before the increase
    const transientStakeAccountBalancePre = await connection.getBalance(transientStakeAccount);
    assert.equal(transientStakeAccountBalancePre, 0);

    // increase the validator stake by 3 SOL
    const stakeIncreaseAmount = new BN(3 * LAMPORTS_PER_SOL);
    const tx = await program.methods.increaseValidatorStake(stakeIncreaseAmount, new BN(0))
      .accounts({
        signer: stakeManager.publicKey,
        validatorVoteAccount: validatorVoteAccount,
        stakePool: stakePoolInfo.accounts.stakePoolAccount,
        reserveStake: stakePoolInfo.accounts.reserveStakeAccount,
        withdrawAuthority: stakePoolInfo.accounts.withdrawAuthorityAccount,
        validatorList: stakePoolInfo.accounts.validatorListAccount,
        validatorStakeAccount: validatorStakeAccount,
        transientStakeAccount: transientStakeAccount,
        ephemeralStakeAccount: ephemeralStakeAccount,
      })
      .signers([stakeManager]) // the stake manager must be the signer
      .transaction();

    const txHash = await program.provider.sendAndConfirm(tx, [stakeManager], {
      commitment: "confirmed",
    })
    assert.ok(txHash);

    // verify the ValidatorStakeIncreased event was emitted with the correct data
    const event = await getEvent(program, txHash, "validatorStakeIncreased");
    assert.ok(event);
    assert.strictEqual(event.data.validator.toBase58(), validatorVoteAccount.toBase58());
    assert.strictEqual(Number(event.data.amount), Number(stakeIncreaseAmount));
    
    // verify the transient stake account balance was increased by the stakeIncreaseAmount + rent
    let stakeAccountRent = await provider.connection.getMinimumBalanceForRentExemption(StakeProgram.space);
    const transientStakeAccountBalance = await connection.getBalance(transientStakeAccount);
    assert.equal(transientStakeAccountBalance, transientStakeAccountBalancePre + stakeIncreaseAmount.toNumber() + stakeAccountRent);
    
    // verify the reserve balance was decreased by the stakeIncreaseAmount + rent
    const poolReserveBalance = await connection.getBalance(stakePoolInfo.accounts.reserveStakeAccount);
    assert.equal(poolReserveBalance, poolReserveBalancePre - stakeIncreaseAmount.toNumber() - stakeAccountRent);
  });

  it("Increases validator stake again in the same epoch", async () => {
    // derive the transient stake account PDA
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

    // derive the ephemeral stake account PDA
    const ephemeralStakeSeed = 0;
    const [ephemeralStakeAccount] = await PublicKey.findProgramAddressSync(
      [
        Buffer.from("ephemeral"),
        stakePoolInfo.accounts.stakePoolAccount.toBuffer(),
        new BN(ephemeralStakeSeed).toArrayLike(Buffer, "le", 8),
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

    const poolReserveBalancePre = await connection.getBalance(
      stakePoolInfo.accounts.reserveStakeAccount
    );

    const transientStakeAccountBalancePre = await connection.getBalance(transientStakeAccount);

    // increase the validator stake by 2 SOL
    const stakeIncreaseAmount = new BN(2 * LAMPORTS_PER_SOL);
    const tx = await program.methods.increaseValidatorStake(stakeIncreaseAmount, new BN(0))
      .accounts({
        signer: stakeManager.publicKey,
        validatorVoteAccount: validatorVoteAccount,
        stakePool: stakePoolInfo.accounts.stakePoolAccount,
        reserveStake: stakePoolInfo.accounts.reserveStakeAccount,
        withdrawAuthority: stakePoolInfo.accounts.withdrawAuthorityAccount,
        validatorList: stakePoolInfo.accounts.validatorListAccount,
        validatorStakeAccount: validatorStakeAccount,
        transientStakeAccount: transientStakeAccount,
        ephemeralStakeAccount: ephemeralStakeAccount,
      })
      .signers([stakeManager]) // the stake manager must be the signer
      .transaction();

    const txHash = await program.provider.sendAndConfirm(tx, [stakeManager], {
      commitment: "confirmed",
    })
    assert.ok(txHash);

    // verify the ValidatorStakeIncreased event was emitted with the correct data
    const event = await getEvent(program, txHash, "validatorStakeIncreased");
    assert.ok(event);
    assert.strictEqual(event.data.validator.toBase58(), validatorVoteAccount.toBase58());
    assert.strictEqual(Number(event.data.amount), Number(stakeIncreaseAmount));
    
    // verify the transient stake account balance was increased by the stakeIncreaseAmount + rent
    let stakeAccountRent = await provider.connection.getMinimumBalanceForRentExemption(StakeProgram.space);
    const transientStakeAccountBalance = await connection.getBalance(transientStakeAccount);
    assert.equal(transientStakeAccountBalance, transientStakeAccountBalancePre + stakeIncreaseAmount.toNumber() + stakeAccountRent);
    
    // verify the reserve balance was decreased by the stakeIncreaseAmount + rent
    const poolReserveBalance = await connection.getBalance(stakePoolInfo.accounts.reserveStakeAccount);
    assert.equal(poolReserveBalance, poolReserveBalancePre - stakeIncreaseAmount.toNumber() - stakeAccountRent);
  });

  it("Transitions all transient stake to active stake", async () => {
    // derive the transient stake account PDA
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

    // get both stake accounts balance before updating the stake pool
    const transientStakeAccountPre = await connection.getBalance(transientStakeAccount);
    const stakeAccountBalancePre = await connection.getBalance(validatorStakeAccount);

    // move epoch forward to update the state of the stake accounts in the pool
    await moveEpochForwardAndUpdatePool(connection, stakePoolInfo.accounts, validatorVoteAccount);

    // verify the stake account balance was increased by the transient account balance minus the rent.
    const stakeAccountBalance = await connection.getBalance(validatorStakeAccount);
    let stakeAccountRent = await provider.connection.getMinimumBalanceForRentExemption(StakeProgram.space);
    assert.equal(stakeAccountBalance, stakeAccountBalancePre + transientStakeAccountPre - stakeAccountRent);

    // verify the transient stake account is now empty
    const transientStakeBalance = await connection.getBalance(transientStakeAccount);
    assert.equal(transientStakeBalance, 0);
  });


  it("Non stake-manager trying to decrease validator stake fails", async () => {
    const user  = Keypair.generate();

    // derive the PDAs
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

    const ephemeralStakeSeed = 0;
    const [ephemeralStakeAccount] = await PublicKey.findProgramAddressSync(
      [
        Buffer.from("ephemeral"),
        stakePoolInfo.accounts.stakePoolAccount.toBuffer(),
        new BN(ephemeralStakeSeed).toArrayLike(Buffer, "le", 8),
      ],
      STAKE_POOL_PROGRAM_ID
    );
    
    const [validatorStakeAccount] = PublicKey.findProgramAddressSync([
      validatorVoteAccount.toBuffer(),
      stakePoolInfo.accounts.stakePoolAccount.toBuffer(),
    ],
      STAKE_POOL_PROGRAM_ID
    );

    try {
      await program.methods.decreaseValidatorStake(new BN(2 * LAMPORTS_PER_SOL), new BN(0))
        .accounts({
          signer: user.publicKey,
          validatorVoteAccount: validatorVoteAccount,
          stakePool: stakePoolInfo.accounts.stakePoolAccount,
          reserveStake: stakePoolInfo.accounts.reserveStakeAccount,
          withdrawAuthority: stakePoolInfo.accounts.withdrawAuthorityAccount,
          validatorList: stakePoolInfo.accounts.validatorListAccount,
          validatorStakeAccount: validatorStakeAccount,
          transientStakeAccount: transientStakeAccount,
          ephemeralStakeAccount: ephemeralStakeAccount,
        })
        .signers([user]) // the stake manager must be the signer
        .rpc();
    } catch (e) {
      // the stake_manager pda deriverd with this user, who is not the stake manager, does not exist.
      assert.strictEqual(e.error.errorCode.code, "AccountNotInitialized");
    }
  });

  it("Decreases validator stake", async () => {
    // derive the transient stake account PDA
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

    // derive the ephemeral stake account PDA
    const ephemeralStakeSeed = 0;
    const [ephemeralStakeAccount] = await PublicKey.findProgramAddressSync(
      [
        Buffer.from("ephemeral"),
        stakePoolInfo.accounts.stakePoolAccount.toBuffer(),
        new BN(ephemeralStakeSeed).toArrayLike(Buffer, "le", 8),
      ],
      STAKE_POOL_PROGRAM_ID
    );

    // get stake account balances
    const stakeAccountBalancePre = await connection.getBalance(validatorStakeAccount);
    const transientStakeAccountBalancePre = await connection.getBalance(transientStakeAccount);
    assert.equal(transientStakeAccountBalancePre, 0);

    // decrease the validator stake by 2 SOL
    const stakeDecreaseAmount = new BN(2 * LAMPORTS_PER_SOL);
    const tx = await program.methods.decreaseValidatorStake(stakeDecreaseAmount, new BN(0))
      .accounts({
        signer: stakeManager.publicKey,
        validatorVoteAccount: validatorVoteAccount,
        stakePool: stakePoolInfo.accounts.stakePoolAccount,
        reserveStake: stakePoolInfo.accounts.reserveStakeAccount,
        withdrawAuthority: stakePoolInfo.accounts.withdrawAuthorityAccount,
        validatorList: stakePoolInfo.accounts.validatorListAccount,
        validatorStakeAccount: validatorStakeAccount,
        transientStakeAccount: transientStakeAccount,
        ephemeralStakeAccount: ephemeralStakeAccount,
      })
      .signers([stakeManager]) // the stake manager must be the signer
      .transaction();

    const txHash = await program.provider.sendAndConfirm(tx, [stakeManager], {
      commitment: "confirmed",
    })
    assert.ok(txHash);

    // verify the ValidatorStakeDecreased event was emitted with the correct data
    const event = await getEvent(program, txHash, "validatorStakeDecreased");
    assert.ok(event);
    assert.strictEqual(event.data.validator.toBase58(), validatorVoteAccount.toBase58());
    assert.strictEqual(Number(event.data.amount), Number(stakeDecreaseAmount));
    
    // verify the validator stake account balance decreased by the stakeDecreaseAmount
    const stakeAccountBalance = await connection.getBalance(validatorStakeAccount);
    assert.equal(stakeAccountBalance, stakeAccountBalancePre - stakeDecreaseAmount.toNumber());
    
    // verify the transient stake account balance increased by the stakeDecreaseAmount + rent
    let stakeAccountRent = await provider.connection.getMinimumBalanceForRentExemption(StakeProgram.space);
    const transientStakeAccountBalance = await connection.getBalance(transientStakeAccount);
    assert.equal(transientStakeAccountBalance, stakeDecreaseAmount.toNumber() + stakeAccountRent);
  });

  it("Decreasing additional stake in the same epoch fails", async () => {

    // derive the stake account PDAs
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

    const [validatorStakeAccount] = PublicKey.findProgramAddressSync([
      validatorVoteAccount.toBuffer(),
      stakePoolInfo.accounts.stakePoolAccount.toBuffer(),
    ],
      STAKE_POOL_PROGRAM_ID
    );

    const ephemeralStakeSeed = 0;
    const [ephemeralStakeAccount] = await PublicKey.findProgramAddressSync(
      [
        Buffer.from("ephemeral"),
        stakePoolInfo.accounts.stakePoolAccount.toBuffer(),
        new BN(ephemeralStakeSeed).toArrayLike(Buffer, "le", 8),
      ],
      STAKE_POOL_PROGRAM_ID
    );

    try {
      // try to decrease the validator stake by 1 SOL
      await program.methods.decreaseValidatorStake(new BN(1 * LAMPORTS_PER_SOL), new BN(0))
        .accounts({
          signer: stakeManager.publicKey,
          validatorVoteAccount: validatorVoteAccount,
          stakePool: stakePoolInfo.accounts.stakePoolAccount,
          reserveStake: stakePoolInfo.accounts.reserveStakeAccount,
          withdrawAuthority: stakePoolInfo.accounts.withdrawAuthorityAccount,
          validatorList: stakePoolInfo.accounts.validatorListAccount,
          validatorStakeAccount: validatorStakeAccount,
          transientStakeAccount: transientStakeAccount,
          ephemeralStakeAccount: ephemeralStakeAccount,
        })
        .simulate();
      } catch (e) {
        // verify that the transaction failed because the stake account have some transient stake
        const stakeAccountError = e.simulationResponse.logs.some((log: string) =>
          log.includes("stake account with transient stake cannot be merged")
        );
        assert.ok(stakeAccountError);
      }
  });

  it("Decreases the remaining validator stake in the next epoch", async () => {

    // move epoch and update pool to merge transient stake to active stake
    await moveEpochForwardAndUpdatePool(connection, stakePoolInfo.accounts, validatorVoteAccount);
        
    // derive the stake account PDAs
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

    const [validatorStakeAccount] = PublicKey.findProgramAddressSync([
      validatorVoteAccount.toBuffer(),
      stakePoolInfo.accounts.stakePoolAccount.toBuffer(),
    ],
      STAKE_POOL_PROGRAM_ID
    );

    const ephemeralStakeSeed = 0;
    const [ephemeralStakeAccount] = await PublicKey.findProgramAddressSync(
      [
        Buffer.from("ephemeral"),
        stakePoolInfo.accounts.stakePoolAccount.toBuffer(),
        new BN(ephemeralStakeSeed).toArrayLike(Buffer, "le", 8),
      ],
      STAKE_POOL_PROGRAM_ID
    );

    const stakeAccountBalancePre = await connection.getBalance(validatorStakeAccount);

    // decrease the stake account by the remaining stake (3 SOL + staking rewards) leaving the minimum stake of 1 SOL + rent
    const validatorMinStake =  1 * LAMPORTS_PER_SOL;
    const stakeAccountRent = await provider.connection.getMinimumBalanceForRentExemption(StakeProgram.space);
    const maxDecreaseAmount = new BN(stakeAccountBalancePre - validatorMinStake - stakeAccountRent);

    // decrease the validator stake by the maxDecreaseAmount
    const tx = await program.methods.decreaseValidatorStake(maxDecreaseAmount, new BN(0))
      .accounts({
        signer: stakeManager.publicKey,
        validatorVoteAccount: validatorVoteAccount,
        stakePool: stakePoolInfo.accounts.stakePoolAccount,
        reserveStake: stakePoolInfo.accounts.reserveStakeAccount,
        withdrawAuthority: stakePoolInfo.accounts.withdrawAuthorityAccount,
        validatorList: stakePoolInfo.accounts.validatorListAccount,
        validatorStakeAccount: validatorStakeAccount,
        transientStakeAccount: transientStakeAccount,
        ephemeralStakeAccount: ephemeralStakeAccount,
      })
      .signers([stakeManager]) // the stake manager must be the signer
      .transaction();

    const txHash = await program.provider.sendAndConfirm(tx, [stakeManager], {
      commitment: "confirmed",
    })
    assert.ok(txHash);

    // verify the ValidatorStakeDecreased event was emitted with the correct data
    const event = await getEvent(program, txHash, "validatorStakeDecreased");
    assert.ok(event);
    assert.strictEqual(event.data.validator.toBase58(), validatorVoteAccount.toBase58());
    assert.strictEqual(Number(event.data.amount), Number(maxDecreaseAmount));
    
    // verify the transient stake account balance increased by the stakeDecreaseAmount + rent
    const transientStakeAccountBalance = await connection.getBalance(transientStakeAccount);
    assert.equal(transientStakeAccountBalance, maxDecreaseAmount.toNumber() + stakeAccountRent);

    // verify the validator stake account balance decreased by the maxDecreaseAmount
    const stakeAccountBalance = await connection.getBalance(validatorStakeAccount);
    assert.equal(stakeAccountBalance, stakeAccountBalancePre - maxDecreaseAmount.toNumber());
  });

});

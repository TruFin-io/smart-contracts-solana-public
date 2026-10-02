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
  DeactivateStakeParams,
  WithdrawStakeParams,
} from "@solana/web3.js";
import { Staker } from "../target/types/staker";
import {
  STAKE_POOL_PROGRAM_ID,
  initStaker,
  requestAirdrop,
  moveEpochForward,
  createStakePool,
  addValidatorToStakePool,
  addUserToWhitelist,
  updateValidatorListBalance,
  updatePoolStakeBalance,
  getEvent,
  getStakePoolSharePrice,
  increaseAdditionalValidatorStake,
  decodeValidatorListAccount,
  getStakePool,
  setupConfirmedProvider,
} from "./helpers";
import { CreateStakePoolResponse } from "./stake_pool/types";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  getAccount,
} from "@solana/spl-token";

import { assert } from "chai";

describe("staking", () => {
  const provider = setupConfirmedProvider();
  const connection = provider.connection;

  let program: anchor.Program<Staker>;

  let owner: anchor.Wallet;
  let user: Keypair;
  let manager: Keypair; // the manager authority of the stake pool program
  let stakeManager: Keypair; // the stake manager authority of the staker program
  let staker: Keypair; // the staker pool staker authority
  let stakerInfoPDA: PublicKey;
  let validatorVoteAccount: PublicKey;
  let userWhitelistPDA: PublicKey;
  let userPoolTokenATA: PublicKey;
  let stakerAuthorityPDA: PublicKey;

  let stakePoolInfo: CreateStakePoolResponse;

  before(async () => {
    // get local validator account
    const voteAccountsAll = await connection.getVoteAccounts();
    let voteAccounts = voteAccountsAll?.current;
    if (voteAccounts?.length == 0) {
      throw new Error("No vote accounts found");
    }
    validatorVoteAccount = new anchor.web3.PublicKey(
      voteAccounts[0].votePubkey
    );

    // create the required keypairs
    owner = provider.wallet as anchor.Wallet;
    user = Keypair.generate();
    manager = Keypair.generate();
    stakeManager = Keypair.generate();
    staker = Keypair.generate();

    program = await initStaker(
      provider.wallet.publicKey,
      stakeManager.publicKey
    );

    // derive the staker authority PDA
    [stakerAuthorityPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("staker")],
      program.programId
    );

    // create the stake pool with the manager and staker authorities
    stakePoolInfo = await createStakePool(
      program.programId,
      manager, // Manager authority
      staker // Staker authority
    );

    // sets stakerAuthorityPDA as the new staker authority of the pool
    const setStakerIx = new TransactionInstruction({
      programId: STAKE_POOL_PROGRAM_ID,
      keys: [
        {
          pubkey: stakePoolInfo.accounts.stakePoolAccount,
          isSigner: false,
          isWritable: true,
        }, // Stake pool
        { pubkey: manager.publicKey, isSigner: true, isWritable: false }, // Manager
        { pubkey: stakerAuthorityPDA, isSigner: false, isWritable: false }, // The new pool staker authority
      ],
      data: Buffer.from(Uint8Array.of(13)), // SetStaker instruction index
    });

    const setStakerTx = new Transaction().add(setStakerIx);
    let tx = await provider.sendAndConfirm(setStakerTx, [manager]);
    assert.ok(tx);

    // derive the validator stake account for a new validator
    const [validatorStakeAccount] = PublicKey.findProgramAddressSync(
      [
        validatorVoteAccount.toBuffer(),
        stakePoolInfo.accounts.stakePoolAccount.toBuffer(),
      ],
      STAKE_POOL_PROGRAM_ID
    );

    const validatorSeed = 0;
    const addValidatorTx = await program.methods
      .addValidator(validatorSeed)
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

    // the account representing the user whitelist
    [userWhitelistPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("user"), user.publicKey.toBuffer()],
      program.programId
    );

    // airdrop some SOL to the user
    await requestAirdrop(connection, user.publicKey, 100);

    // the user creates an associated token account to hold the stake pool tokens
    userPoolTokenATA = await getAssociatedTokenAddress(
      stakePoolInfo.accounts.poolMintAccount,
      user.publicKey // Owner (user)
    );

    let tx2 = new anchor.web3.Transaction().add(
      createAssociatedTokenAccountInstruction(
        user.publicKey, // payer
        userPoolTokenATA, // the associated token account for the stake pool token of the user
        user.publicKey, // the user owning the new account
        stakePoolInfo.accounts.poolMintAccount // the stake pool token mint
      )
    );
    await provider.sendAndConfirm(tx2, [user]);
  });

  it("Deposit for a non-whitelisted user should fail", async () => {
    const depositAmount = new BN(20 * LAMPORTS_PER_SOL);
    try {
      await program.methods
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

      throw new Error("Non-whitelisted user should not be able to deposit");
    } catch (e) {
      assert.strictEqual(e.error.errorCode.code, "UserNotWhitelisted");
    }
  });

  it("Deposit SOL to the stake pool", async () => {
    // whitelist the user
    await addUserToWhitelist(program, user.publicKey);

    await moveEpochForward(connection, 1);

    // update the stake pool validator list
    await updateValidatorListBalance(
      validatorVoteAccount,
      stakePoolInfo.accounts.stakePoolAccount,
      stakePoolInfo.accounts.withdrawAuthorityAccount,
      stakePoolInfo.accounts.validatorListAccount,
      stakePoolInfo.accounts.reserveStakeAccount
    );

    // update the stake pool total stake balance
    await updatePoolStakeBalance(
      stakePoolInfo.accounts.stakePoolAccount,
      stakePoolInfo.accounts.withdrawAuthorityAccount,
      stakePoolInfo.accounts.validatorListAccount,
      stakePoolInfo.accounts.reserveStakeAccount,
      stakePoolInfo.accounts.poolMintAccount,
      stakePoolInfo.accounts.feesTokenAccount
    );

    // verify the user stake pool token balance before the deposit is 0
    const userBalancePre = await connection.getBalance(user.publicKey);
    const userPollTokenAccountPre = await getAccount(
      provider.connection,
      userPoolTokenATA
    );
    assert.equal(Number(userPollTokenAccountPre.amount), 0);

    const poolReserveBalancePre = await connection.getBalance(
      stakePoolInfo.accounts.reserveStakeAccount
    );

    // deposit 20 SOL
    const depositAmount = new BN(20 * LAMPORTS_PER_SOL);
    const tx = await program.methods
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
        referralFeeTokenAccount: stakePoolInfo.accounts.feesTokenAccount, // Same as fee for simplicity
      })
      .signers([user])
      .rpc();

    assert.ok(tx);

    // verify the user SOL balance was decreased by the deposit amount
    const userBalance = await connection.getBalance(user.publicKey);
    assert.equal(userBalance, userBalancePre - depositAmount.toNumber());

    // verify the stake pool reserve account balance was increased by the deposit amount
    const poolReserveBalance = await connection.getBalance(
      stakePoolInfo.accounts.reserveStakeAccount
    );
    assert.equal(
      poolReserveBalance,
      poolReserveBalancePre + depositAmount.toNumber()
    );

    // verify the user received the stake pool tokens
    const userPollTokenAccount = await getAccount(
      provider.connection,
      userPoolTokenATA
    );
    assert(Number(userPollTokenAccount.amount) > 0);
  });

  it("Emits Deposited event", async () => {
    const depositAmount = new BN(1 * LAMPORTS_PER_SOL);
    const tx = await program.methods
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
      .transaction();

    const txHash = await program.provider.sendAndConfirm(tx, [user], {
      commitment: "confirmed",
    });

    // verify the Deposited event was emitted with the correct data
    const event = await getEvent(program, txHash, "deposited");
    assert.ok(event);
    assert.strictEqual(event.data.amount.toNumber(), depositAmount.toNumber());
  });

  it("Deposit SOL directly to the stake pool should fail", async () => {
    const depositLamports = 3 * LAMPORTS_PER_SOL;

    const depositSolIx = new TransactionInstruction({
      programId: STAKE_POOL_PROGRAM_ID,
      keys: [
        {
          pubkey: stakePoolInfo.accounts.stakePoolAccount,
          isSigner: false,
          isWritable: true,
        }, // Stake pool
        {
          pubkey: stakePoolInfo.accounts.withdrawAuthorityAccount,
          isSigner: false,
          isWritable: false,
        }, // Stake pool withdraw authority PDA
        {
          pubkey: stakePoolInfo.accounts.reserveStakeAccount,
          isSigner: false,
          isWritable: true,
        }, // Reserve stake account, to deposit SOL
        { pubkey: user.publicKey, isSigner: true, isWritable: true }, // Account providing lamports to be deposited into the pool
        { pubkey: userPoolTokenATA, isSigner: false, isWritable: true }, // User account to receive pool tokens
        {
          pubkey: stakePoolInfo.accounts.feesTokenAccount,
          isSigner: false,
          isWritable: true,
        }, // Account to receive fee tokens
        {
          pubkey: stakePoolInfo.accounts.feesTokenAccount,
          isSigner: false,
          isWritable: true,
        }, // Account to receive a portion of fee as referral fees
        {
          pubkey: stakePoolInfo.accounts.poolMintAccount,
          isSigner: false,
          isWritable: true,
        }, // Pool token mint
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // System program
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // SPL Token program
        {
          pubkey: stakePoolInfo.accounts.depositAuthorityAccount,
          isSigner: false,
          isWritable: true,
        }, // (Optional) Stake pool sol deposit authority.
      ],
      data: Buffer.concat([
        Buffer.from(Uint8Array.of(14)), // Instruction index for DepositSol
        new BN(depositLamports).toArrayLike(Buffer, "le", 8), // Deposit amount (u64)
      ]),
    });

    // create the DepositSol transaction and sign it with the user's keypair
    const depositTx = new Transaction().add(depositSolIx);
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    depositTx.recentBlockhash = blockhash;
    depositTx.feePayer = user.publicKey;
    depositTx.sign(user);

    try {
      await provider.simulate(depositTx);
      throw new Error("Deposit SOL directly to the stake pool should fail");
    } catch (e) {
      // verify that the tx failed because the signature of the SOL Deposit authority was missing
      const missingSignature = e.simulationResponse.logs.some((log: string) =>
        log.includes("SOL Deposit authority signature missing")
      );
      assert.ok(
        missingSignature,
        "SOL Deposit authority signature should be missing"
      );
    }
  });

  it("Withdrawing 0.5 Pool Tokens worth of SOL from the stake pool directly should fail", async () => {
    // the amount of pool tokens to withdraw
    const withdrawAmount = 0.5 * LAMPORTS_PER_SOL;

    // construct the WithdrawSol instruction
    const withdrawSolIx = new TransactionInstruction({
      programId: STAKE_POOL_PROGRAM_ID,
      keys: [
        {
          pubkey: stakePoolInfo.accounts.stakePoolAccount,
          isSigner: false,
          isWritable: true,
        }, // Stake pool
        {
          pubkey: stakePoolInfo.accounts.withdrawAuthorityAccount,
          isSigner: false,
          isWritable: false,
        }, // Stake pool withdraw authority
        { pubkey: user.publicKey, isSigner: true, isWritable: false }, // User transfer authority
        { pubkey: userPoolTokenATA, isSigner: false, isWritable: true }, // User's pool token account
        {
          pubkey: stakePoolInfo.accounts.reserveStakeAccount,
          isSigner: false,
          isWritable: true,
        }, // Reserve stake account
        { pubkey: user.publicKey, isSigner: false, isWritable: true }, // Account receiving SOL
        {
          pubkey: stakePoolInfo.accounts.feesTokenAccount,
          isSigner: false,
          isWritable: true,
        }, // Fee token account
        {
          pubkey: stakePoolInfo.accounts.poolMintAccount,
          isSigner: false,
          isWritable: true,
        }, // Pool token mint account
        {
          pubkey: web3.SYSVAR_CLOCK_PUBKEY,
          isSigner: false,
          isWritable: false,
        }, // Clock sysvar
        {
          pubkey: web3.SYSVAR_STAKE_HISTORY_PUBKEY,
          isSigner: false,
          isWritable: false,
        }, // Stake history sysvar
        { pubkey: StakeProgram.programId, isSigner: false, isWritable: false }, // Stake program account
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // SPL Token program
        {
          pubkey: stakePoolInfo.accounts.withdrawAuthorityAccount,
          isSigner: false,
          isWritable: false,
        }, // optional stake pool withdraw authority
      ],
      data: Buffer.concat([
        Buffer.from(Uint8Array.of(16)), // Instruction index for WithdrawSol
        new BN(withdrawAmount).toArrayLike(Buffer, "le", 8), // Withdraw amount (u64)
      ]),
    });

    // send the WithdrawSol transaction
    const transaction = new Transaction().add(withdrawSolIx);
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = user.publicKey;
    try {
      await provider.simulate(transaction);
      throw new Error(
        "Withdrawing SOL directly from the stake pool should fail"
      );
    } catch (e) {
      // verify that the tx failed because the signature of the SOL withdraw authority was missing
      const missingSignature = e.simulationResponse.logs.some((log: string) =>
        log.includes("SOL withdraw authority signature missing")
      );
      assert.ok(
        missingSignature,
        "SOL Withdraw authority signature should be missing"
      );
    }
  });

  it("Withdraw stake directly from stake pool works regardless of withdraw authority", async () => {
    // the amount of pool tokens to withdraw
    const withdrawAmount = 0.5 * LAMPORTS_PER_SOL;
    const newStakeAccount = web3.Keypair.generate();

    const createAccountIx = SystemProgram.createAccount({
      fromPubkey: user.publicKey,
      newAccountPubkey: newStakeAccount.publicKey,
      lamports: await connection.getMinimumBalanceForRentExemption(
        StakeProgram.space
      ),
      space: StakeProgram.space,
      programId: StakeProgram.programId,
    });

    const tx = new Transaction().add(createAccountIx);

    await provider.sendAndConfirm(tx, [newStakeAccount, user], {
      commitment: "confirmed",
    });

    const poolReservePreBalance = await connection.getBalance(
      stakePoolInfo.accounts.reserveStakeAccount
    );
    const userPoolTokenPreBalance = await connection.getTokenAccountBalance(
      userPoolTokenATA
    );
    const sharePricePre = await getStakePoolSharePrice(
      connection,
      stakePoolInfo.accounts.stakePoolAccount
    );

    // construct the WithdrawStake instruction
    const withdrawStakeIx = new TransactionInstruction({
      programId: STAKE_POOL_PROGRAM_ID,
      keys: [
        {
          pubkey: stakePoolInfo.accounts.stakePoolAccount,
          isSigner: false,
          isWritable: true,
        },
        {
          pubkey: stakePoolInfo.accounts.validatorListAccount,
          isSigner: false,
          isWritable: true,
        },
        {
          pubkey: stakePoolInfo.accounts.withdrawAuthorityAccount,
          isSigner: false,
          isWritable: false,
        }, // Stake pool withdraw authority
        {
          pubkey: stakePoolInfo.accounts.reserveStakeAccount,
          isSigner: false,
          isWritable: true,
        }, // Validator or reserve stake account to split
        {
          pubkey: newStakeAccount.publicKey,
          isSigner: false,
          isWritable: true,
        },
        { pubkey: user.publicKey, isSigner: false, isWritable: false },
        { pubkey: user.publicKey, isSigner: true, isWritable: false },
        { pubkey: userPoolTokenATA, isSigner: false, isWritable: true },
        {
          pubkey: stakePoolInfo.accounts.feesTokenAccount,
          isSigner: false,
          isWritable: true,
        },
        {
          pubkey: stakePoolInfo.accounts.poolMintAccount,
          isSigner: false,
          isWritable: true,
        },
        {
          pubkey: web3.SYSVAR_CLOCK_PUBKEY,
          isSigner: false,
          isWritable: false,
        },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: StakeProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([
        Buffer.from(Uint8Array.of(10)), // Instruction index for WithdrawStake
        new BN(withdrawAmount).toArrayLike(Buffer, "le", 8), // Withdraw amount (u64)
      ]),
    });

    // send the WithdrawStake transaction
    const transaction = new Transaction().add(withdrawStakeIx);
    const txHash = await provider.sendAndConfirm(transaction, [user]);
    assert.ok(txHash);

    // the amount of stake withdrawn should be the amount of pool tokens withdrawn * the share price
    const sharePrice = await getStakePoolSharePrice(
      connection,
      stakePoolInfo.accounts.stakePoolAccount
    );
    const expectedStakeAmountWithdrawn = Math.floor(
      withdrawAmount * sharePricePre
    );

    // verify that the share price didn't change significantly after the withdrawal
    assert(Math.abs(sharePrice - sharePricePre) < 0.000000001);

    // verify that the validator stake account balance decreased by the expected amount
    const poolReserveBalance = await connection.getBalance(
      stakePoolInfo.accounts.reserveStakeAccount
    );

    const poolReserveStakeBalanceDiff =
      poolReservePreBalance - poolReserveBalance;
    // account for 1% withdrawal fee
    let fees =
      (BigInt(Math.floor(expectedStakeAmountWithdrawn)) *
        stakePoolInfo.stakePool.stakeWithdrawalFee.numerator) /
      stakePoolInfo.stakePool.stakeWithdrawalFee.denominator;
    assert.equal(
      BigInt(Math.floor(poolReserveStakeBalanceDiff)) + fees,
      BigInt(Math.floor(expectedStakeAmountWithdrawn))
    );

    // verify that user pool tokens were burned
    const userPoolTokenBalance = await connection.getTokenAccountBalance(
      userPoolTokenATA
    );
    const userPoolTokenDiff =
      Number(userPoolTokenPreBalance.value.amount) -
      Number(userPoolTokenBalance.value.amount);
    assert.equal(userPoolTokenDiff, withdrawAmount);

    // verify that the new stake account received the withdrawn stake
    const newStakeBalance = await connection.getBalance(
      newStakeAccount.publicKey
    );
    assert.equal(
      newStakeBalance,
      expectedStakeAmountWithdrawn -
        Number(fees) +
        (await connection.getMinimumBalanceForRentExemption(StakeProgram.space))
    );
  });

  it("Deposit SOL to a specific validator", async () => {
    await moveEpochForward(connection, 1);
    // update the stake pool validator list
    await updateValidatorListBalance(
      validatorVoteAccount,
      stakePoolInfo.accounts.stakePoolAccount,
      stakePoolInfo.accounts.withdrawAuthorityAccount,
      stakePoolInfo.accounts.validatorListAccount,
      stakePoolInfo.accounts.reserveStakeAccount
    );
    // update the stake pool total stake balance
    await updatePoolStakeBalance(
      stakePoolInfo.accounts.stakePoolAccount,
      stakePoolInfo.accounts.withdrawAuthorityAccount,
      stakePoolInfo.accounts.validatorListAccount,
      stakePoolInfo.accounts.reserveStakeAccount,
      stakePoolInfo.accounts.poolMintAccount,
      stakePoolInfo.accounts.feesTokenAccount
    );

    const userPollTokenAccountPre = await getAccount(
      provider.connection,
      userPoolTokenATA
    );

    const poolReserveBalancePre = await connection.getBalance(
      stakePoolInfo.accounts.reserveStakeAccount
    );

    const newStakeAccount = web3.Keypair.generate();
    const depositAmount = new BN(5 * LAMPORTS_PER_SOL);

    const stakeAccountTx = await provider.sendAndConfirm(
      new Transaction().add(
        StakeProgram.createAccount({
          fromPubkey: user.publicKey,
          /** Address of the new stake account */
          stakePubkey: newStakeAccount.publicKey,
          /** Authorities of the new stake account */
          authorized: {
            staker: user.publicKey,
            withdrawer: stakePoolInfo.accounts.depositAuthorityAccount,
          },
          /** Funding amount */
          lamports:
            (await connection.getMinimumBalanceForRentExemption(
              StakeProgram.space
            )) + depositAmount.toNumber(),
        })
      ),
      [user, newStakeAccount]
    );
    assert.ok(stakeAccountTx);

    let validatorList = await decodeValidatorListAccount(
      connection,
      stakePoolInfo.accounts.validatorListAccount
    );
    let firstValidator = validatorList.validators[0];
    const userBalancePre = await connection.getBalance(user.publicKey);

    // derive the transient stake account PDA
    const transientStakeSeed = 0;
    const [transientStakeAccount] = await PublicKey.findProgramAddressSync(
      [
        Buffer.from("transient"),
        firstValidator.vote_account_address.toBuffer(),
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
    const [validatorStakeAccount] = PublicKey.findProgramAddressSync(
      [
        firstValidator.vote_account_address.toBuffer(),
        stakePoolInfo.accounts.stakePoolAccount.toBuffer(),
      ],
      STAKE_POOL_PROGRAM_ID
    );

    // the transient stake account should not have any balance before the increase
    const transientStakeAccountBalancePre = await connection.getBalance(
      transientStakeAccount
    );
    assert.equal(transientStakeAccountBalancePre, 0);

    const tx = await program.methods
      .depositToSpecificValidator(depositAmount, new BN(0))
      .accounts({
        user: user.publicKey,
        stakePool: stakePoolInfo.accounts.stakePoolAccount,
        depositAuthority: stakePoolInfo.accounts.depositAuthorityAccount,
        withdrawAuthority: stakePoolInfo.accounts.withdrawAuthorityAccount,
        poolReserve: stakePoolInfo.accounts.reserveStakeAccount,
        userPoolTokenAccount: userPoolTokenATA,
        feeTokenAccount: stakePoolInfo.accounts.feesTokenAccount,
        poolMint: stakePoolInfo.accounts.poolMintAccount,
        referralFeeTokenAccount: stakePoolInfo.accounts.feesTokenAccount, // Same as fee for simplicity
        validatorList: stakePoolInfo.accounts.validatorListAccount,
        ephemeralStakeAccount: ephemeralStakeAccount,
        transientStakeAccount: transientStakeAccount,
        validatorStakeAccount: validatorStakeAccount,
        validatorVoteAccount: firstValidator.vote_account_address,
      })
      .signers([user])
      .transaction();

    const txHash = await program.provider.sendAndConfirm(tx, [user], {
      commitment: "confirmed",
    });

    // verify the Deposited event was emitted with the correct data
    const event = await getEvent(
      program,
      txHash,
      "depositedToSpecificValidator"
    );
    assert.strictEqual(event.data.amount.toNumber(), depositAmount.toNumber());
    assert.strictEqual(
      event.data.validator.toBase58(),
      firstValidator.vote_account_address.toBase58()
    );

    // verify the user SOL balance was decreased by the deposit amount
    let stakeAccountRent =
      await provider.connection.getMinimumBalanceForRentExemption(
        StakeProgram.space
      );
    const userBalance = await connection.getBalance(user.publicKey);
    assert.equal(
      userBalance,
      userBalancePre - depositAmount.toNumber() - stakeAccountRent
    );

    // verify the stake pool reserve account balance was not increased
    const poolReserveBalance = await connection.getBalance(
      stakePoolInfo.accounts.reserveStakeAccount
    );
    assert.equal(poolReserveBalance, poolReserveBalancePre);

    // verify the stake account received the deposit
    validatorList = await decodeValidatorListAccount(
      connection,
      stakePoolInfo.accounts.validatorListAccount
    );
    firstValidator = validatorList.validators[0];
    assert.equal(
      firstValidator.transient_stake_lamports,
      BigInt(depositAmount.toNumber()) + BigInt(stakeAccountRent)
    );

    // verify the user received the stake pool tokens
    const userPollTokenAccount = await getAccount(
      provider.connection,
      userPoolTokenATA
    );
    assert(
      Number(userPollTokenAccount.amount) > userPollTokenAccountPre.amount
    );
  });

  it("Deposit SOL to a non-existing validator should fail", async () => {
    const newStakeAccount = web3.Keypair.generate();
    const depositAmount = new BN(5 * LAMPORTS_PER_SOL);

    const stakeAccountTx = await provider.sendAndConfirm(
      new Transaction().add(
        StakeProgram.createAccount({
          fromPubkey: user.publicKey,
          stakePubkey: newStakeAccount.publicKey,
          authorized: {
            staker: user.publicKey,
            withdrawer: stakePoolInfo.accounts.depositAuthorityAccount,
          },
          lamports:
            (await connection.getMinimumBalanceForRentExemption(
              StakeProgram.space
            )) + depositAmount.toNumber(),
        })
      ),
      [user, newStakeAccount]
    );
    assert.ok(stakeAccountTx);

    let validatorList = await decodeValidatorListAccount(
      connection,
      stakePoolInfo.accounts.validatorListAccount
    );
    let firstValidator = validatorList.validators[0];
    let validator = Keypair.generate();

    // derive the transient stake account PDA
    const transientStakeSeed = 0;
    const [transientStakeAccount] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("transient"),
        firstValidator.vote_account_address.toBuffer(),
        stakePoolInfo.accounts.stakePoolAccount.toBuffer(),
        new BN(transientStakeSeed).toArrayLike(Buffer, "le", 8),
      ],
      STAKE_POOL_PROGRAM_ID
    );

    // derive the ephemeral stake account PDA
    const ephemeralStakeSeed = 0;
    const [ephemeralStakeAccount] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("ephemeral"),
        stakePoolInfo.accounts.stakePoolAccount.toBuffer(),
        new BN(ephemeralStakeSeed).toArrayLike(Buffer, "le", 8),
      ],
      STAKE_POOL_PROGRAM_ID
    );

    // derive the validator stake account PDA
    const [validatorStakeAccount] = PublicKey.findProgramAddressSync(
      [
        firstValidator.vote_account_address.toBuffer(),
        stakePoolInfo.accounts.stakePoolAccount.toBuffer(),
      ],
      STAKE_POOL_PROGRAM_ID
    );

    // the transient stake account should not have any balance before the increase
    const transientStakeAccountBalancePre = await connection.getBalance(
      transientStakeAccount
    );

    try {
      const tx = await program.methods
        .depositToSpecificValidator(depositAmount, new BN(0))
        .accounts({
          user: user.publicKey,
          stakePool: stakePoolInfo.accounts.stakePoolAccount,
          depositAuthority: stakePoolInfo.accounts.depositAuthorityAccount,
          withdrawAuthority: stakePoolInfo.accounts.withdrawAuthorityAccount,
          poolReserve: stakePoolInfo.accounts.reserveStakeAccount,
          userPoolTokenAccount: userPoolTokenATA,
          feeTokenAccount: stakePoolInfo.accounts.feesTokenAccount,
          poolMint: stakePoolInfo.accounts.poolMintAccount,
          referralFeeTokenAccount: stakePoolInfo.accounts.feesTokenAccount, // Same as fee for simplicity
          validatorList: stakePoolInfo.accounts.validatorListAccount,
          ephemeralStakeAccount: ephemeralStakeAccount,
          transientStakeAccount: transientStakeAccount,
          validatorStakeAccount: validatorStakeAccount,
          validatorVoteAccount: validator.publicKey,
        })
        .signers([user])
        .transaction();

      const txHash = await program.provider.sendAndConfirm(tx, [user], {
        commitment: "confirmed",
      });
      assert.ok(txHash);
    } catch (e) {
      const voteAccountError = e.logs.includes(
        `Program log: Vote account ${validator.publicKey} not found in stake pool`
      );
      assert.ok(voteAccountError);
    }
  });

  it("Withdraw active stake from stake pool", async () => {
    // fetch the staker info account
    [stakerInfoPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("staker_info")],
      program.programId
    );

    let stakeAccountRent =
      await provider.connection.getMinimumBalanceForRentExemption(
        StakeProgram.space
      );

    // the amount of pool tokens to withdraw
    const withdrawAmount = 1.1 * LAMPORTS_PER_SOL;
    const FIVE_SOL = BigInt(5 * LAMPORTS_PER_SOL);

    await moveEpochForward(connection, 1);

    let stakePool = await getStakePool(
      connection,
      stakePoolInfo.accounts.stakePoolAccount
    );
    let validatorList = await decodeValidatorListAccount(
      connection,
      stakePool.validatorList
    );
    let firstValidator = validatorList.validators[0];
    let stakerBalancePreRewards = stakePool.totalLamports;
    assert(
      firstValidator.transient_stake_lamports ==
        FIVE_SOL + BigInt(stakeAccountRent)
    );
    assert(
      firstValidator.active_stake_lamports <= BigInt(2 * LAMPORTS_PER_SOL)
    ); // ONE SOL + rent + some rewards

    // update the stake pool validator list
    await updateValidatorListBalance(
      validatorVoteAccount,
      stakePoolInfo.accounts.stakePoolAccount,
      stakePoolInfo.accounts.withdrawAuthorityAccount,
      stakePoolInfo.accounts.validatorListAccount,
      stakePoolInfo.accounts.reserveStakeAccount
    );

    // update the stake pool total stake balance
    await updatePoolStakeBalance(
      stakePoolInfo.accounts.stakePoolAccount,
      stakePoolInfo.accounts.withdrawAuthorityAccount,
      stakePoolInfo.accounts.validatorListAccount,
      stakePoolInfo.accounts.reserveStakeAccount,
      stakePoolInfo.accounts.poolMintAccount,
      stakePoolInfo.accounts.feesTokenAccount
    );

    let preBalanceValidator = firstValidator.active_stake_lamports;
    validatorList = await decodeValidatorListAccount(
      connection,
      stakePool.validatorList
    );
    firstValidator = validatorList.validators[0];
    stakePool = await getStakePool(
      connection,
      stakePoolInfo.accounts.stakePoolAccount
    );

    const rewards = stakePool.totalLamports - stakerBalancePreRewards;
    assert(firstValidator.transient_stake_lamports == BigInt(0));

    const current_stake: bigint =
      BigInt(FIVE_SOL) + BigInt(rewards) + BigInt(preBalanceValidator);
    assert(BigInt(firstValidator.active_stake_lamports) == current_stake);

    const newStakeAccount = web3.Keypair.generate();

    const createAccountIx = SystemProgram.createAccount({
      fromPubkey: user.publicKey,
      newAccountPubkey: newStakeAccount.publicKey,
      lamports: stakeAccountRent,
      space: StakeProgram.space,
      programId: StakeProgram.programId,
    });

    const tx = new Transaction().add(createAccountIx);

    await provider.sendAndConfirm(tx, [newStakeAccount, user], {
      commitment: "confirmed",
    });

    const [validatorStakeAccount] = PublicKey.findProgramAddressSync(
      [
        firstValidator.vote_account_address.toBuffer(),
        stakePoolInfo.accounts.stakePoolAccount.toBuffer(),
      ],
      STAKE_POOL_PROGRAM_ID
    );

    const stakerBalance = await connection.getBalance(validatorStakeAccount);
    const userPoolTokenPreBalance = await connection.getTokenAccountBalance(
      userPoolTokenATA
    );
    const sharePricePre = await getStakePoolSharePrice(
      connection,
      stakePoolInfo.accounts.stakePoolAccount
    );

    // construct the WithdrawSol instruction
    const withdrawStakeIx = new TransactionInstruction({
      programId: STAKE_POOL_PROGRAM_ID,
      keys: [
        {
          pubkey: stakePoolInfo.accounts.stakePoolAccount,
          isSigner: false,
          isWritable: true,
        },
        {
          pubkey: stakePoolInfo.accounts.validatorListAccount,
          isSigner: false,
          isWritable: true,
        },
        {
          pubkey: stakePoolInfo.accounts.withdrawAuthorityAccount,
          isSigner: false,
          isWritable: false,
        }, // Stake pool withdraw authority
        {
          pubkey: validatorStakeAccount,
          isSigner: false,
          isWritable: true,
        }, // Validator or reserve stake account to split
        {
          pubkey: newStakeAccount.publicKey,
          isSigner: false,
          isWritable: true,
        },
        { pubkey: user.publicKey, isSigner: false, isWritable: false },
        { pubkey: user.publicKey, isSigner: true, isWritable: false },
        { pubkey: userPoolTokenATA, isSigner: false, isWritable: true },
        {
          pubkey: stakePoolInfo.accounts.feesTokenAccount,
          isSigner: false,
          isWritable: true,
        },
        {
          pubkey: stakePoolInfo.accounts.poolMintAccount,
          isSigner: false,
          isWritable: true,
        },
        {
          pubkey: web3.SYSVAR_CLOCK_PUBKEY,
          isSigner: false,
          isWritable: false,
        },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: StakeProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([
        Buffer.from(Uint8Array.of(10)), // Instruction index for WithdrawStake
        new BN(withdrawAmount).toArrayLike(Buffer, "le", 8), // Withdraw amount (u64)
      ]),
    });

    // send the WithdrawStake transaction
    const transaction = new Transaction().add(withdrawStakeIx);
    const txHash = await provider.sendAndConfirm(transaction, [user]);
    assert.ok(txHash);

    // the amount of stake withdrawn should be the amount of pool tokens withdrawn * the share price
    const sharePrice = await getStakePoolSharePrice(
      connection,
      stakePoolInfo.accounts.stakePoolAccount
    );
    const expectedStakeAmountWithdrawn = Math.floor(
      withdrawAmount * sharePricePre
    );

    // verify that the share price didn't change significantly after the withdrawal
    assert(Math.abs(sharePrice - sharePricePre) < 0.000000001);

    // verify that the validator stake account balance decreased by the expected amount
    const newStakerBalance = await connection.getBalance(validatorStakeAccount);

    const stakerDifference = stakerBalance - newStakerBalance;
    // account for 1% withdrawal fee
    let fees = Math.round(
      (expectedStakeAmountWithdrawn *
        Number(stakePoolInfo.stakePool.stakeWithdrawalFee.numerator)) /
        Number(stakePoolInfo.stakePool.stakeWithdrawalFee.denominator)
    );
    assert.equal(
      BigInt(Math.floor(stakerDifference)) + BigInt(fees),
      BigInt(Math.floor(expectedStakeAmountWithdrawn))
    );

    // verify that user pool tokens were burned
    const userPoolTokenBalance = await connection.getTokenAccountBalance(
      userPoolTokenATA
    );
    const userPoolTokenDiff =
      Number(userPoolTokenPreBalance.value.amount) -
      Number(userPoolTokenBalance.value.amount);
    assert.equal(userPoolTokenDiff, withdrawAmount);

    // verify that the new stake account received the withdrawn stake
    const newStakeBalance = await connection.getBalance(
      newStakeAccount.publicKey
    );
    assert.equal(
      newStakeBalance,
      expectedStakeAmountWithdrawn - Number(fees) + stakeAccountRent
    );

    // deactive and withdraw the stake from the new stake account to the user's account
    let params: DeactivateStakeParams = {
      stakePubkey: newStakeAccount.publicKey,
      authorizedPubkey: user.publicKey,
    };
    let deactivateTx = StakeProgram.deactivate(params);
    let deactivateTxConfirmation = await provider.sendAndConfirm(
      deactivateTx,
      [user],
      {
        commitment: "confirmed",
      }
    );
    assert.ok(deactivateTxConfirmation);

    await moveEpochForward(connection, 2);

    const userBalancePre = await connection.getBalance(user.publicKey);
    const stakeAccountBalancePre = await connection.getBalance(
      newStakeAccount.publicKey
    );

    let withdrawParams: WithdrawStakeParams = {
      stakePubkey: newStakeAccount.publicKey,
      authorizedPubkey: user.publicKey,
      toPubkey: user.publicKey,
      lamports: Math.floor(stakeAccountBalancePre),
    };
    let withdrawTx = StakeProgram.withdraw(withdrawParams);

    let withdrawTxConfirmation = await provider.sendAndConfirm(
      withdrawTx,
      [user],
      {
        commitment: "confirmed",
      }
    );
    assert.ok(withdrawTxConfirmation);

    assert.equal(
      await connection.getBalance(user.publicKey),
      userBalancePre + stakeAccountBalancePre
    );
    assert.equal(await connection.getBalance(newStakeAccount.publicKey), 0);
  });


  it("Withdraw stake when the pool is not updated fails", async () => {
    // withdraw 10 TruSOL
    const withdrawAmountTruSOL = 10 * LAMPORTS_PER_SOL;
    const newStakeAccount = web3.Keypair.generate();

    const sharePricePre = await getStakePoolSharePrice(
      connection,
      stakePoolInfo.accounts.stakePoolAccount
    );

    // verify that the reserve account has enough SOL for this withdrawal
    const withdrawAmountSOL = withdrawAmountTruSOL * sharePricePre;
    assert(withdrawAmountSOL < await connection.getBalance(stakePoolInfo.accounts.reserveStakeAccount) + 2 * LAMPORTS_PER_SOL)

    // create a new stake account for the withdrawn stake
    const createAccountIx = SystemProgram.createAccount({
      fromPubkey: user.publicKey,
      newAccountPubkey: newStakeAccount.publicKey,
      lamports: await connection.getMinimumBalanceForRentExemption(
        StakeProgram.space
      ),
      space: StakeProgram.space,
      programId: StakeProgram.programId,
    });

    await provider.sendAndConfirm(
      new Transaction().add(createAccountIx), [newStakeAccount, user], {
      commitment: "confirmed",
    });

    // construct the WithdrawSol instruction
    const withdrawStakeIx = new TransactionInstruction({
      programId: STAKE_POOL_PROGRAM_ID,
      keys: [
        {
          pubkey: stakePoolInfo.accounts.stakePoolAccount,
          isSigner: false,
          isWritable: true,
        },
        {
          pubkey: stakePoolInfo.accounts.validatorListAccount,
          isSigner: false,
          isWritable: true,
        },
        {
          pubkey: stakePoolInfo.accounts.withdrawAuthorityAccount,
          isSigner: false,
          isWritable: false,
        }, // Stake pool withdraw authority
        {
          pubkey: stakePoolInfo.accounts.reserveStakeAccount,
          isSigner: false,
          isWritable: true,
        }, // Validator or reserve stake account to split
        {
          pubkey: newStakeAccount.publicKey,
          isSigner: false,
          isWritable: true,
        },
        { pubkey: user.publicKey, isSigner: false, isWritable: false },
        { pubkey: user.publicKey, isSigner: true, isWritable: false },
        { pubkey: userPoolTokenATA, isSigner: false, isWritable: true },
        {
          pubkey: stakePoolInfo.accounts.feesTokenAccount,
          isSigner: false,
          isWritable: true,
        },
        {
          pubkey: stakePoolInfo.accounts.poolMintAccount,
          isSigner: false,
          isWritable: true,
        },
        {
          pubkey: web3.SYSVAR_CLOCK_PUBKEY,
          isSigner: false,
          isWritable: false,
        },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: StakeProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([
        Buffer.from(Uint8Array.of(10)), // Instruction index for WithdrawStake
        new BN(withdrawAmountTruSOL).toArrayLike(Buffer, "le", 8),
      ]),
    });

    // simulate the WithdrawStake transaction
    const transaction = new Transaction().add(withdrawStakeIx);

    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = user.publicKey;
    transaction.sign(user);

    try {
      await provider.simulate(transaction);
      throw new Error("WithdrawStake should fail");
    } catch (e) {
      // verify that the tx failed because the pool was not updated
      const withdrawError = e.simulationResponse.logs.some((log: string) =>
        log.includes("Error: First update old validator stake account balances and then pool stake balance")
      );
      assert.ok(withdrawError);
    }
  });
  
});

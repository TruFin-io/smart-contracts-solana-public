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
  addValidatorToStakePool,
  addUserToWhitelist,
  getStakePoolSharePrice,
  increaseAdditionalValidatorStake,
  moveEpochForwardAndUpdatePool,
  setupConfirmedProvider,
} from "./helpers";
import { CreateStakePoolResponse} from "./stake_pool/types";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";

import { assert } from "chai";

describe("withdrawals", () => {

  const provider = setupConfirmedProvider();
  const connection = provider.connection;

  let program: anchor.Program<Staker>;

  let owner: anchor.Wallet;
  let user: Keypair;
  let manager: Keypair; // the manager authority of the stake pool program
  let stakeManager: Keypair; // the stake manager authority of the staker program
  let staker: Keypair; // the staker pool staker authority
  let validatorVoteAccount: PublicKey;
  let userPoolTokenATA: PublicKey;

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
      stakeManager.publicKey,
    );

    // create the stake pool with the manager and staker authorities
    stakePoolInfo = await createStakePool(
      program.programId,
      manager, // Manager authority
      staker // Staker authority
    );

    // add the default validator to the stake pool
    await addValidatorToStakePool(
      validatorVoteAccount,
      stakePoolInfo.accounts.stakePoolAccount, // stake pool
      owner.publicKey, // payer of the 1+ SOL needed for the stake account
      stakePoolInfo.accounts.reserveStakeAccount,
      staker, // Staker authority
      stakePoolInfo.accounts.withdrawAuthorityAccount, // staking pool PDA that can mint pool tokens, delegate and withdtaw stake
      stakePoolInfo.accounts.validatorListAccount // validator list PDA
    );

    // airdrop some SOL to the user
    await requestAirdrop(connection, user.publicKey, 100);

    // the user creates an associated token account to hold the stake pool tokens
    userPoolTokenATA = await getAssociatedTokenAddress(
      stakePoolInfo.accounts.poolMintAccount,
      user.publicKey // Owner (user)
    );

    const tx = new anchor.web3.Transaction().add(
      createAssociatedTokenAccountInstruction(
        user.publicKey, // payer
        userPoolTokenATA, // the associated token account for the stake pool token of the user
        user.publicKey, // the user owning the new account
        stakePoolInfo.accounts.poolMintAccount // the stake pool token mint
      )
    );
    await provider.sendAndConfirm(tx, [user]);

    // whitelist the user
    await addUserToWhitelist(program, user.publicKey);

    // "Deposit 20 SOL to the stake pool
    const depositAmount = new BN(20 * LAMPORTS_PER_SOL);
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
        referralFeeTokenAccount: stakePoolInfo.accounts.feesTokenAccount, // Same as fee for simplicity
      })
      .signers([user])
      .rpc();

    assert.ok(depositTx);
  });


  it("Withdraw stake from the reserve if no validator has staked SOL", async () => {
    // withdraw 1 TruSOL
    const withdrawAmount = 1 * LAMPORTS_PER_SOL;
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
        new BN(withdrawAmount).toArrayLike(Buffer, "le", 8), // Withdraw amount (u64)
      ]),
    });

    // send the WithdrawStake transaction
    const transaction = new Transaction().add(withdrawStakeIx);
    const txHash = await provider.sendAndConfirm(transaction, [user]);
    assert.ok(txHash);

    // verify that the reserve balance decreased
    const poolReserveBalance = await connection.getBalance(
      stakePoolInfo.accounts.reserveStakeAccount
    );
    assert(poolReserveBalance < poolReservePreBalance)
  });


  it("Withdraw stake from the reserve, when validator stake account is not the minimum, fails", async () => {

    // increase stake to a validator by 5 SOL
    await increaseAdditionalValidatorStake(
      5 * LAMPORTS_PER_SOL,
      stakePoolInfo.accounts.stakePoolAccount,
      staker,
      stakePoolInfo.accounts.withdrawAuthorityAccount,
      stakePoolInfo.accounts.validatorListAccount,
      validatorVoteAccount, 
      stakePoolInfo.accounts.reserveStakeAccount,
    );
    await moveEpochForwardAndUpdatePool(connection, stakePoolInfo.accounts, validatorVoteAccount);
    
    // withdraw 10 TruSOL, more than it's available in the validator stake account
    const withdrawAmount = 10 * LAMPORTS_PER_SOL;
    const newStakeAccount = web3.Keypair.generate();

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
        new BN(withdrawAmount).toArrayLike(Buffer, "le", 8), // Withdraw amount (u64)
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
      // verify that the tx failed because the balance of validator stake account is not equal to the minimum
      const withdrawError = e.simulationResponse.logs.some((log: string) =>
        log.includes("Error: The lamports in the validator stake account is not equal to the minimum")
      );
      assert.ok(withdrawError);
    }
  });

});

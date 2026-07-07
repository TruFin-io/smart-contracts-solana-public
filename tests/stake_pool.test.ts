
import * as borsh from "borsh";
import { AnchorProvider, web3, BN } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, Transaction, StakeProgram, TransactionInstruction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createMint,
  getAssociatedTokenAddress,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";


import { assert } from "chai";
import { moveEpochForward, getStakePool, requestAirdrop, getStakePoolSharePrice, updatePoolStakeBalance, updateValidatorListBalance, decodeValidatorListAccount , setupConfirmedProvider} from "./helpers";
import { Fee, InitializeData, InitializeSchema } from "./stake_pool/types";

describe("Stake Pool Test", () => {
  const provider = setupConfirmedProvider();
  const connection = provider.connection;

  // user accounts
  const wallet = provider.wallet;
  let user: Keypair;

  // Constants
  const STAKE_POOL_PROGRAM_ID = new PublicKey(
    "SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy"
  );
  const MAX_VALIDATORS = 100; // Maximum number of validators in the list
  const transientStakeSeed = 1; // Seed for validator transient stake account

  // Generate pool keypairs
  const stakePoolKeypair = Keypair.generate();
  const validatorListKeypair = Keypair.generate();
  const reserveStakeKeypair = Keypair.generate();

  // vote account of the local validator
  let validatorVoteAccount: PublicKey;

  // the pool withdraw authority (PDA)
  let poolWithdrawAuthority: PublicKey;

  // the pool token mint
  let poolMint: PublicKey;

  // the address of the account that will collect the pool fees for the pool manager.
  let poolFeesAddress: PublicKey;

  // rent-exempt fee for StakeStateV2 account
  let stakeAccountRent: number;

  // the associated token account holding the user's pool tokens
  let userPoolTokenATA: PublicKey;

  before(async () => {

    stakeAccountRent = await provider.connection.getMinimumBalanceForRentExemption(StakeProgram.space);

    // a user with some SOL
    user = Keypair.generate();
    await requestAirdrop(connection, user.publicKey, 100);

    // get the first validator vote account
    const voteAccountsAll = await provider.connection.getVoteAccounts();
    let voteAccounts = voteAccountsAll?.current;
    if (voteAccounts?.length == 0) {
      throw new Error("No vote accounts found");
    }
    validatorVoteAccount = new web3.PublicKey(voteAccounts[0].votePubkey);

    // derive the pool withdraw authority (PDA)
    [poolWithdrawAuthority] = PublicKey.findProgramAddressSync(
      [stakePoolKeypair.publicKey.toBuffer(), Buffer.from("withdraw")],
      STAKE_POOL_PROGRAM_ID
    );

    // create the pool token mint
    poolMint = await createMint(
      connection,
      wallet.payer,
      poolWithdrawAuthority, // Mint authority must be set as the withdraw authority PDA
      null, // Freeze authority
      9 // Decimals
    );

    // create the manager's associated token account that will collect fees
    const poolFeesAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      wallet.payer,
      poolMint,
      wallet.publicKey // the owner of the fees account
    );
    poolFeesAddress = poolFeesAccount.address;

    // Calculate rent-exempt balances
    const validatorListSize = 4 + 5 + 73 * MAX_VALIDATORS;  // 73 bytes for each ValidatorStakeInfo + header
    const validatorListRent = await connection.getMinimumBalanceForRentExemption(validatorListSize);
    const stakePoolAccountRent = await connection.getMinimumBalanceForRentExemption(8 + 656);
   
    // build transaction to create accounts
    const transaction = new Transaction().add(
      // Create Stake Pool account
      SystemProgram.createAccount({
        fromPubkey: wallet.publicKey,
        newAccountPubkey: stakePoolKeypair.publicKey,
        space: 8 + 656, // std::mem::size_of::<StakePool>() gives 656
        lamports: stakePoolAccountRent,
        programId: STAKE_POOL_PROGRAM_ID,
      }),
      // Create Validator List account
      SystemProgram.createAccount({
        fromPubkey: wallet.publicKey,
        newAccountPubkey: validatorListKeypair.publicKey,
        space: validatorListSize,
        lamports: validatorListRent,
        programId: STAKE_POOL_PROGRAM_ID,
      }),
      // Create Reserve Stake account
      StakeProgram.createAccount({
        fromPubkey: wallet.publicKey,
        stakePubkey: reserveStakeKeypair.publicKey,
        lamports: stakeAccountRent,
        authorized: {
          staker: poolWithdrawAuthority,
          withdrawer: poolWithdrawAuthority,
        },
        lockup: {
          custodian: PublicKey.default,
          epoch: 0,
          unixTimestamp: 0,
        },
      })
    );

    // send create accounts transaction
    const txHash = await provider.sendAndConfirm(transaction, [
      stakePoolKeypair,
      validatorListKeypair,
      reserveStakeKeypair,
      wallet.payer
    ], {
      commitment: "confirmed",
    });


    // the user creates an associated token account to hold their stake pool tokens
    userPoolTokenATA = await getAssociatedTokenAddress(
      poolMint,
      user.publicKey   // Owner (user)
    );
    
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        user.publicKey, // payer
        userPoolTokenATA, // the associated token account for the stake pool token of the user
        user.publicKey, // the user owning the new account
        poolMint, // the stake pool token mint
      )
    );
    await provider.sendAndConfirm(tx, [user]);

    console.log("Stake Pool Account:", stakePoolKeypair.publicKey.toBase58());
    console.log("Wallet/Owner/Manager:", wallet.publicKey.toBase58());
    console.log("User:", user.publicKey.toBase58());
    console.log("Validator List Account:", validatorListKeypair.publicKey.toBase58());
    console.log("Reserve Stake Account:", reserveStakeKeypair.publicKey.toBase58());
    console.log("Pool Mint:", poolMint.toBase58());
    console.log("Pool Fees Account:", poolFeesAccount.address.toBase58());
    console.log("Withdraw Authority:", poolWithdrawAuthority.toBase58());

    assert.ok(txHash);

  }); // end before hook


  it("Creates a stake pool", async () => {

    // Construct the Initialize instruction
    const instructionData = new InitializeData({
      instruction: 0, // Instruction index for `Initialize`
      fee: new Fee({ numerator: 5, denominator: 100 }),
      withdrawalFee: new Fee({ numerator: 0, denominator: 100 }),
      depositFee: new Fee({ numerator: 1, denominator: 100 }),
      referralFee: 0, // 0% of deposit fee goes to referrer
      maxValidators: MAX_VALIDATORS,
    });

    const data = Buffer.from(borsh.serialize(InitializeSchema, instructionData));

    const initializeIx = new TransactionInstruction({
      programId: STAKE_POOL_PROGRAM_ID,
      keys: [
        { pubkey: stakePoolKeypair.publicKey, isSigner: true, isWritable: true }, // Stake pool account
        { pubkey: wallet.publicKey, isSigner: true, isWritable: false }, // Manager
        { pubkey: wallet.publicKey, isSigner: false, isWritable: false }, // Staker
        { pubkey: poolWithdrawAuthority, isSigner: false, isWritable: false }, // Stake pool withdraw authority
        { pubkey: validatorListKeypair.publicKey, isSigner: false, isWritable: true }, // Uninitialized Validator stake list storage account
        { pubkey: reserveStakeKeypair.publicKey, isSigner: false, isWritable: false }, // Reserve stake account (must me initialized and have zero balance)
        { pubkey: poolMint, isSigner: false, isWritable: true }, // Pool token mint (owned by withdraw authority)
        { pubkey: poolFeesAddress, isSigner: false, isWritable: true }, // pool token account to receive fees for the manager
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // Token program
        // (Optional) Deposit authority that must sign all deposits.
      ],
      data,
    });

    // Add the instruction to a transaction
    const initTransaction = new Transaction().add(initializeIx);

    // Send and confirm the transaction
    const txHash = await provider.sendAndConfirm(initTransaction, [stakePoolKeypair, wallet.payer], {
      commitment: "confirmed",
    });

    assert.ok(txHash);

    // verify that the stake pool balance and the pool token supply are zero
    const stakePool = await getStakePool(connection, stakePoolKeypair.publicKey);
    assert.equal(Number(stakePool.totalLamports), 0);
    assert.equal(Number(stakePool.poolTokenSupply), 0);

    // verify that the fees account balance is zero
    const feesBalance = await provider.connection.getTokenAccountBalance(poolFeesAddress);
    assert.equal(Number(feesBalance.value.amount), 0);
  });


  it("Adds a validator to the stake pool", async () => {
    // Transfer SOL to the pool reserve account to fund the validator stake account
    const depositTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: reserveStakeKeypair.publicKey,
        lamports: 1 * LAMPORTS_PER_SOL + stakeAccountRent,
      })
    );
    await provider.sendAndConfirm(depositTx, []);

    const [validatorStakeAccount] = PublicKey.findProgramAddressSync([
      validatorVoteAccount.toBuffer(),
      stakePoolKeypair.publicKey.toBuffer(),
    ],
      STAKE_POOL_PROGRAM_ID
    );

    // build the AddValidatorToPool instruction
    const seed = 0;
    const addValidatorIx = new TransactionInstruction({
      programId: STAKE_POOL_PROGRAM_ID,
      keys: [
        { pubkey: stakePoolKeypair.publicKey, isSigner: false, isWritable: true }, // Stake pool
        { pubkey: wallet.publicKey, isSigner: true, isWritable: false }, // Staker
        { pubkey: reserveStakeKeypair.publicKey, isSigner: false, isWritable: true }, // Reserve stake account
        { pubkey: poolWithdrawAuthority, isSigner: false, isWritable: false }, // Withdraw authority
        { pubkey: validatorListKeypair.publicKey, isSigner: false, isWritable: true }, // Validator stake list account
        { pubkey: validatorStakeAccount, isSigner: false, isWritable: true }, // Stake account to add to the pool
        { pubkey: validatorVoteAccount, isSigner: false, isWritable: false }, // Validator vote account
        { pubkey: web3.SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }, // Rent sysvar
        { pubkey: web3.SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false }, // Clock sysvar
        { pubkey: web3.SYSVAR_STAKE_HISTORY_PUBKEY, isSigner: false, isWritable: false }, // Stake history sysvar
        { pubkey: new PublicKey("StakeConfig11111111111111111111111111111111"), isSigner: false, isWritable: false }, // Stake config
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // System program
        { pubkey: StakeProgram.programId, isSigner: false, isWritable: false }, // Stake program
      ],
      data: Buffer.from(Uint8Array.of(1, ...new Uint8Array(new Uint32Array([seed]).buffer))), // AddValidatorToPool instruction with seed
    });

  

    console.log("stakePool:", stakePoolKeypair.publicKey.toBase58());
    console.log("Staker Authority", wallet.publicKey.toBase58());
    console.log("Reserve account", reserveStakeKeypair.publicKey.toBase58());
    console.log("poolWithdrawAuthority", poolWithdrawAuthority.toBase58());
    console.log("validatorList", validatorListKeypair.publicKey.toBase58());
    console.log("validatorStakeAccount", validatorStakeAccount.toBase58());
    console.log("validatorVoteAccount", validatorVoteAccount.toBase58());
    console.log("SYSVAR_RENT_PUBKEY", web3.SYSVAR_RENT_PUBKEY.toBase58());
    console.log("SYSVAR_CLOCK_PUBKEY", web3.SYSVAR_CLOCK_PUBKEY.toBase58());
    console.log("SYSVAR_STAKE_HISTORY_PUBKEY", web3.SYSVAR_STAKE_HISTORY_PUBKEY.toBase58());
    console.log("StakeConfig11111111111111111111111111111111");
    console.log("SystemProgram.programId", SystemProgram.programId.toBase58());
    console.log("StakeProgram.programId", StakeProgram.programId.toBase58());


    console.log(">>> addValidatorIx data:", addValidatorIx.data);


    // send the transaction
    const addValidatorTx = new Transaction().add(addValidatorIx);
    const txHash2 = await provider.sendAndConfirm(addValidatorTx, []);
    assert.ok(txHash2);

    // verify that the stake pool balance is zero, despite the 1 SOL deposit
    const stakePool = await getStakePool(connection, stakePoolKeypair.publicKey);
    assert.equal(Number(stakePool.totalLamports), 0);

  });


  it("Deposits 3 SOL into the stake pool", async () => {
    const depositLamports = 3 * LAMPORTS_PER_SOL; // Deposit 3 SOL
  
    // verify that the stake pool balance and the pool token supply are zero before the deposit
    const stakePoolPre = await getStakePool(connection, stakePoolKeypair.publicKey);
    assert.equal(Number(stakePoolPre.totalLamports), 0);
    assert.equal(Number(stakePoolPre.poolTokenSupply), 0);

    // verify that the reserve stake account is empty before the deposit (minus the rent)
    assert.equal( await connection.getBalance(reserveStakeKeypair.publicKey) - stakeAccountRent, 0);

    // verify that the pool fees account is empty before the deposit
    const feesBalancePre = await provider.connection.getTokenAccountBalance(poolFeesAddress);
    assert.equal(Number(feesBalancePre.value.amount), 0);

    // verify that the user has no pool tokens before the deposit
    const userPoolTokenPreBalance = await connection.getTokenAccountBalance(userPoolTokenATA);
    assert.equal(Number(userPoolTokenPreBalance.value.amount), 0);

    // Construct the DepositSol instruction
    const depositSolIx = new TransactionInstruction({
      programId: STAKE_POOL_PROGRAM_ID,
      keys: [
        { pubkey: stakePoolKeypair.publicKey, isSigner: false, isWritable: true }, // Stake pool
        { pubkey: poolWithdrawAuthority, isSigner: false, isWritable: false }, // Stake pool withdraw authority PDA
        { pubkey: reserveStakeKeypair.publicKey, isSigner: false, isWritable: true }, // Reserve stake account, to deposit SOL
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true }, // Account providing lamports to be deposited into the pool
        { pubkey: userPoolTokenATA, isSigner: false, isWritable: true }, // User account to receive pool tokens
        { pubkey: poolFeesAddress, isSigner: false, isWritable: true }, // Account to receive fee tokens
        { pubkey: poolFeesAddress, isSigner: false, isWritable: true }, // Account to receive a portion of fee as referral fees
        { pubkey: poolMint, isSigner: false, isWritable: true }, // Pool token mint
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // System program
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // SPL Token program
        { pubkey: user.publicKey, isSigner: true, isWritable: true }, // The user
      ],
      data: Buffer.concat([
        Buffer.from(Uint8Array.of(14)), // Instruction index for DepositSol
        new BN(depositLamports).toArrayLike(Buffer, "le", 8), // Deposit amount (u64)
      ]),
    });
  
    // send the DepositSol transaction
    const transaction = new Transaction().add(depositSolIx);
    const txHash = await provider.sendAndConfirm(transaction, [user])
    assert.ok(txHash);

    // verify that the user received the pool's tokens
    const userPoolTokenBalance = await connection.getTokenAccountBalance(userPoolTokenATA);
    assert(Number(userPoolTokenBalance.value.amount) > 0);

    // verify that stake pool reserve balance increased by the deposit amount
    const reserveAccount = await connection.getParsedAccountInfo(reserveStakeKeypair.publicKey);
    assert.equal(Number(reserveAccount.value.lamports), depositLamports + stakeAccountRent);

    // verify that the manager received 1% of the deposit as fees
    const feesBalance = await provider.connection.getTokenAccountBalance(poolFeesAddress);
    assert.equal(Number(feesBalance.value.amount), depositLamports * 1 / 100);

    // verify that the stake pool balance and the pool token supply are equal to the deposit amount (3 SOL)
    const stakePool = await getStakePool(connection, stakePoolKeypair.publicKey);
    assert.equal(Number(stakePool.totalLamports), depositLamports);
    assert.equal(Number(stakePool.poolTokenSupply), depositLamports);

    // verify that the share price after the first deposit is 1
    const sharePrice = await getStakePoolSharePrice(connection, stakePoolKeypair.publicKey);
    assert.equal(sharePrice, 1);
  });


  it("Increases validator stake by 2 SOL", async () => {
    
    const lamportsToStake = 2 * LAMPORTS_PER_SOL; // Stake 2 SOL

    // derive the transient stake account PDA
    const [transientStakeAccount] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("transient"),
        validatorVoteAccount.toBuffer(),
        stakePoolKeypair.publicKey.toBuffer(),
        new BN(transientStakeSeed).toArrayLike(Buffer, "le", 8),
      ],
      STAKE_POOL_PROGRAM_ID
    );
  
    // derive the validator stake account PDA
    const [validatorStakeAccount] = PublicKey.findProgramAddressSync([
      validatorVoteAccount.toBuffer(),
      stakePoolKeypair.publicKey.toBuffer(),
    ],
      STAKE_POOL_PROGRAM_ID
    );

    // verify that the stake pool balance is 3 SOL
    const stakePoolPre = await getStakePool(connection, stakePoolKeypair.publicKey);
    assert.equal(Number(stakePoolPre.totalLamports), 3 * LAMPORTS_PER_SOL);

    // construct the IncreaseValidatorStake instruction
    const increaseValidatorStakeIx = new TransactionInstruction({
      programId: STAKE_POOL_PROGRAM_ID,
      keys: [
        { pubkey: stakePoolKeypair.publicKey, isSigner: false, isWritable: true }, // Stake pool
        { pubkey: wallet.publicKey, isSigner: true, isWritable: false }, // The Staker authority
        { pubkey: poolWithdrawAuthority, isSigner: false, isWritable: false }, // Withdraw authority PDA
        { pubkey: validatorListKeypair.publicKey, isSigner: false, isWritable: true }, // Validator list
        { pubkey: reserveStakeKeypair.publicKey, isSigner: false, isWritable: true }, // Reserve stake account
        { pubkey: transientStakeAccount, isSigner: false, isWritable: true }, // Transient stake
        { pubkey: validatorStakeAccount, isSigner: false, isWritable: false }, // Validator stake
        { pubkey: validatorVoteAccount, isSigner: false, isWritable: false }, // Validator vote account
        { pubkey: web3.SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false }, // Clock sysvar
        { pubkey: web3.SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }, // Rent sysvar
        { pubkey: web3.SYSVAR_STAKE_HISTORY_PUBKEY, isSigner: false, isWritable: false }, // Stake history sysvar
        { pubkey: new PublicKey("StakeConfig11111111111111111111111111111111"), isSigner: false, isWritable: false }, // Stake config
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // System program
        { pubkey: StakeProgram.programId, isSigner: false, isWritable: false }, // Stake program
      ],
      data: Buffer.concat([
        Buffer.from(Uint8Array.of(4)), // Instruction index for IncreaseValidatorStake
        new BN(lamportsToStake).toArrayLike(Buffer, "le", 8), // Lamports to stake
        new BN(transientStakeSeed).toArrayLike(Buffer, "le", 8), // Transient stake seed
      ]),
    });

    // send the IncreaseValidatorStake transaction
    const transaction = new Transaction().add(increaseValidatorStakeIx);
    const txHash = await provider.sendAndConfirm(transaction);
    assert.ok(txHash);

    // verify that the stake pool balance didn't change is still 3 SOL
    const stakePool = await getStakePool(connection, stakePoolKeypair.publicKey);
    assert.equal(Number(stakePool.totalLamports), Number(stakePoolPre.totalLamports));

    // verify that the validator transient stake account balance was increased by the stake amount
    const transientStakeAccountStake = (await connection.getParsedAccountInfo(transientStakeAccount)).value.lamports - stakeAccountRent;
    assert.equal(transientStakeAccountStake, lamportsToStake);
  });


  it("Updates validator list balance", async () => {
    // move epoch forward to trigger the update of the validator balances
    await moveEpochForward(connection, 1);

    // derive the validator transient stake account PDA
    const [transientStakeAccount] = await PublicKey.findProgramAddressSync(
      [
        Buffer.from("transient"),
        validatorVoteAccount.toBuffer(),
        stakePoolKeypair.publicKey.toBuffer(),
        new BN(transientStakeSeed).toArrayLike(Buffer, "le", 8),
      ],
      STAKE_POOL_PROGRAM_ID
    );
  
    // derive the validator stake account PDA
    const [validatorStakeAccount] = PublicKey.findProgramAddressSync([
      validatorVoteAccount.toBuffer(),
      stakePoolKeypair.publicKey.toBuffer(),
    ],
      STAKE_POOL_PROGRAM_ID
    );

    // verify that 2 SOL are sitting in the transient stake account (as per previous test)
    const transientStakeAccountInfo = await connection.getParsedAccountInfo(transientStakeAccount);
    let transientStakeAccountStake = transientStakeAccountInfo.value.lamports - stakeAccountRent;
    assert.equal(transientStakeAccountStake, 2 * LAMPORTS_PER_SOL);

    // verify that the stake account balance is 1 SOL
    const stakeAccountBalancePre = await connection.getBalance(validatorStakeAccount) - stakeAccountRent;
    assert.equal(stakeAccountBalancePre, 1 * LAMPORTS_PER_SOL);

    // verify that the stake pool balance is 3 SOL
    const stakePoolPre = await getStakePool(connection, stakePoolKeypair.publicKey);
    assert.equal(Number(stakePoolPre.totalLamports), 3 * LAMPORTS_PER_SOL);

    // serialize UpdateValidatorListBalance instruction data
    const startIndex = 0; // start from the first validator
    const noMerge = false; // allow merging transient stake accounts
  
    const instructionData = Buffer.concat([
      Buffer.from(Uint8Array.of(6)), // Instruction index for UpdateValidatorListBalance
      Buffer.from(new Uint32Array([startIndex]).buffer), // start_index as u32 (little-endian)
      Buffer.from(Uint8Array.of(noMerge ? 1 : 0)), // no_merge as bool
    ]);

    // construct the UpdateValidatorListBalance instruction
    const updateValidatorListBalanceIx = new TransactionInstruction({
      programId: STAKE_POOL_PROGRAM_ID,
      keys: [
        { pubkey: stakePoolKeypair.publicKey, isSigner: false, isWritable: true }, // Stake pool
        { pubkey: poolWithdrawAuthority, isSigner: false, isWritable: false }, // Withdraw authority PDA
        { pubkey: validatorListKeypair.publicKey, isSigner: false, isWritable: true }, // Validator list
        { pubkey: reserveStakeKeypair.publicKey, isSigner: false, isWritable: true }, // Reserve stake account
        { pubkey: web3.SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false }, // Clock sysvar
        { pubkey: web3.SYSVAR_STAKE_HISTORY_PUBKEY, isSigner: false, isWritable: false }, // Stake history 
        { pubkey: StakeProgram.programId, isSigner: false, isWritable: false }, // Stake config
        // add validator stake and transient accounts for all validators to be updated
        { pubkey: validatorStakeAccount, isSigner: false, isWritable: true }, // Validator stake account
        { pubkey: transientStakeAccount, isSigner: false, isWritable: true }, // Transient stake account
      ],
      data: instructionData,
    });
  
    // send the UpdateValidatorListBalance transaction
    const transaction = new Transaction().add(updateValidatorListBalanceIx);
    const txHash = await provider.sendAndConfirm(transaction);
    assert.ok(txHash);

    // verify that the stake account balance was increased by the amount (3 SOL) in the transient stake account
    const stakedAmountAfter = await connection.getBalance(validatorStakeAccount) - stakeAccountRent;
    assert.equal(stakedAmountAfter, stakeAccountBalancePre + transientStakeAccountStake);
   
    // verify that the transient stake account was reset
    const transientStakeAccountInfoAfter = await connection.getParsedAccountInfo(transientStakeAccount);
    assert.isNull(transientStakeAccountInfoAfter.value);

    // verify that the stake pool balance still reflects the deposit amount (3 SOL) from the previous test
    const stakePool = await getStakePool(connection, stakePoolKeypair.publicKey);
    assert.equal(Number(stakePool.totalLamports), 3 * LAMPORTS_PER_SOL);

    // verify that the share price after calling UpdateValidatorListBalance is still 1
    const sharePrice = await getStakePoolSharePrice(connection, stakePoolKeypair.publicKey);
    assert.equal(sharePrice, 1);
  });


  it("Updates stake pool balance and share price", async () => {
  
    // derive the validator stake account PDA
    const [validatorStakeAccount] = PublicKey.findProgramAddressSync([
      validatorVoteAccount.toBuffer(),
      stakePoolKeypair.publicKey.toBuffer(),
    ],
      STAKE_POOL_PROGRAM_ID
    );

    const feesBalancePre = await provider.connection.getTokenAccountBalance(poolFeesAddress);
    
    // verify that the share price before calling UpdateStakePoolBalance is still 1
    const sharePricePre = await getStakePoolSharePrice(connection, stakePoolKeypair.publicKey);
    assert.equal(sharePricePre, 1);

    // construct the UpdateStakePoolBalance instruction
    const updateStakePoolBalanceIx = new TransactionInstruction({
      programId: STAKE_POOL_PROGRAM_ID,
      keys: [
        { pubkey: stakePoolKeypair.publicKey, isSigner: false, isWritable: true }, // Stake pool
        { pubkey: poolWithdrawAuthority, isSigner: false, isWritable: false }, // Withdraw authority PDA
        { pubkey: validatorListKeypair.publicKey, isSigner: false, isWritable: true }, // Validator list
        { pubkey: reserveStakeKeypair.publicKey, isSigner: false, isWritable: false }, // Reserve stake account
        { pubkey: poolFeesAddress, isSigner: false, isWritable: true }, // Fee account
        { pubkey: poolMint, isSigner: false, isWritable: true }, // Pool mint
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // Token program
      ],
      data: Buffer.from(Uint8Array.of(7)), // Instruction index for UpdateStakePoolBalance
    });

    // send the UpdateStakePoolBalance transaction
    const transaction = new Transaction().add(updateStakePoolBalanceIx);
    const txHash = await provider.sendAndConfirm(transaction);
    assert.ok(txHash);
 
    // verify that the stake account balance is still 3 SOL (same as previous test)
    const stakeAccountBalance = await connection.getBalance(validatorStakeAccount) - stakeAccountRent;
    assert.equal(stakeAccountBalance, 3 * LAMPORTS_PER_SOL);

    // verify that the stake pool balance was updated and matches
    // the balance of the stake account (3 SOL deposit) + 1 SOL (initial validator deposit) + stake account rent (2282880 lamports)
    const stakePool = await getStakePool(connection, stakePoolKeypair.publicKey);
    assert.equal(Number(stakePool.totalLamports), stakeAccountBalance + 1 * LAMPORTS_PER_SOL + stakeAccountRent);

    // verify that the fees account received some staking rewards fees
    const feesBalance = await provider.connection.getTokenAccountBalance(poolFeesAddress);
    assert(feesBalance.value.uiAmount > feesBalancePre.value.uiAmount);

    // verify that the share price after calling UpdateStakePoolBalance is greater than 1
    const sharePrice = await getStakePoolSharePrice(connection, stakePoolKeypair.publicKey);
    assert(sharePrice > 1);
  });

  it("Withdraws 0.5 Pool Tokens worth of SOL from the reserve account", async () => {
    // the amount of pool tokens to withdraw
    const withdrawAmount = 0.5 * LAMPORTS_PER_SOL; 
  
    const stakePoolPreBalance = Number((await getStakePool(connection, stakePoolKeypair.publicKey)).totalLamports);
    const reserveAccountPreBalance = await connection.getBalance(reserveStakeKeypair.publicKey) - stakeAccountRent;
    const userPreBalance = await connection.getBalance(user.publicKey);
    const userPoolTokenPreBalance = await connection.getTokenAccountBalance(userPoolTokenATA);
    const sharePricePre = await getStakePoolSharePrice(connection, stakePoolKeypair.publicKey);

    // construct the WithdrawSol instruction
    const withdrawSolIx = new TransactionInstruction({
      programId: STAKE_POOL_PROGRAM_ID,
      keys: [
        { pubkey: stakePoolKeypair.publicKey, isSigner: false, isWritable: true },             // Stake pool
        { pubkey: poolWithdrawAuthority, isSigner: false, isWritable: false }, // Stake pool withdraw authority
        { pubkey: user.publicKey, isSigner: true, isWritable: false }, // User transfer authority
        { pubkey: userPoolTokenATA, isSigner: false, isWritable: true }, // User's pool token account
        { pubkey: reserveStakeKeypair.publicKey, isSigner: false, isWritable: true },         // Reserve stake account
        { pubkey: user.publicKey, isSigner: false, isWritable: true },  // Account receiving SOL
        { pubkey: poolFeesAddress, isSigner: false, isWritable: true },     // Fee token account
        { pubkey: poolMint, isSigner: false, isWritable: true },            // Pool token mint account
        { pubkey: web3.SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false }, // Clock sysvar
        { pubkey: web3.SYSVAR_STAKE_HISTORY_PUBKEY, isSigner: false, isWritable: false }, // Stake history sysvar
        { pubkey: StakeProgram.programId, isSigner: false, isWritable: false }, // Stake program account
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },   // SPL Token program
      ],
      data: Buffer.concat([
        Buffer.from(Uint8Array.of(16)), // Instruction index for WithdrawSol
        new BN(withdrawAmount).toArrayLike(Buffer, "le", 8), // Withdraw amount (u64)
      ]),
    });
  
    // send the WithdrawSol transaction
    const transaction = new Transaction().add(withdrawSolIx);
    const txHash = await provider.sendAndConfirm(transaction, [user]);
    assert.ok(txHash);

    // the amount of SOL withdrawn should be the amount of pool tokens withdrawn * the share price
    const sharePrice = await getStakePoolSharePrice(connection, stakePoolKeypair.publicKey);
    const expectedSolAmountWithdrawn = Math.floor(withdrawAmount * sharePrice);

    // verify that the share price didn't change after the withdrawal
    assert(sharePrice - sharePricePre < 0.000000001);
   
    // verify that the stake pool balance decreased by the SOL amount withdrawn
    const stakePoolBalance = Number((await getStakePool(connection, stakePoolKeypair.publicKey)).totalLamports);
    const stakePoolBalanceDiff = stakePoolPreBalance - stakePoolBalance;
    assert.equal(stakePoolBalanceDiff, expectedSolAmountWithdrawn);
    
    // verify that the reserve account balance decreased by the expected SOL amount withdrawn
    const reserveAccountBalance = await connection.getBalance(reserveStakeKeypair.publicKey) - stakeAccountRent;
    const reserveAccountBalanceDiff = reserveAccountPreBalance - reserveAccountBalance;
    assert.equal(reserveAccountBalanceDiff, expectedSolAmountWithdrawn);
    
    // verify that stake pool reserve balance (SOL) decreased by at least the withdrawn amount (pool tokens)
    assert.equal(reserveAccountBalanceDiff, expectedSolAmountWithdrawn);

    // verify that user pool's tokens were burned from the user's account
    const userPoolTokenBalance = await connection.getTokenAccountBalance(userPoolTokenATA);
    const userPoolTokenDiff = Number(userPoolTokenPreBalance.value.amount) - Number(userPoolTokenBalance.value.amount);
    assert.equal(userPoolTokenDiff, withdrawAmount);
        
    // verify that the user's SOL balance increased by the expected SOL amount
    const userBalance = await connection.getBalance(user.publicKey);
    const userBalanceDiff = userBalance - userPreBalance;
    assert.equal(userBalanceDiff, expectedSolAmountWithdrawn);
  });


  it("Share price increases when epoch changes", async () => {
    
    // move epoch forward to get staking rewards paid out to the validator stake accounts
    const sharePricePre = await getStakePoolSharePrice(connection, stakePoolKeypair.publicKey);
    await moveEpochForward(connection, 1);
  
    // update the validator stake accounts
    await updateValidatorListBalance(
      validatorVoteAccount,
      stakePoolKeypair.publicKey,
      poolWithdrawAuthority,
      validatorListKeypair.publicKey,
      reserveStakeKeypair.publicKey,
      transientStakeSeed,
    )

    // update the stake pool balance and share price
    await updatePoolStakeBalance(
      stakePoolKeypair.publicKey,
      poolWithdrawAuthority,
      validatorListKeypair.publicKey,
      reserveStakeKeypair.publicKey,
      poolMint,
      poolFeesAddress,
    );

    // verify that the share price increased
    const sharePrice = await getStakePoolSharePrice(connection, stakePoolKeypair.publicKey);
    assert(sharePrice > sharePricePre);
  });

  it("Decodes the pool validator list", async () => {
    const stakePool = await getStakePool(connection, stakePoolKeypair.publicKey);
    const validatorList = await decodeValidatorListAccount(connection, stakePool.validatorList);
    assert.ok(validatorList);

    // verify that the validator list header has the correct number of max validators
    assert.equal(validatorList.header.max_validators, MAX_VALIDATORS);

    // verify that the validator list has one validator
    assert.equal(validatorList.validators.length, 1);

    // verify that the first validator in the list has the correct values
    const firstValidator = validatorList.validators[0];
    assert.equal(firstValidator.vote_account_address.toBase58(), validatorVoteAccount.toBase58());
    assert(Number(firstValidator.active_stake_lamports) > 3 * LAMPORTS_PER_SOL + stakeAccountRent); // includes some staking rewards
    assert.equal(Number(firstValidator.transient_stake_lamports), 0);
    assert.equal(firstValidator.status, 0);
    // the validator was updated after the epoch advances; the exact epoch count
    // depends on slots-per-epoch and wall-clock timing, so assert it has been
    // updated at least twice rather than pinning a brittle exact value
    assert(Number(firstValidator.last_update_epoch) >= 2);
  });

});

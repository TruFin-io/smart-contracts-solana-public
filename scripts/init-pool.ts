import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import { Keypair, PublicKey, StakeProgram, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import * as borsh from "borsh";
import * as fs from "fs";
import { Fee, InitializeData, InitializeSchema, } from "../tests/stake_pool/types";
import { getConnection, getStakePoolProgramId } from "./utils";

// Get the Solana connection
const connection = getConnection();

// get config variables
const stake_pool_program_id = new PublicKey(getStakePoolProgramId());
const MAX_VALIDATORS = 100;
const PROJECT_DIR = process.cwd();

// load the required keypairs
const owner_keypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(`${process.cwd()}/accounts/owner.json`, "utf-8"))) // Replace with your keypair file
);
const stakerKeypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(`${PROJECT_DIR}/accounts/staker-program.json`, "utf-8")))
);
const managerKeypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(`${PROJECT_DIR}/accounts/manager.json`, "utf-8")))
);
const stakePoolKeypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(`${PROJECT_DIR}/accounts/stake-pool.json`, "utf-8")))
);
const validatorListKeypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(`${PROJECT_DIR}/accounts/validator-list.json`, "utf-8")))
);
const reserveStakeKeypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(`${PROJECT_DIR}/accounts/reserve-stake.json`, "utf-8")))
);

// Configure the Solana connection and Anchor provider
const owner_wallet = new Wallet(owner_keypair)
const provider = new AnchorProvider(connection, owner_wallet, { commitment: "confirmed" });
anchor.setProvider(provider);


// A script to initialize the staking pool contract
// usage: yarn init-pool
async function main() {

  // derive the pool deposit authority (PDA)
  const [poolDepositAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("deposit")],
    stakerKeypair.publicKey
  );

  // derive the pool withdraw authority (PDA)
  const [poolWithdrawAuthority] = PublicKey.findProgramAddressSync(
    [stakePoolKeypair.publicKey.toBuffer(), Buffer.from("withdraw")],
    stake_pool_program_id
  );

  // create the pool token mint
  const poolMint = await createMint(
    connection,
    owner_wallet.payer,
    poolWithdrawAuthority, // Mint authority must be set as the withdraw authority PDA
    null, // Freeze authority
    9 // Decimals
  );

  // create the manager's associated token account that will collect fees
  const feesTokenAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    owner_wallet.payer, // payer of the transaction and initialization fees
    poolMint,
    managerKeypair.publicKey // owner who Fee token account who will receive the fees (manager)
  );

  // rent-exempt balances
  const validatorListSize = 5 + 4 + 73 * MAX_VALIDATORS;  // header + padding + 73 bytes for each ValidatorStakeInfo
  const validatorListRent = await connection.getMinimumBalanceForRentExemption(validatorListSize);
  const stakePoolAccountRent = await connection.getMinimumBalanceForRentExemption(8 + 656);
  const stakeAccountRent = await provider.connection.getMinimumBalanceForRentExemption(StakeProgram.space);

  // build transaction to create accounts
  const transaction = new Transaction().add(
    // Create Stake Pool account
    SystemProgram.createAccount({
      fromPubkey: owner_wallet.publicKey,
      newAccountPubkey: stakePoolKeypair.publicKey,
      space: 8 + 656, // std::mem::size_of::<StakePool>() gives 656
      lamports: stakePoolAccountRent,
      programId: stake_pool_program_id,
    }),
    // Create Validator List account
    SystemProgram.createAccount({
      fromPubkey: owner_wallet.publicKey,
      newAccountPubkey: validatorListKeypair.publicKey,
      space: validatorListSize,
      lamports: validatorListRent,
      programId: stake_pool_program_id,
    }),
    // Create Reserve Stake account
    StakeProgram.createAccount({
      fromPubkey: owner_wallet.publicKey,
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

  console.log("creating accounts...");

  // send create accounts transaction
  const txSig = await provider.sendAndConfirm(transaction, [
    stakePoolKeypair,
    validatorListKeypair,
    reserveStakeKeypair,
    owner_wallet.payer
  ], {
    commitment: "confirmed",
  });

  console.log("Create accounts transaction confirmed:", txSig);

  console.log("Staker Account:", stakerKeypair.publicKey.toBase58());
  console.log("Stake Pool Account:", stakePoolKeypair.publicKey.toBase58());
  console.log("Manager Account:", managerKeypair.publicKey.toBase58());
  console.log("Stake Pool Account:", stakePoolKeypair.publicKey.toBase58());
  console.log("Validator List Account:", validatorListKeypair.publicKey.toBase58());
  console.log("Reserve Stake Account:", reserveStakeKeypair.publicKey.toBase58());
  console.log("Pool Mint:", poolMint.toBase58());
  console.log("Fees Token Account:", feesTokenAccount.address.toBase58());
  console.log("Deposit Authority:", poolDepositAuthority.toBase58());
  console.log("Withdraw Authority:", poolWithdrawAuthority.toBase58());

  // Construct the Initialize instruction
  const instructionData = new InitializeData({
    instruction: 0, // Instruction index for `Initialize`
    fee: new Fee({ numerator: 5, denominator: 100 }),
    withdrawalFee: new Fee({ numerator: 1, denominator: 1000 }),
    depositFee: new Fee({ numerator: 0, denominator: 100 }), // fixed at zero, never enabled (see README "Fees")
    referralFee: 0, // fixed at zero, never enabled (see README "Fees")
    maxValidators: MAX_VALIDATORS, // maximum number of validators matching the size of the validator list account
  });

  const data = Buffer.from(borsh.serialize(InitializeSchema, instructionData));
  const initializeIx = new TransactionInstruction({
    programId: stake_pool_program_id,
    keys: [
      { pubkey: stakePoolKeypair.publicKey, isSigner: true, isWritable: true }, // Stake pool account
      { pubkey: managerKeypair.publicKey, isSigner: true, isWritable: false }, // Manager
      { pubkey: stakerKeypair.publicKey, isSigner: true, isWritable: false }, // Staker
      { pubkey: poolWithdrawAuthority, isSigner: false, isWritable: false }, // Withdraw authority
      { pubkey: validatorListKeypair.publicKey, isSigner: false, isWritable: true }, // Validator list
      { pubkey: reserveStakeKeypair.publicKey, isSigner: false, isWritable: false }, // Reserve stake
      { pubkey: poolMint, isSigner: false, isWritable: true }, // Pool token mint
      { pubkey: feesTokenAccount.address, isSigner: false, isWritable: true }, // Manager's pool token account to receive fees
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // Token program
      { pubkey: poolDepositAuthority, isSigner: false, isWritable: false }, // (Optional) Deposit authority that must sign all deposits
    ],
    data,
  });

  // add the instruction to a transaction
  const initTransaction = new Transaction().add(initializeIx);
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  initTransaction.recentBlockhash = blockhash;
  initTransaction.feePayer = owner_wallet.publicKey;

  // sign the transaction with the stake pool, manager and staker keys
  initTransaction.sign(stakePoolKeypair, managerKeypair, stakerKeypair);

  // send and confirm the transaction
  console.log("Sending Initialize transaction...");
  const txHash = await provider.sendAndConfirm(initTransaction, [
    stakePoolKeypair,
    managerKeypair,
    stakerKeypair
  ], {
    commitment: "confirmed",
  });

  console.log("Initialize tx:", txHash);
}

// Run the main function
main().catch((error) => {
    console.error("Unexpected error:", error);
    process.exit(1);
});

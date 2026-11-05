import * as anchor from "@coral-xyz/anchor";
import * as borsh from "borsh";
import { randomBytes } from "crypto";
import { AnchorProvider, web3, BN } from "@coral-xyz/anchor";
import { Staker } from "../target/types/staker";

import { PublicKey, Keypair, SystemProgram, Transaction, StakeProgram, TransactionInstruction, LAMPORTS_PER_SOL, Connection } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccount,
  createMint,
  getAssociatedTokenAddress,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import { StakePoolSchema, FundingType, StakePool, ValidatorListHeaderSchema, ValidatorListHeader, ValidatorStakeInfoSchema, ValidatorStakeInfo, ValidatorList, InitializeData, Fee, InitializeSchema, CreateStakePoolResponse, StakePoolAccounts, increaseAdditionalValidatorStakeData, IncreaseStakeSchema, StakeStatus} from "./stake_pool/types";
import { assert } from "chai";

// Constants
export const STAKE_POOL_PROGRAM_ID = new PublicKey( "SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy");

// SPL Stake Pool PDA derivations for the validator-specific stake accounts.
// The ephemeral PDA is pool-global (seed only); the transient PDA is per-validator.
export function findEphemeralStakeAccount(stakePool: PublicKey, seed: number | BN): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("ephemeral"), stakePool.toBuffer(), new BN(seed).toArrayLike(Buffer, "le", 8)],
    STAKE_POOL_PROGRAM_ID
  );
  return pda;
}

export function findTransientStakeAccount(
  validatorVoteAccount: PublicKey,
  stakePool: PublicKey,
  seed: number | BN
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("transient"),
      validatorVoteAccount.toBuffer(),
      stakePool.toBuffer(),
      new BN(seed).toArrayLike(Buffer, "le", 8),
    ],
    STAKE_POOL_PROGRAM_ID
  );
  return pda;
}

// The validator seed is a u32 (SPL's `Option<NonZeroU32>`), unlike the u64 transient and ephemeral
// seeds: seed 0 adds no seed bytes, any other seed adds 4 little-endian bytes. Pass the validator
// list's `validator_seed_suffix` (see recordedValidatorSeed); a wrong address makes
// UpdateValidatorListBalance skip the validator without an error. Scripts pass the configured
// stake pool program, which is not SPL's on devnet.
export function findValidatorStakeAccount(
  validatorVoteAccount: PublicKey,
  stakePool: PublicKey,
  validatorSeed: number = 0,
  stakePoolProgramId: PublicKey = STAKE_POOL_PROGRAM_ID
): PublicKey {
  const seeds = [validatorVoteAccount.toBuffer(), stakePool.toBuffer()];
  if (validatorSeed !== 0) {
    seeds.push(new BN(validatorSeed).toArrayLike(Buffer, "le", 4));
  }
  const [pda] = PublicKey.findProgramAddressSync(seeds, stakePoolProgramId);
  return pda;
}

// Returns the entry for `validatorVoteAccount` in an already-decoded validator list; throws if the
// validator is not in the pool. Use it instead of getValidatorStakeInfo when the list is needed
// for something else too, to save a fetch.
export function findValidatorStakeInfo(
  validatorList: { validators: ValidatorStakeInfo[] },
  validatorVoteAccount: PublicKey
): ValidatorStakeInfo {
  const info = validatorList.validators.find((v: ValidatorStakeInfo) =>
    v.vote_account_address.equals(validatorVoteAccount)
  );
  if (!info) {
    throw new Error(`Validator ${validatorVoteAccount.toBase58()} not found in the validator list`);
  }
  return info;
}

// Fetches the validator list and returns the entry for `validatorVoteAccount`; throws if the
// validator is not in the pool.
export async function getValidatorStakeInfo(
  connection: Connection,
  validatorListAccount: PublicKey,
  validatorVoteAccount: PublicKey
): Promise<ValidatorStakeInfo> {
  const validatorList = await decodeValidatorListAccount(connection, validatorListAccount);
  return findValidatorStakeInfo(validatorList, validatorVoteAccount);
}

// The transient stake seed recorded in the validator list: the seed of the transient in flight,
// or of the last one merged. It is what SPL checks the transient account against in
// UpdateValidatorListBalance and RemoveValidatorFromPool.
export function recordedTransientStakeSeed(info: ValidatorStakeInfo): BN {
  return new BN(info.transient_seed_suffix.toString());
}

// The validator seed recorded in the validator list, chosen at AddValidatorToPool and fixed for the
// validator's life: the seed findValidatorStakeAccount needs to reach the validator's stake account.
export function recordedValidatorSeed(info: ValidatorStakeInfo): number {
  return info.validator_seed_suffix;
}

// Whether the validator list records transient stake in flight for this validator.
export function hasTransientStake(info: ValidatorStakeInfo): boolean {
  // borsh hands back a BN at runtime although the field is typed bigint; a string round-trip
  // works for both
  return !new BN(info.transient_stake_lamports.toString()).isZero();
}

// The transient stake seed to pass to the validator-specific instructions for this validator.
// SPL requires the recorded seed while transient stake is in flight. Once that transient has been
// merged any seed never used for this validator is valid, and it is chosen at random (like the
// ephemeral seed) so nobody can line up a poisoned address in advance: a merged transient PDA can
// be kept alive by refilling its rent (see transient_poison.test.ts), and a whitelisted depositor
// can set the recorded suffix to any value while nothing is in flight, so a predictable choice
// such as "recorded suffix + 1" would be attacker-steerable.
export function transientStakeSeedFor(info: ValidatorStakeInfo): BN {
  return hasTransientStake(info) ? recordedTransientStakeSeed(info) : randomStakeSeed();
}

// A fresh random u64 to use as a stake seed: the ephemeral seed on every call, and the transient
// seed when no transient stake is in flight. A new value per call keeps the PDA unpredictable so
// it cannot be pre-funded / poisoned ahead of time.
export function randomStakeSeed(): BN {
  return new BN(randomBytes(8));
}

// Confirmed-commitment confirm options used everywhere we send transactions.
// Aligning the blockhash fetch and preflight simulation to the same commitment
// avoids the local validator's intermittent "Blockhash not found".
export const CONFIRMED_OPTS = {
  commitment: "confirmed",
  preflightCommitment: "confirmed",
} as const;

// Builds a provider with confirmed commitment + preflight, registers it as the
// global Anchor provider (so anchor.workspace programs use it), and returns it.
// Call this once at the top of every test suite instead of AnchorProvider.env().
export function setupConfirmedProvider(): AnchorProvider {
  const provider = AnchorProvider.local(undefined, CONFIRMED_OPTS);
  anchor.setProvider(provider);
  return provider;
}

export async function fetchEvent(
  program: anchor.Program<Staker>,
  tx: anchor.web3.Transaction,
  instruction_index: number = 0
): Promise<anchor.Event> {
  const config = {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  } as const;
  const txHash = await program.provider.sendAndConfirm(tx, [], config);

  // fetch and check event data
  const txResult = await program.provider.connection.getTransaction(
    txHash,
    config
  );

  const ixData = anchor.utils.bytes.bs58.decode(
    txResult.meta.innerInstructions[0].instructions[instruction_index].data
  );
  const eventData = anchor.utils.bytes.base64.encode(ixData.subarray(8));
  return program.coder.events.decode(eventData);
}

export async function getEvent(
  program: anchor.Program<Staker>,
  txHash: string,
  eventName: string
): Promise<anchor.Event> {

  // fetch the transaction
  const txResult = await program.provider.connection.getTransaction(
    txHash,
    {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    }
  );

  if (!txResult || !txResult.meta || !txResult.meta.innerInstructions) { 
    throw new Error(`Transaction ${txHash} not found or invalid.`);
  }

  // find and return the decoded event in the transaction metadata
  return txResult.meta.innerInstructions
    .flatMap(({ instructions }) => instructions)
    .map(instruction => {
      const ixData = anchor.utils.bytes.bs58.decode(instruction.data);
      const eventData = anchor.utils.bytes.base64.encode(ixData.subarray(8));
      return program.coder.events.decode(eventData);
    })
    .find(event => event !== null && event.name === eventName);
}

// Request airdrop for the given user and wait for it to be confirmed
export async function requestAirdrop(connection: anchor.web3.Connection, user: PublicKey, amount: number) {
    const signature = await connection.requestAirdrop(user, amount * LAMPORTS_PER_SOL);

    const latestBlockHash = await connection.getLatestBlockhash();
    await connection.confirmTransaction({
      blockhash: latestBlockHash.blockhash,
      lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
      signature: signature,
    });
}

export async function initStaker(owner: PublicKey, stakeManager: PublicKey): Promise<anchor.Program<Staker>> {
  let program = anchor.workspace.Staker as anchor.Program<Staker>;
  
  await program.methods.initializeStaker().accounts({
    ownerInfo: owner,
    stakeManagerInfo: stakeManager,
  }).rpc();

  return program;
}
 
 export async function moveEpochForward(connection: anchor.web3.Connection, epochCount: number = 1): Promise<void> {
  const initialEpoch = (await connection.getEpochInfo()).epoch;
  while (true) {
    const epochInfo = await connection.getEpochInfo();
    if (epochInfo.epoch >= initialEpoch + epochCount) {
      // Wait for epoch rewards distribution to complete by ensuring
      // we're past the first few slots of the new epoch
      while (true) {
        const info = await connection.getEpochInfo();
        if (info.slotIndex > 10) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      break;
    }
    // poll often: time spent noticing the roll-over is taken out of the window the
    // epoch-sensitive tests have for their next steps
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

// Simulates `tx`, signed by `feePayer` and `signers`, and asserts it fails with a log line
// containing `needle`. Simulating leaves the chain untouched and exposes the CPI logs, which is
// where SPL and the system program explain the failure.
export async function simulateExpectingLog(
  connection: Connection,
  tx: Transaction,
  feePayer: Keypair,
  signers: Keypair[],
  needle: string,
  label: string
) {
  tx.feePayer = feePayer.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(feePayer, ...signers);
  const sim = await connection.simulateTransaction(tx);
  assert.ok(sim.value.err, `${label}: expected the transaction to fail`);
  const logs = sim.value.logs ?? [];
  assert.isTrue(
    logs.some((l) => l.includes(needle)),
    `${label}: expected a log containing "${needle}", got:\n${logs.join("\n")}`
  );
}

export async function moveEpochForwardAndUpdatePool(
  connection: anchor.web3.Connection, 
  accounts: StakePoolAccounts,
  validatorVoteAccount: PublicKey,
  epochCount: number = 1
) {

   await moveEpochForward(connection, epochCount);

   // update the stake stake accounts' state
   await updateValidatorListBalance(
     validatorVoteAccount,
     accounts.stakePoolAccount,
     accounts.withdrawAuthorityAccount,
     accounts.validatorListAccount,
     accounts.reserveStakeAccount
   );

   // update the stake pool total stake balance and share price
   await updatePoolStakeBalance(
     accounts.stakePoolAccount,
     accounts.withdrawAuthorityAccount,
     accounts.validatorListAccount,
     accounts.reserveStakeAccount,
     accounts.poolMintAccount,
     accounts.feesTokenAccount
   );
}

export async function getStakePool(connection: anchor.web3.Connection, stakePoolPubkey: anchor.web3.PublicKey): Promise<StakePool> {
  const stakePoolAccountInfo = await connection.getAccountInfo(stakePoolPubkey);
  const stakePool = borsh.deserializeUnchecked(
    StakePoolSchema,
    StakePool,
    stakePoolAccountInfo.data.subarray(0, 664) 
  );

  return stakePool;
}

export type StakePoolFees = {
  epochFee: { numerator: number; denominator: number };
  withdrawalFee: { numerator: number; denominator: number };
  depositFee: { numerator: number; denominator: number };
};

const DEFAULT_STAKE_POOL_FEES: StakePoolFees = {
  epochFee: { numerator: 2, denominator: 100 },
  withdrawalFee: { numerator: 1, denominator: 100 },
  depositFee: { numerator: 1, denominator: 100 },
};

export async function createStakePool(
  stakerProgramId: PublicKey,
  managerKeypair: Keypair,
  stakerKeypair: Keypair,
  fees: StakePoolFees = DEFAULT_STAKE_POOL_FEES,
): Promise<CreateStakePoolResponse> {
  console.log("Creating stake pool for staker ", stakerProgramId.toBase58());

  const provider = AnchorProvider.local(undefined, CONFIRMED_OPTS);
  const connection = provider.connection;
  const wallet = provider.wallet as anchor.Wallet;

  const MAX_VALIDATORS = 1;

  // Generate pool keypairs
  const stakePoolKeypair = Keypair.generate();
  const validatorListKeypair = Keypair.generate();
  const reserveStakeKeypair = Keypair.generate();

  // derive the pool deposit authority (PDA)
  const [poolDepositAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("deposit")],
    stakerProgramId
  );

  // derive the pool withdraw authority (PDA)
  const [poolWithdrawAuthority] = PublicKey.findProgramAddressSync(
    [stakePoolKeypair.publicKey.toBuffer(), Buffer.from("withdraw")],
    STAKE_POOL_PROGRAM_ID
  );

  // create the pool token mint
  const poolMint = await createMint(
    connection,
    wallet.payer,
    poolWithdrawAuthority, // Mint authority must be set as the withdraw authority PDA
    null, // Freeze authority
    9 // Decimals
  );

  // create the manager's associated token account that will collect fees
  const feesTokenAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    wallet.payer, // payer of the transaction and initialization fees
    poolMint,
    managerKeypair.publicKey // owner who Fee token account who will receive the fees (manager)
  );

  // Calculate rent-exempt balances
  const validatorListSize = 4 + 5 + 73 * MAX_VALIDATORS;  // 73 bytes for each ValidatorStakeInfo + header
  const validatorListRent = await connection.getMinimumBalanceForRentExemption(validatorListSize);
  const stakePoolAccountRent = await connection.getMinimumBalanceForRentExemption(8 + 656);
  const reserveStakeRent = await provider.connection.getMinimumBalanceForRentExemption(StakeProgram.space);

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
      lamports: reserveStakeRent,
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
  await provider.sendAndConfirm(transaction, [
    stakePoolKeypair,
    validatorListKeypair,
    reserveStakeKeypair,
    wallet.payer
  ], {
    commitment: "confirmed",
  });

  console.log("Stake Pool Account:", stakePoolKeypair.publicKey.toBase58());
  console.log("Manager Account:", managerKeypair.publicKey.toBase58());
  console.log("Staker Account:", stakerKeypair.publicKey.toBase58());
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
    fee: new Fee(fees.epochFee),
    withdrawalFee: new Fee(fees.withdrawalFee),
    depositFee: new Fee(fees.depositFee),
    referralFee: 0, // no deposit fee goes to referrer
    maxValidators: MAX_VALIDATORS,
  });

  const data = Buffer.from(borsh.serialize(InitializeSchema, instructionData));

  const initializeIx = new TransactionInstruction({
    programId: STAKE_POOL_PROGRAM_ID,
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

  // Add the instruction to a transaction
  const initTransaction = new Transaction().add(initializeIx);
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  initTransaction.recentBlockhash = blockhash;
  initTransaction.feePayer = wallet.publicKey;

  initTransaction.sign(stakePoolKeypair, managerKeypair, stakerKeypair);

  // Send and confirm the transaction
  console.log("Sending Initialize transaction...");
  const txHash = await provider.sendAndConfirm(initTransaction, [
    stakePoolKeypair,
    managerKeypair,
    stakerKeypair
  ], {
    commitment: "confirmed",
  });

  const stakePool = await getStakePool(connection, stakePoolKeypair.publicKey);

  // set a withdraw authority
  const SolWithdraw = FundingType.SolWithdraw;
  const addFundingAuthorityix = new TransactionInstruction({
    programId: STAKE_POOL_PROGRAM_ID,
    keys: [
      { pubkey: stakePoolKeypair.publicKey, isSigner: false, isWritable: true }, // Stake pool account
      { pubkey: managerKeypair.publicKey, isSigner: true, isWritable: false }, // Manager
      { pubkey: poolWithdrawAuthority, isSigner: false, isWritable: false }, // Withdraw authority
    ],
    data: Buffer.concat([
      Buffer.from(Uint8Array.of(15)), // Instruction index for SetFundingAuthority
      Buffer.from(Uint8Array.of(SolWithdraw)), // Enum variant as u8
    ]),  
  });

  const addFundingAuthoritytx = new Transaction().add(addFundingAuthorityix);

  let latestBlockHash = await connection.getLatestBlockhash("confirmed");
  addFundingAuthoritytx.recentBlockhash = latestBlockHash.blockhash;
  addFundingAuthoritytx.feePayer = wallet.publicKey;
  
  addFundingAuthoritytx.sign(managerKeypair);

  // Send and confirm the transaction
  const fundingTxHash = await provider.sendAndConfirm(addFundingAuthoritytx, [managerKeypair], {
    commitment: "confirmed",
  });

  console.log("Funding authority added successfully. Transaction hash:", fundingTxHash);

  return {
    stakePool: stakePool,
    accounts: {
      stakePoolAccount: stakePoolKeypair.publicKey,
      validatorListAccount: validatorListKeypair.publicKey,
      reserveStakeAccount: reserveStakeKeypair.publicKey,
      poolMintAccount: poolMint,
      feesTokenAccount: feesTokenAccount.address,
      depositAuthorityAccount: poolDepositAuthority,
      withdrawAuthorityAccount: poolWithdrawAuthority,
    }

  } as CreateStakePoolResponse;
}


export async function addValidatorToStakePool(
  validatorVoteAccount: PublicKey,
  stakePool: PublicKey,
  payer: PublicKey,
  reserveStake: PublicKey,
  staker: Keypair,
  withdrawAuthority: PublicKey,
  validatorList: PublicKey,
) {

  const provider = AnchorProvider.local(undefined, CONFIRMED_OPTS);

  // Transfer SOL to the pool reserve account to fund the validator stake account
  const depositTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: reserveStake,
      lamports: 1 * LAMPORTS_PER_SOL + 2282880,
    })
  );
  await provider.sendAndConfirm(depositTx, []);

  // build the AddValidatorToPool instruction
  const seed = 0;
  const validatorStakeAccount = findValidatorStakeAccount(validatorVoteAccount, stakePool, seed);
  const addValidatorIx = new TransactionInstruction({
    programId: STAKE_POOL_PROGRAM_ID,
    keys: [
      { pubkey: stakePool, isSigner: false, isWritable: true }, // Stake pool
      { pubkey: staker.publicKey, isSigner: true, isWritable: false }, // Staker
      { pubkey: reserveStake, isSigner: false, isWritable: true }, // Reserve stake account
      { pubkey: withdrawAuthority, isSigner: false, isWritable: false }, // Pool withdraw authority
      { pubkey: validatorList, isSigner: false, isWritable: true }, // Validator stake list account
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

  // send the AddValidatorToPool transaction
  const addValidatorTx = new Transaction().add(addValidatorIx);
  let tx = await provider.sendAndConfirm(addValidatorTx, [staker]);
  assert.ok(tx);
}


export async function addUserToWhitelist(program: anchor.Program<Staker>, user: PublicKey) {
  const tx = await program.methods
    .addUserToWhitelist(user)
    .rpc();

  assert.ok(tx);

}

export async function getStakePoolSharePrice(
  connection: Connection,
  stakePoolPubkey: PublicKey
): Promise<number> {

  const stakePool = await getStakePool(connection, stakePoolPubkey);

  const totalLamports = new anchor.BN(stakePool.totalLamports.toString()).toNumber();
  const poolTokenSupply = new anchor.BN(stakePool.poolTokenSupply.toString()).toNumber();

  if (poolTokenSupply === 0) {
    throw new Error("Pool token supply is zero");
  }

  return totalLamports / poolTokenSupply;
}


// Builds the SPL UpdateValidatorListBalance instruction for a single validator. The stake accounts
// are derived from `transientStakeSeed` and `validatorSeed`, which must be the validator list's
// `transient_seed_suffix` and `validator_seed_suffix`: SPL skips the (validator, transient) pair
// otherwise.
export function buildUpdateValidatorListBalanceIx(
  validatorVoteAccount: PublicKey,
  stakePoolAccount: PublicKey,
  poolWithdrawAuthority: PublicKey,
  validatorListAccount: PublicKey,
  poolReserveStakeAccount: PublicKey,
  transientStakeSeed: number | BN,
  validatorSeed: number = 0,
  noMerge: boolean = false // false: merge matured transient stake accounts
): TransactionInstruction {
  const transientStakeAccount = findTransientStakeAccount(
    validatorVoteAccount,
    stakePoolAccount,
    transientStakeSeed
  );
  const validatorStakeAccount = findValidatorStakeAccount(validatorVoteAccount, stakePoolAccount, validatorSeed);

  // serialize UpdateValidatorListBalance instruction data
  const startIndex = 0; // start from the first validator
  const instructionData = Buffer.concat([
    Buffer.from(Uint8Array.of(6)), // Instruction index for UpdateValidatorListBalance
    Buffer.from(new Uint32Array([startIndex]).buffer), // start_index as u32 (little-endian)
    Buffer.from(Uint8Array.of(noMerge ? 1 : 0)), // no_merge as bool
  ]);

  return new TransactionInstruction({
    programId: STAKE_POOL_PROGRAM_ID,
    keys: [
      { pubkey: stakePoolAccount, isSigner: false, isWritable: true }, // Stake pool
      { pubkey: poolWithdrawAuthority, isSigner: false, isWritable: false }, // Withdraw authority PDA
      { pubkey: validatorListAccount, isSigner: false, isWritable: true }, // Validator list
      { pubkey: poolReserveStakeAccount, isSigner: false, isWritable: true }, // Reserve stake account
      { pubkey: web3.SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false }, // Clock sysvar
      { pubkey: web3.SYSVAR_STAKE_HISTORY_PUBKEY, isSigner: false, isWritable: false }, // Stake history 
      { pubkey: StakeProgram.programId, isSigner: false, isWritable: false }, // Stake config
      // add validator stake and transient accounts for all the validators to be updated (in our test, we only have one validator)
      { pubkey: validatorStakeAccount, isSigner: false, isWritable: true }, // Validator stake account
      { pubkey: transientStakeAccount, isSigner: false, isWritable: true }, // Transient stake account
    ],
    data: instructionData,
  });
}

// Sends UpdateValidatorListBalance for a single validator. A seed that is not given is read from
// the validator list (`transient_seed_suffix`, `validator_seed_suffix`), which is what SPL checks
// the stake accounts against, so callers do not need to track them; this throws if the validator
// has no entry in the list (e.g. after CleanupRemovedValidatorEntries), so pass both seeds
// explicitly in that case.
export async function updateValidatorListBalance(
  validatorVoteAccount: PublicKey,
  stakePoolAccount: PublicKey,
  poolWithdrawAuthority: PublicKey,
  validatorListAccount: PublicKey,
  poolReserveStakeAccount: PublicKey,
  transientStakeSeed?: number | BN,
  validatorSeed?: number
) {

  const provider = AnchorProvider.local(undefined, CONFIRMED_OPTS);

  if (transientStakeSeed === undefined || validatorSeed === undefined) {
    const info = await getValidatorStakeInfo(provider.connection, validatorListAccount, validatorVoteAccount);
    transientStakeSeed ??= recordedTransientStakeSeed(info);
    validatorSeed ??= recordedValidatorSeed(info);
  }

  const updateValidatorListBalanceIx = buildUpdateValidatorListBalanceIx(
    validatorVoteAccount,
    stakePoolAccount,
    poolWithdrawAuthority,
    validatorListAccount,
    poolReserveStakeAccount,
    transientStakeSeed,
    validatorSeed
  );

  // send the UpdateValidatorListBalance transaction
  const transaction = new Transaction().add(updateValidatorListBalanceIx);
  const { blockhash } = await provider.connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = provider.publicKey;

  let txHash: string;
  try {
    txHash = await provider.sendAndConfirm(transaction, [], {
      commitment: "confirmed",
    });
  } catch (e: any) {
    // When stake is still transitioning right after validator removal, the cloned stake-pool
    // program can return Unsupported sysvar on this instruction path.
    // Move one epoch forward and retry once.
    const message = e?.message ?? "";
    if (message.includes("Unsupported sysvar")) {
      await moveEpochForward(provider.connection, 1);
      const retryTx = new Transaction().add(updateValidatorListBalanceIx);
      const { blockhash: retryBlockhash } =
        await provider.connection.getLatestBlockhash("confirmed");
      retryTx.recentBlockhash = retryBlockhash;
      retryTx.feePayer = provider.publicKey;
      txHash = await provider.sendAndConfirm(retryTx, [], {
        commitment: "confirmed",
      });
    } else {
      throw e;
    }
  }

  assert.ok(txHash);
}


export async function updatePoolStakeBalance(
  stakePoolAccount: PublicKey,
  poolWithdrawAuthority: PublicKey,
  validatorListAccount: PublicKey,
  poolReserveStakeAccount: PublicKey,
  poolMintAccount: PublicKey,
  feeAccount: PublicKey,
) {

  const provider = AnchorProvider.local(undefined, CONFIRMED_OPTS);

  // Construct the UpdateStakePoolBalance instruction
  const updateStakePoolBalanceIx = new TransactionInstruction({
    programId: STAKE_POOL_PROGRAM_ID,
    keys: [
      { pubkey: stakePoolAccount, isSigner: false, isWritable: true }, // Stake pool
      { pubkey: poolWithdrawAuthority, isSigner: false, isWritable: false }, // Withdraw authority PDA
      { pubkey: validatorListAccount, isSigner: false, isWritable: true }, // Validator list
      { pubkey: poolReserveStakeAccount, isSigner: false, isWritable: false }, // Reserve stake account
      { pubkey: feeAccount, isSigner: false, isWritable: true }, // Fee account
      { pubkey: poolMintAccount, isSigner: false, isWritable: true }, // Pool mint
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // Token program
    ],
    data: Buffer.from(Uint8Array.of(7)), // Instruction index for UpdateStakePoolBalance
  });

  // Send the UpdateStakePoolBalance transaction
  const transaction = new Transaction().add(updateStakePoolBalanceIx);
  const { blockhash } = await provider.connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = provider.publicKey;

  const txHash = await provider.sendAndConfirm(transaction, [], {
    commitment: "confirmed",
  });

  assert.ok(txHash);
}

export async function increaseAdditionalValidatorStake(
  lamports: number,
  stakePoolAccount: PublicKey,
  staker: Keypair,
  poolWithdrawAuthority: PublicKey,
  validatorListAccount: PublicKey,
  validatorVoteAccount: PublicKey,
  poolReserveStakeAccount: PublicKey,
  transientStakeSeed: number = 0,
) {

  const provider = AnchorProvider.local(undefined, CONFIRMED_OPTS);
  const connection = provider.connection;

  // find ephemeral uninitialized stake account
  const [ephemeralAccount] = PublicKey.findProgramAddressSync([
    Buffer.from("ephemeral"),
    stakePoolAccount.toBuffer(),
    new BN(1).toArrayLike(Buffer, "le", 8),
  ],
    STAKE_POOL_PROGRAM_ID
  );

  const [transientStakeAccount] = await PublicKey.findProgramAddressSync(
    [
      Buffer.from("transient"),
      validatorVoteAccount.toBuffer(),
      stakePoolAccount.toBuffer(),
      new BN(transientStakeSeed).toArrayLike(Buffer, "le", 8),
    ],
    STAKE_POOL_PROGRAM_ID
  );

  const [validatorStakeAccount] = PublicKey.findProgramAddressSync([
    validatorVoteAccount.toBuffer(),
    stakePoolAccount.toBuffer(),
  ],
    STAKE_POOL_PROGRAM_ID
  );

  const instructionData = new increaseAdditionalValidatorStakeData({
    instruction: 19, // Instruction index for `increaseAdditionalValidatorStake`
    lamports: BigInt(lamports),
    transientStakeSeed: BigInt(transientStakeSeed),
    ephemeralStakeSeed: BigInt(1),
  });

  const data = Buffer.from(borsh.serialize(IncreaseStakeSchema, instructionData));

  // Construct the UpdateStakePoolBalance instruction
  const increaseValidatorStakeIx = new TransactionInstruction({
    programId: STAKE_POOL_PROGRAM_ID,
    keys: [
      { pubkey: stakePoolAccount, isSigner: false, isWritable: false }, // Stake pool
      { pubkey: staker.publicKey, isSigner: true, isWritable: false }, // Stake pool staker
      { pubkey: poolWithdrawAuthority, isSigner: false, isWritable: false }, // Withdraw authority PDA
      { pubkey: validatorListAccount, isSigner: false, isWritable: true }, // Validator list
      { pubkey: poolReserveStakeAccount, isSigner: false, isWritable: true }, // Reserve stake account
      { pubkey: ephemeralAccount, isSigner: false, isWritable: true }, // Ephemeral stake account
      { pubkey: transientStakeAccount, isSigner: false, isWritable: true }, // Transient stake account
      { pubkey: validatorStakeAccount, isSigner: false, isWritable: true }, // Validator stake account
      { pubkey: validatorVoteAccount, isSigner: false, isWritable: false }, // Validator vote account
      { pubkey: web3.SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false }, // Clock sysvar
      { pubkey: web3.SYSVAR_STAKE_HISTORY_PUBKEY, isSigner: false, isWritable: false }, // Stake history sysvar
      { pubkey: new PublicKey("StakeConfig11111111111111111111111111111111"), isSigner: false, isWritable: false }, // Stake config
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // System program
      { pubkey: StakeProgram.programId, isSigner: false, isWritable: false }, // Stake program
    ],
    data
  });

  // Send the increaseAdditionalValidatorStake transaction
  const transaction = new Transaction().add(increaseValidatorStakeIx);
 
  let tx = await provider.sendAndConfirm(transaction, [staker]);
  assert.ok(tx);

  let transientStakeAccountInfo = await connection.getParsedAccountInfo(transientStakeAccount);
  const stakeAccountRent = await provider.connection.getMinimumBalanceForRentExemption(StakeProgram.space);

  assert(BigInt(transientStakeAccountInfo.value.lamports) == BigInt(lamports) + BigInt(stakeAccountRent));
}

export async function deposit(
  connection: Connection,
  program: anchor.Program<Staker>,
  sender: anchor.Wallet,
  accounts: StakePoolAccounts,
  depositAmount: BN
) {

  // get sender's ata
  const senderATA = await getAssociatedTokenAddress(
    accounts.poolMintAccount,
    sender.publicKey,
  );

  // create sender's ata if it doesn't exist
  const accountInfo = await connection.getAccountInfo(senderATA);
  if (!accountInfo) {
    await createAssociatedTokenAccount(
      connection,
      sender.payer, // payer
      accounts.poolMintAccount,
      sender.payer.publicKey, // owner
    );
  }

  // send the deposit transaction
  const tx = await program.methods.deposit(depositAmount)
    .accounts({
      user: sender.publicKey,
      stakePool: accounts.stakePoolAccount,
      depositAuthority: accounts.depositAuthorityAccount,
      withdrawAuthority: accounts.withdrawAuthorityAccount,
      poolReserve: accounts.reserveStakeAccount,
      userPoolTokenAccount: senderATA,
      feeTokenAccount: accounts.feesTokenAccount,
      poolMint: accounts.poolMintAccount,
      referralFeeTokenAccount: accounts.feesTokenAccount,
    })
    .signers([sender.payer])
    .rpc();

  assert.ok(tx);

  return tx;
}


export async function decodeValidatorListAccount(connection, validatorListPubkey) {
  // Fetch the Validator List account
  const accountInfo = await connection.getAccountInfo(validatorListPubkey);
  if (!accountInfo) {
    throw new Error("Validator List account not found");
  }

  // deserialize the header
  const data = accountInfo.data;
  const header = borsh.deserialize(
    ValidatorListHeaderSchema,
    ValidatorListHeader,
    data.slice(0, 5) // First 5 bytes for ValidatorListHeader
  );

  // fetch how many validators are in the array 
  const numValidators = new DataView(data.buffer, data.byteOffset + 5, 4).getUint32(0, true);

  // deserialize the validators array
  const validators = [];
  const validatorSize = 73; // size of each ValidatorStakeInfo struct
  const validatorsData = data.slice(5 + 4); // Skip the header (5 bytes) + vec length (4 bytes)

  for (let i = 0; i < numValidators; i++) {
    const start = i * validatorSize;
    const end = start + validatorSize;
    if (start >= validatorsData.length) break;

    const validator = borsh.deserialize(
      ValidatorStakeInfoSchema,
      ValidatorStakeInfo,
      validatorsData.slice(start, end)
    );
    
    // if the vote account address is not the default, add it to the list
    if (validator.vote_account_address.toBase58() !== "11111111111111111111111111111111") {
      validators.push(validator);
    } 
  }

  return new ValidatorList({ header, validators });
}

export function stakeStatusToString(status: StakeStatus): string {
    switch (status) {
        case StakeStatus.Active:
            return "Active";
        case StakeStatus.DeactivatingTransient: 
            return "DeactivatingTransient";
        case StakeStatus.ReadyForRemoval:
            return "ReadyForRemoval";
        case StakeStatus.DeactivatingValidator:
            return "DeactivatingValidator";
        case StakeStatus.DeactivatingAll:
            return "DeactivatingAll";
    }
}
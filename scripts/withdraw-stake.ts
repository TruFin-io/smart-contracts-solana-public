import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, BN, Wallet, web3 } from "@coral-xyz/anchor";
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, StakeProgram, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import { decodeValidatorListAccount, getStakePool } from "../tests/helpers";
import { StakePool } from "../tests/stake_pool/types";
import { getConnection, getStakePoolAccount, getStakePoolProgramId } from "./utils";

// Get the Solana connection
const connection = getConnection();

// get config variables
const stake_pool_program_id = new PublicKey(getStakePoolProgramId());
const stake_pool_account = new PublicKey(getStakePoolAccount());

const owner_keypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(`${process.cwd()}/accounts/owner.json`, "utf-8")))
);

// Configure the Solana connection and Anchor provider
const provider = new AnchorProvider(connection, new Wallet(owner_keypair), { commitment: "confirmed" });
anchor.setProvider(provider);

// A script to withdraw staked SOL from a validator or the pool reserve account.
// usage: yarn withdraw-stake <user_name> <amount> <validator>
//   e.g. yarn withdraw-stake carlo 1 FwR3PbjS5iyqzLiLugrBqKSa5EKZ4vK9SKs7eQXtT59f
// Args:
// <user_name> : name of the user json keypair file in the user home dir (e.g. ~/.config/solana/carlo.json)
// <amount> : the amount of SOL to withdraw
// <validator> : the validator vote account to withdraw from.

async function main() {

  // parse arguments
  const args = process.argv.slice(2);

  const username = args.length === 3 && args[0];
  if (!username) {
    console.error("Usage: yarn withdraw-stake <user_name> <amount> <validator>");
    process.exit(1);
  }

  // the TruSOL amount to withdraw
  const truSolWithdrawAmount = args.length === 3 && new BN(Number(args[1]) * LAMPORTS_PER_SOL);
  if (!truSolWithdrawAmount) {
    console.error("Usage: yarn withdraw-stake <user_name> <amount> <validator>");
    process.exit(1);
  }

  const validatorVoteAccount = args.length === 3 && new PublicKey(args[2])
  if (!validatorVoteAccount) {
    console.error("Usage: yarn withdraw-stake <user_name> <amount> <validator>");
    process.exit(1);
  }

  // get user keypair
  const user_keypair_file = `${os.homedir()}/.config/solana/${username}.json`;
  if (!fs.existsSync(user_keypair_file)) {
    console.error(`Keypair file ${username}.json not found under ${os.homedir()}/.config/solana/`);
    process.exit(1);
  }
  const user = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(user_keypair_file, "utf-8")))
  );

  // fetch the stake pool and calculate the share price
  const stakePool = await getStakePool(connection, stake_pool_account);
  const totalLamports = new anchor.BN(stakePool.totalLamports.toString()).toNumber();
  const poolTokenSupply = new anchor.BN(stakePool.poolTokenSupply.toString()).toNumber();
  const sharePrice = Math.floor(totalLamports * 1e9 / poolTokenSupply) / 1e9;
  console.log("Share price:", sharePrice);

  // calculate the expected SOL that will be withdrawn
  const expectedSOL = Math.round(truSolWithdrawAmount.toNumber() * sharePrice) ;
  console.log(`Withdrawing ${truSolWithdrawAmount} TruSOL. Expecting to withdraw ${expectedSOL} staked SOL`);

  // check that the expected SOL is above the minimum withdrawal amount required by the new stake account
  // that will be created to receive the withdrawn stake
  const minLamportsOnStakeAccount = await getMinLamportsOnStakeAccount(connection);
  
  // withdrawal fees as a percentage
  const feePrecision = 1e4;
  const stakeWithdrawalFee = Number(
    BigInt(feePrecision) * stakePool.stakeWithdrawalFee.numerator / stakePool.stakeWithdrawalFee.denominator
  ) / feePrecision;

  console.log(`Stake Withdrawal Fee percentage: ${Number(stakeWithdrawalFee * 100)}%`);  // 1% in devnet 0.1% in devnet

  // add the expected fees to the `minLamportsOnStakeAccount` to ensure the min lamports requirement in the stake account is fulfilled
  // after the fees are deducted by the pool from the amount withdrawn.
  const minSolWithdrawalBeforeFees = Math.round(minLamportsOnStakeAccount  + (stakeWithdrawalFee * minLamportsOnStakeAccount));
  
  console.log("Expected fee:", Math.round(expectedSOL * stakeWithdrawalFee), "lamports");
  console.log("Min SOL to leave on stake account:", minLamportsOnStakeAccount);
  console.log("Min SOL to withdraw (before fees):", minSolWithdrawalBeforeFees);

  if (expectedSOL < minSolWithdrawalBeforeFees) {
    const minTruSOLBeforeFees = Math.round(minSolWithdrawalBeforeFees / sharePrice);

    console.error("Withdraw amount too low");
    console.error("Expected SOL: ", expectedSOL, `${expectedSOL / LAMPORTS_PER_SOL} SOL`);
    console.error("Min SOL withdrawal (before fees):", minSolWithdrawalBeforeFees, `${minSolWithdrawalBeforeFees / LAMPORTS_PER_SOL} SOL`);
    console.error("Min TruSOL withdrawal (before fees):", minTruSOLBeforeFees, `${Math.round(minTruSOLBeforeFees) / LAMPORTS_PER_SOL} TruSOL`);
    process.exit(1);
  }

  // find the stake account to withdraw from.
  const stakeAccountToSplit = await getStakeAccountToSplit(
      connection,
      stakePool,
      stake_pool_account,
      stake_pool_program_id,
      validatorVoteAccount,
      expectedSOL,
      sharePrice
    );

  if (!stakeAccountToSplit) {
    console.error("No stake account to split found.");
    process.exit(1);
  }

  // generate a new stake account to receive the withdrawn stake
  const newStakeAccount = web3.Keypair.generate();

  // instruction to create the new stake account
  let stakeAccountRent = await provider.connection.getMinimumBalanceForRentExemption(StakeProgram.space);
  const createAccountIx = SystemProgram.createAccount({
    fromPubkey: user.publicKey,
    newAccountPubkey: newStakeAccount.publicKey,
    lamports: stakeAccountRent,
    space: StakeProgram.space,
    programId: StakeProgram.programId,
  });

  // derive the user's TruSOL ATA
  const userPoolTokenATA = await getAssociatedTokenAddress(
    stakePool.poolMint,
    user.publicKey // Owner (user)
  );

  // derive the withdraw authority (PDA)
  const [poolWithdrawAuthorityPDA] = PublicKey.findProgramAddressSync(
    [stake_pool_account.toBuffer(), Buffer.from("withdraw")],
    stake_pool_program_id
  );

  // construct the WithdrawSol instruction
  const withdrawStakeIx = new TransactionInstruction({
    programId: stake_pool_program_id,
    keys: [
      {
        pubkey: stake_pool_account,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: stakePool.validatorList,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: poolWithdrawAuthorityPDA,
        isSigner: false,
        isWritable: false,
      }, // Stake pool withdraw authority
      {
        pubkey: stakeAccountToSplit,
        isSigner: false,
        isWritable: true,
      }, // Validator stake, validator transient account, or pool reserve account to split
      {
        pubkey: newStakeAccount.publicKey,
        isSigner: false,
        isWritable: true,
      },
      { pubkey: user.publicKey, isSigner: false, isWritable: false },
      { pubkey: user.publicKey, isSigner: true, isWritable: false },
      { pubkey: userPoolTokenATA, isSigner: false, isWritable: true },
      {
        pubkey: stakePool.managerFeeAccount,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: stakePool.poolMint,
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
      new BN(truSolWithdrawAmount).toArrayLike(Buffer, "le", 8), // Withdraw amount of TruSOL (u64)
    ]),
  });

  // send the transaction with the instructions to create the stake account and WithdrawStake
  console.log(`Withdrawing ${Number(truSolWithdrawAmount)} TruSOL from ${validatorVoteAccount.toBase58()} to stake account ${newStakeAccount.publicKey.toBase58()}`);
  const transaction = new Transaction()
    .add(createAccountIx)
    .add(withdrawStakeIx);

  const tx = await provider.sendAndConfirm(transaction, [user, newStakeAccount]);
  console.log("Tx hash:", tx);
}

// Given a validatorVoteAccount, determines what stake account should be used in the WithdrawStake instruction to split the stake.
// Returns the stake account to split, or undefined if no suitable account is found.
// Depending on the balance of the stake accounts in the pool, the account returned can be an active stake account, a transient stake account, or the pool reserve account.
// The user can withdraw from a transient account only if the active stake accounts for all validators are at minimum balance.
// The user can withdraw from the reserve account only if all active stake accounts and transient accounts are at minimum balance.
async function getStakeAccountToSplit(
  connection: Connection,
  stakePool: StakePool,
  stake_pool_account: PublicKey,
  stake_pool_program_id: PublicKey,
  validatorVoteAccount: PublicKey,
  expectedSOL: number,
  sharePrice: number
): Promise<PublicKey | undefined> {

  const [validatorStakeAccount] = PublicKey.findProgramAddressSync(
    [
      validatorVoteAccount.toBuffer(),
      stake_pool_account.toBuffer(),
    ],
    stake_pool_program_id
  );
  console.log("Validator stake account:", validatorStakeAccount.toBase58());

  const transientStakeSeed = 0;
  const [transientStakeAccount] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("transient"),
      validatorVoteAccount.toBuffer(),
      stake_pool_account.toBuffer(),
      new BN(transientStakeSeed).toArrayLike(Buffer, "le", 8),
    ],
    stake_pool_program_id
  );
  console.log("Transient stake account:", transientStakeAccount.toBase58());

  const stakeAccountBalance = await connection.getBalance(validatorStakeAccount);
  const minLamportsOnStakeAccount = await getMinLamportsOnStakeAccount(connection);
  if (expectedSOL <= stakeAccountBalance - minLamportsOnStakeAccount ) {
    console.log("Withdrawing from validator stake account:", validatorStakeAccount.toBase58());
    console.log("Validator stake account has sufficient balance to withdraw. expectedSOL: ", expectedSOL, "stakeAccountBalance:", stakeAccountBalance, "minLamportsOnStakeAccount:", minLamportsOnStakeAccount);
    return validatorStakeAccount;
  }

  if (stakeAccountBalance > minLamportsOnStakeAccount) {
    const availableToWithdraw = stakeAccountBalance - minLamportsOnStakeAccount;
    const withdrawFee = Number(stakePool.stakeWithdrawalFee.numerator) / Number(stakePool.stakeWithdrawalFee.denominator)
    const maxTruSol = Math.round(availableToWithdraw * (1 + withdrawFee) / sharePrice);

    // log some withdrawal information about from this validator
    console.log("Selected validator stake account has active balance that needs to be withdrawn first.");
    console.log("stakeAccountBalance:", stakeAccountBalance, "availableToWithdraw:", availableToWithdraw, "expectedSOL: ", expectedSOL, "minLamportsOnStakeAccount:", minLamportsOnStakeAccount);
    console.log(`Uer max Withdraw: ${maxTruSol} TruSOL (${availableToWithdraw} SOL + ${withdrawFee}% withdraw fee)`);
    return validatorStakeAccount
  }

  // find validators with active stake above min stake account balance
  const validators = await decodeValidatorListAccount(connection, stakePool.validatorList);
  const validatorsWithStake = validators.validators.filter((validator) => {
    return Number(validator.active_stake_lamports) > minLamportsOnStakeAccount;
  });

  // if any validators have active stake to withdraw return no account to split
  if (validatorsWithStake.length > 0) {
    console.log("Found validators with active stake. Withdraw from these validators first.");
    validatorsWithStake.forEach((validator) => {
      console.log(`- validator: ${validator.vote_account_address.toBase58()} stake account: ${validator.active_stake_lamports} lamports`);
    });
    return undefined;
  }

  console.log("All stake accounts are at minimum balance.");

  // check if the transient account has sufficient balance and if so return it
  const transientAccountBalance = await connection.getBalance(transientStakeAccount);
  if (expectedSOL <= transientAccountBalance - minLamportsOnStakeAccount) {
    console.log("Withdrawing from transient stake account:", transientStakeAccount.toBase58());
    return transientStakeAccount;
  }

  // find validators with transient stake
  const validatorsWithTransientStake = validators.validators.filter((validator) => {
    return Number(validator.transient_stake_lamports) > minLamportsOnStakeAccount;
  });

  if (validatorsWithTransientStake.length > 0) {
    console.log("Found validators with transient stake. Withdraw from these validators first.");
    validatorsWithTransientStake.forEach((validator) => {
      console.log(`- validator: ${validator.vote_account_address.toBase58()} transient stake account: ${validator.transient_stake_lamports} lamports`);
    });
    return undefined;
  }

  console.log("All transient accounts are at minimum balance.");

  // if all stake and transient account are at min balance try to withdraw from the reserve account
  console.log("Trying to withdraw from the resere account.", stakePool.reserveStake.toBase58());
  return stakePool.reserveStake;
}

// Returns the minimum amount of lamports required in a stake account for the current network.
// Currently 1002282880 lamports in testnet, 3282880 lamports in devnet and mainnet
async function getMinLamportsOnStakeAccount(connection: Connection): Promise<number> {

  // Minimum amount of staked lamports required in a validator stake account to allow for merges
  // without a mismatch on credits observed
  const MINIMUM_ACTIVE_STAKE = 1_000_000;

  // Stake minimum delegation, currently 1 SOL in testnet, 1 lamport in devnet and mainnet
  const stakeMinDelegation = await connection.getStakeMinimumDelegation();

  // The minimum delegation must be at least the minimum active stake
  const minDelegation = Math.max(stakeMinDelegation.value, MINIMUM_ACTIVE_STAKE);
  const stakeAccountRent = await connection.getMinimumBalanceForRentExemption(StakeProgram.space);

  // The minimum balance required in a stake account is the minimum delegation plus rent
  return minDelegation + stakeAccountRent;
}

// Run the main function
main().catch((error) => {
  console.error("Unexpected error:", error);
  process.exit(1);
});

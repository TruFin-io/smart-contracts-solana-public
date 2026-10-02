import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import { Account, createAssociatedTokenAccountInstruction, getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import { getStakePool, randomStakeSeed } from "../tests/helpers";
import { getConnection, getStakePoolProgramId, getStakerProgramId, getStakePoolAccount } from "./utils";

// Get the Solana connection
const connection = getConnection();


// get config variables
const stake_pool_program_id = new PublicKey(getStakePoolProgramId());
const staker_program_id = new PublicKey(getStakerProgramId());
const stake_pool_account = new PublicKey(getStakePoolAccount());

const owner_keypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(`${process.cwd()}/accounts/owner.json`, "utf-8")))
);

// Configure the Solana connection and Anchor provider
const provider = new AnchorProvider(connection, new Wallet(owner_keypair), { commitment: "confirmed" });
anchor.setProvider(provider);


// A script to deposit SOL into a stake account of a specific validator
// usage: yarn deposit-to-specific-validator <user_name> <validator> <amount>
//   e.g. yarn deposit-to-specific-validator carlo FwR3PbjS5iyqzLiLugrBqKSa5EKZ4vK9SKs7eQXtT59f 1
// Args:
// <user_name> : name of the user json keypair file in the user home dir (e.g. ~/.config/solana/carlo.json)
// <amount> : the amount of SOL to deposit
async function main() {

  // parse arguments
  const args = process.argv.slice(2);

  const username = args.length === 3 && args[0];
  if (!username) {
    console.error("Usage: yarn deposit-to-specific-validator <user_name> <validator> <amount>");
    process.exit(1);
  }

  const validatorVoteAccount = args.length === 3 && new PublicKey(args[1]);
  if (!validatorVoteAccount) {
    console.error("Usage: yarn deposit-to-specific-validator <user_name> <validator> <amount>");
    process.exit(1);
  }

  const depositAmount = args.length === 3 && new BN(Number(args[2]) * LAMPORTS_PER_SOL);
  if (!depositAmount) {
    console.error("Usage: yarn deposit-to-specific-validator <user_name> <validator> <amount>");
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


  console.log(`User ${user.publicKey} depositing ${Number(args[1])} SOL to validator ${validatorVoteAccount} ...`);

  // Load the program deployed at the specified address
  const program = await Program.at(staker_program_id, provider);
  const stakePool = await getStakePool(connection, stake_pool_account);

  // get the user's TruSOL associated token account
  let userPoolTokenATA = getAssociatedTokenAddressSync(
    stakePool.poolMint,
    user.publicKey,
  );

  // check if the user associated token account exists and create it if it doesn't
  let createAccountIx: TransactionInstruction;
  let tokenAccount: Account;
  try {
    console.log("TruSOL associated token account: ", userPoolTokenATA.toBase58());
    tokenAccount = await getAccount(connection, userPoolTokenATA);
    console.log("Found associated token account. Balance: ", Number(tokenAccount.amount) / 1e9, "TruSOL");
  } catch (error) {
    console.log("TruSOL associated token account not found");
    console.log("Creating TruSOL associated token account at address", userPoolTokenATA.toBase58());

    createAccountIx = createAssociatedTokenAccountInstruction(
      user.publicKey,
      userPoolTokenATA,
      user.publicKey,
      stakePool.poolMint
    )
  }

  // derive the withdraw authority PDA
  const [poolWithdrawAuthority] = PublicKey.findProgramAddressSync(
    [stake_pool_account.toBuffer(), Buffer.from("withdraw")],
    stake_pool_program_id
  );
  console.log("poolWithdrawAuthority PDA:", poolWithdrawAuthority.toBase58());

  const [userWhitelistPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("user"), user.publicKey.toBuffer()],
    program.programId
  );
  console.log("userWhitelist PDA: ", userWhitelistPDA.toBase58());

  // derive the transient stake account PDA
  const transientStakeSeed = 0;
  const [transientStakeAccount] = await PublicKey.findProgramAddressSync(
    [
      Buffer.from("transient"),
      validatorVoteAccount.toBuffer(),
      stake_pool_account.toBuffer(),
      new BN(transientStakeSeed).toArrayLike(Buffer, "le", 8),
    ],
    stake_pool_program_id
  );

  // derive the ephemeral stake account PDA using a fresh random seed so the pool-global
  // ephemeral address is never fixed
  const ephemeralStakeSeed = randomStakeSeed();
  const [ephemeralStakeAccount] = await PublicKey.findProgramAddressSync(
    [
      Buffer.from("ephemeral"),
      stake_pool_account.toBuffer(),
      ephemeralStakeSeed.toArrayLike(Buffer, "le", 8),
    ],
    stake_pool_program_id
  );

  // derive the validator stake account PDA
  const [validatorStakeAccount] = PublicKey.findProgramAddressSync(
    [
      validatorVoteAccount.toBuffer(),
      stake_pool_account.toBuffer(),
    ],
    stake_pool_program_id
  );

  // deposit to specific validator instruction
  const depositIx = await program.methods.depositToSpecificValidator(depositAmount, ephemeralStakeSeed)
    .accounts({
      user: user.publicKey,
      stakePool: stake_pool_account,
      depositAuthority: stakePool.stakeDepositAuthority,
      withdrawAuthority: poolWithdrawAuthority,
      poolReserve:  stakePool.reserveStake,
      userPoolTokenAccount: userPoolTokenATA,
      feeTokenAccount: stakePool.managerFeeAccount,
      poolMint: stakePool.poolMint,
      referralFeeTokenAccount: stakePool.managerFeeAccount,
      validatorList: stakePool.validatorList,
      ephemeralStakeAccount: ephemeralStakeAccount,
      transientStakeAccount: transientStakeAccount,
      validatorStakeAccount: validatorStakeAccount,
      validatorVoteAccount: validatorVoteAccount,
    })
    .instruction();

  // build the transaction with the create account instruction if needed
  const transaction = new Transaction();
  if (!tokenAccount) {
    console.log("adding instruction to create the associated token account");
    transaction.add(createAccountIx);
  }
  transaction.add(depositIx);

  const txHash = await provider.sendAndConfirm(transaction, [user]);
  console.log("DepositToSpecificValidator tx hash:", txHash);
}

// Run the main function
main().catch((error) => {
    console.error("Unexpected error:", error);
    process.exit(1);
});

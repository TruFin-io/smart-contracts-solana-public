import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import { findValidatorStakeAccount, getStakePool } from "../tests/helpers";
import { getConnection, getStakePoolProgramId, getStakerProgramId, getStakePoolAccount } from "./utils";

// Get the Solana connection
const connection = getConnection();

// get config variables
const stake_pool_program_id = new PublicKey(getStakePoolProgramId());
const staker_program_id = new PublicKey(getStakerProgramId());
const stake_pool_account = new PublicKey(getStakePoolAccount());

// load the owner keypair
const owner_keypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(`${process.cwd()}/accounts/owner.json`, "utf-8"))) // Replace with your keypair file
);

// Configure the Solana connection and Anchor provider
const provider = new AnchorProvider(connection, new Wallet(owner_keypair), { commitment: "confirmed" });
anchor.setProvider(provider);

// A script to add a validator to the stake pool. The optional seed (a u32, default 0) picks the
// validator's stake account address, e.g. to route around an occupied seed-0 address; it is
// recorded in the validator list and fixed for the validator's life.
// usage: yarn add-validator <validator_vote_account> [validator_seed]
async function main() {

  // get the address of the validator vote account to add
  const args = process.argv.slice(2);
  const validatorVoteAccount = new PublicKey(args[0])
  if (!validatorVoteAccount) {
    console.error("Usage: yarn add-validator <validator_vote_account> [validator_seed]");
    process.exit(1);
  }
  const seed = args[1] === undefined ? 0 : Number(args[1]);
  if (!/^\d+$/.test(args[1] ?? "0") || seed > 0xffffffff) {
    console.error(`validator_seed must be a non-negative integer below 2^32, got "${args[1]}"`);
    process.exit(1);
  }

  const stakePool = await getStakePool(provider.connection, stake_pool_account);

  // build the AddValidatorToPool instruction
  const [poolWithdrawAuthority] = PublicKey.findProgramAddressSync(
    [stake_pool_account.toBuffer(), Buffer.from("withdraw")],
    stake_pool_program_id
  );

  const validatorStakeAccount = findValidatorStakeAccount(validatorVoteAccount, stake_pool_account, seed, stake_pool_program_id);
  console.log("validatorStakeAccount:", validatorStakeAccount.toBase58(), "validator_seed:", seed);

  // owner calls add_validator
  const program = await Program.at(staker_program_id, provider);

  const tx = await program.methods
    .addValidator(seed)
    .accounts({
      stakePool: stake_pool_account,
      reserveStake: stakePool.reserveStake,
      withdrawAuthority: poolWithdrawAuthority,
      validatorList: stakePool.validatorList,
      validatorStakeAccount: validatorStakeAccount,
      validatorVoteAccount: validatorVoteAccount,
    })
    .signers([owner_keypair])
    .rpc();

  console.log("AddValidator tx:", tx);
}

// Run the main function
main().catch((error) => {
    console.error("Unexpected error:", error);
    process.exit(1);
});

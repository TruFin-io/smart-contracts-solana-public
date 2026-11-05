import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import {
  findValidatorStakeAccount,
  getStakePool,
  getValidatorStakeInfo,
  recordedTransientStakeSeed,
  recordedValidatorSeed,
} from "../tests/helpers";
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

const provider = new AnchorProvider(
  connection,
  new Wallet(owner_keypair),
  { commitment: "confirmed" }
);
anchor.setProvider(provider);


// A script to remove a validator stake account from the stake pool
// usage: yarn remove-validator <validator_vote_account>
async function main() {

  // get the address of the validator vote account to remove
  const args = process.argv.slice(2);
  const validatorVoteAccount = args.length === 1 && new PublicKey(args[0])
  if (args.length !== 1 || !validatorVoteAccount) {
    console.error("Usage: yarn remove-validator <validator_vote_account>");
    process.exit(1);
  }

  const stakePool = await getStakePool(provider.connection, stake_pool_account);

  const [poolWithdrawAuthority] = PublicKey.findProgramAddressSync(
    [stake_pool_account.toBuffer(), Buffer.from("withdraw")],
    stake_pool_program_id
  );

  // SPL checks the stake accounts against the seeds recorded in the validator list. The transient
  // seed changes every time a transient is created with a new seed (see README "Ephemeral and
  // transient stake seeds"), so neither may be assumed to be 0
  const validatorInfo = await getValidatorStakeInfo(provider.connection, stakePool.validatorList, validatorVoteAccount);
  const validatorStakeAccount = findValidatorStakeAccount(
    validatorVoteAccount, stake_pool_account, recordedValidatorSeed(validatorInfo), stake_pool_program_id
  );
  console.log("validatorStakeAccount:", validatorStakeAccount.toBase58());

  const transientStakeSeed = recordedTransientStakeSeed(validatorInfo);
  const [transientStakeAccount] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("transient"),
      validatorVoteAccount.toBuffer(),
      stake_pool_account.toBuffer(),
      transientStakeSeed.toArrayLike(Buffer, "le", 8),
    ],
    stake_pool_program_id
  );
  console.log("transientStakeAccount:", transientStakeAccount.toBase58(), "transientStakeSeed:", transientStakeSeed.toString());

  // owner calls remove_validator
  const program = await Program.at(staker_program_id, provider);

  const tx = await program.methods
      .removeValidator()
      .accounts({
        stakePool: stake_pool_account,
        withdrawAuthority: poolWithdrawAuthority,
        validatorList: stakePool.validatorList,
        validatorStakeAccount: validatorStakeAccount,
        transientStakeAccount: transientStakeAccount,
      })
      .signers([owner_keypair])
      .rpc();

  console.log("RemoveValidator tx:", tx);
}

// Run the main function
main().catch((error) => {
    console.error("Unexpected error:", error);
    process.exit(1);
});

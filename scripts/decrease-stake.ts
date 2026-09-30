import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import { getStakePool, randomStakeSeed } from "../tests/helpers";
import { getConnection, getStakePoolProgramId, getStakerProgramId, getStakePoolAccount } from "./utils";

// Get the Solana connection
const connection = getConnection();

// get config variables
const stake_pool_program_id = new PublicKey(getStakePoolProgramId());
const staker_program_id = new PublicKey(getStakerProgramId());
const stake_pool_account = new PublicKey(getStakePoolAccount());

const owner_keypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(`${process.cwd()}/accounts/owner.json`, "utf-8"))) // Replace with your keypair file
);

const stake_manager_keypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(`${process.cwd()}/accounts/stake-manager.json`, "utf-8")))
);

// Configure the Solana connection and Anchor provider
const provider = new AnchorProvider(connection, new Wallet(owner_keypair), { commitment: "confirmed" });
anchor.setProvider(provider);


/// A script to decrease the additional stake of a validator
// usage: yarn decrease-stake <validator> <amount> [ephemeral_seed]
// The optional ephemeral_seed lets the operator route around a poisoned ephemeral PDA;
// when omitted a fresh random seed is used.
async function main() {

  // parse arguments
  const args = process.argv.slice(2);
  const validatorVoteAccount = args.length >= 2 && new PublicKey(args[0])
  if (!validatorVoteAccount) {
    console.error("Usage: yarn decrease-stake <validator> <amount> [ephemeral_seed]");
    process.exit(1);
  }

  const decreaseStakeAmount = args.length >= 2 && Number(args[1]) * LAMPORTS_PER_SOL
  if (!decreaseStakeAmount) {
    console.error("Usage: yarn decrease-stake <validator> <amount> [ephemeral_seed]");
    process.exit(1);
  }

  const ephemeralSeedArg = args[2] ? new BN(args[2]) : null;

  console.log(
    "validatorVoteAccount:", validatorVoteAccount.toBase58(),
    "decrease amount:", decreaseStakeAmount, `${decreaseStakeAmount / LAMPORTS_PER_SOL} SOL`
  );

  // Load the program deployed at the specified address
  const stakePool = await getStakePool(connection, stake_pool_account);

  // derive the required accounts
  const [poolWithdrawAuthority] = PublicKey.findProgramAddressSync(
    [stake_pool_account.toBuffer(), Buffer.from("withdraw")],
    stake_pool_program_id
  );

  const [validatorStakeAccount] = PublicKey.findProgramAddressSync([
    validatorVoteAccount.toBuffer(),
    stake_pool_account.toBuffer(),
  ],
  stake_pool_program_id
  );

  // default the ephemeral seed to a fresh random value; an explicit seed can be passed to
  // reuse/route around a specific ephemeral PDA.
  const ephemeralStakeSeed = ephemeralSeedArg ?? randomStakeSeed();
  const [ephemeralStakeAccount] = await PublicKey.findProgramAddressSync(
    [
      Buffer.from("ephemeral"),
      stake_pool_account.toBuffer(),
      ephemeralStakeSeed.toArrayLike(Buffer, "le", 8),
    ],
    stake_pool_program_id
  );

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

  console.log(
    "transientStakeAccount:", transientStakeAccount.toBase58(),
    "transientStakeSeed:", transientStakeSeed,
    "ephemeralStakeAccount:", ephemeralStakeAccount.toBase58(),
    "ephemeralStakeSeed:", ephemeralStakeSeed.toString()
  );

  // stake_maanger calls decrease_validator_stake
  const program = await Program.at(staker_program_id, provider);
  const tx = await program.methods
    .decreaseValidatorStake(new BN(decreaseStakeAmount), ephemeralStakeSeed)
    .accounts({
      signer: stake_manager_keypair.publicKey,
      validatorVoteAccount: validatorVoteAccount,
      stakePool: stake_pool_account,
      reserveStake: stakePool.reserveStake,
      withdrawAuthority: poolWithdrawAuthority,
      validatorList: stakePool.validatorList,
      validatorStakeAccount: validatorStakeAccount,
      transientStakeAccount: transientStakeAccount,
      ephemeralStakeAccount: ephemeralStakeAccount,
    })
    .signers([stake_manager_keypair])
    .rpc();

  console.log("decrease_validator_stake tx:", tx);
}

// Run the main function
main().catch((error) => {
    console.error("Unexpected error:", error);
    process.exit(1);
});

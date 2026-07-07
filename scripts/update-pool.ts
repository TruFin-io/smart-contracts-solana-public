import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, BN, Wallet, web3 } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ComputeBudgetProgram, Keypair, PublicKey, StakeProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import * as fs from "fs";
import { decodeValidatorListAccount, getStakePool } from "../tests/helpers";
import { getConnection, getStakePoolProgramId, getStakePoolAccount } from "./utils";

// Get the Solana connection
const connection = getConnection();

// get config variables
const stake_pool_program_id = new PublicKey(getStakePoolProgramId());
const stake_pool_account = new PublicKey(getStakePoolAccount());

const owner_keypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(`${process.cwd()}/accounts/owner.json`, "utf-8"))) // Replace with your keypair file
);

// Configure the Solana connection and Anchor provider
const provider = new AnchorProvider(connection, new Wallet(owner_keypair), { commitment: "confirmed" });
anchor.setProvider(provider);


// A script to update the state of the Stake Pool calling the UpdateValidatorListBalance and UpdateStakePoolBalance instructions
// usage: yarn update-pool
async function main() {

  const stakePool = await getStakePool(connection, stake_pool_account);
  const validatorList = await decodeValidatorListAccount(connection, stakePool.validatorList);
  console.log("validators in the pool:", validatorList.validators.length);

  // derive the stake account and the transient account for all validators in the pool
  const validatorAccounts = validatorList.validators.flatMap((validator) => {
      console.log(`Validator: ${validator.vote_account_address.toBase58()}`);
      const validator_seed_suffix = validator.validator_seed_suffix;

      // if seed is 0 it means the validator is not using a seed
      const validatorStakeAccountSeeds = (validator_seed_suffix === 0)?
        [
          validator.vote_account_address.toBuffer(),
          stake_pool_account.toBuffer(),
        ]
      :
        [
          validator.vote_account_address.toBuffer(),
          stake_pool_account.toBuffer(),
          new BN(validator_seed_suffix).toArrayLike(Buffer, "le", 8),
        ]

      const [validatorStakeAccount] = PublicKey.findProgramAddressSync(validatorStakeAccountSeeds, stake_pool_program_id);
      console.log("  validatorStakeAccount PDA:", validatorStakeAccount.toBase58(), "validator_seed_suffix: ", validator_seed_suffix);

      const transient_seed_suffix = validator.transient_seed_suffix;
      const [transientStakeAccount] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("transient"),
          validator.vote_account_address.toBuffer(),
          stake_pool_account.toBuffer(),
          new BN(Number(transient_seed_suffix)).toArrayLike(Buffer, "le", 8),
        ],
        stake_pool_program_id
      );

      console.log("  transientStakeAccount PDA:", transientStakeAccount.toBase58(), "transient_seed_suffix", Number(transient_seed_suffix) );

      return [
        { pubkey: validatorStakeAccount, isSigner: false, isWritable: true }, // Validator stake account
        { pubkey: transientStakeAccount, isSigner: false, isWritable: true }, // Transient stake account
      ]
  });

  // derive the withdraw authority (PDA)
  const [poolWithdrawAuthority] = PublicKey.findProgramAddressSync(
    [stake_pool_account.toBuffer(), Buffer.from("withdraw")],
    stake_pool_program_id
  );

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
    programId: stake_pool_program_id,
    keys: [
      { pubkey: stake_pool_account, isSigner: false, isWritable: true }, // Stake pool
      { pubkey: poolWithdrawAuthority, isSigner: false, isWritable: false }, // Withdraw authority PDA
      { pubkey: stakePool.validatorList, isSigner: false, isWritable: true }, // Validator list
      { pubkey: stakePool.reserveStake, isSigner: false, isWritable: true }, // Reserve stake account
      { pubkey: web3.SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false }, // Clock sysvar
      { pubkey: web3.SYSVAR_STAKE_HISTORY_PUBKEY, isSigner: false, isWritable: false }, // Stake history
      { pubkey: StakeProgram.programId, isSigner: false, isWritable: false }, // Stake config
      // add validator stake and transient accounts for all validators to be updated
      ...validatorAccounts,
    ],
    data: instructionData,
  });

  const setCuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: 1_200_000,
  });
  
  const setCuPriceIx = ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: 1_000,
  });

  // send the UpdateValidatorListBalance transaction
  const updateValidatorListTx = await provider.sendAndConfirm(
    new Transaction().add(setCuLimitIx, setCuPriceIx, updateValidatorListBalanceIx)
  );
  console.log("UpdateValidatorListBalance tx:", updateValidatorListTx);

  // construct the UpdateStakePoolBalance instruction
  const updateStakePoolBalanceIx = new TransactionInstruction({
    programId: stake_pool_program_id,
    keys: [
      { pubkey: stake_pool_account, isSigner: false, isWritable: true }, // Stake pool
      { pubkey: poolWithdrawAuthority, isSigner: false, isWritable: false }, // Withdraw authority PDA
      { pubkey: stakePool.validatorList, isSigner: false, isWritable: true }, // Validator list
      { pubkey: stakePool.reserveStake, isSigner: false, isWritable: false }, // Reserve stake account
      { pubkey: stakePool.managerFeeAccount, isSigner: false, isWritable: true }, // Fee account
      { pubkey: stakePool.poolMint, isSigner: false, isWritable: true }, // Pool mint
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // Token program
    ],
    data: Buffer.from(Uint8Array.of(7)), // Instruction index for UpdateStakePoolBalance
  });

  // send the UpdateStakePoolBalance transaction
  const updateStakePoolBalanceTx = await provider.sendAndConfirm(
    new Transaction().add(updateStakePoolBalanceIx)
  );

  console.log("UpdateStakePoolBalance tx:", updateStakePoolBalanceTx);
}

// Run the main function
main().catch((error) => {
  console.error("Unexpected error:", error);
  process.exit(1);
});

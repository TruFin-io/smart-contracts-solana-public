import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import {
    decodeValidatorListAccount,
    findValidatorStakeAccount,
    getStakePool,
    recordedTransientStakeSeed,
    recordedValidatorSeed,
    stakeStatusToString,
} from "../tests/helpers";
import { getConnection, getStakePoolAccount, getStakePoolProgramId } from "./utils";

// Get the Solana connection
const connection = getConnection();

// get config variables
const stake_pool_account = new PublicKey(getStakePoolAccount());
const stake_pool_program_id = new PublicKey(getStakePoolProgramId());

// A script to fetch the list of validators in the stake pool
// usage: yarn fetch-validators
async function main() {
    const stakePool = await getStakePool(connection, stake_pool_account);
    const validatorList = await decodeValidatorListAccount(connection, stakePool.validatorList);
    console.log("max_validators:", validatorList.header.max_validators);

    validatorList.validators.forEach((validator, idx) => {

        const validatorStakeAccount = findValidatorStakeAccount(
            validator.vote_account_address, stake_pool_account, recordedValidatorSeed(validator), stake_pool_program_id
        );

        // the recorded transient seed is a full u64 (chosen at random since #159): never convert
        // it through a JS number, which only holds 53 bits and makes BN throw on larger seeds
        const transientStakeSeed = recordedTransientStakeSeed(validator);
        const [transientStakeAccount] = PublicKey.findProgramAddressSync(
            [
                Buffer.from("transient"),
                validator.vote_account_address.toBuffer(),
                stake_pool_account.toBuffer(),
                transientStakeSeed.toArrayLike(Buffer, "le", 8),
            ],
            stake_pool_program_id
        );

        console.log(`Validator ${idx}: ${validator.vote_account_address.toBase58()}`);
        console.log(
            "  Stake Account:\t", validatorStakeAccount.toBase58(), 
            "Active balance:\t", `${Number(validator.active_stake_lamports) / LAMPORTS_PER_SOL} SOL`
        );
        console.log(
            "  Transient Account:\t", transientStakeAccount.toBase58(),
            "Transient balance:",`${Number(validator.transient_stake_lamports) / LAMPORTS_PER_SOL} SOL`
        );
        console.log("  Last update epoch:", validator.last_update_epoch.toString());
        console.log("  Stake status:", stakeStatusToString(validator.status));
    });
}


// Run the main function
main().catch((error) => {
    console.error("Unexpected error:", error);
    process.exit(1);
});

import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  StakeProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import { assert } from "chai";
import { Staker } from "../target/types/staker";
import {
  STAKE_POOL_PROGRAM_ID,
  addUserToWhitelist,
  createStakePool,
  findEphemeralStakeAccount,
  findTransientStakeAccount,
  findValidatorStakeAccount,
  getEvent,
  getValidatorStakeInfo,
  initStaker,
  moveEpochForwardAndUpdatePool,
  recordedTransientStakeSeed,
  requestAirdrop,
  setupConfirmedProvider,
} from "./helpers";
import { CreateStakePoolResponse, StakeStatus } from "./stake_pool/types";

// A validator added with a nonzero seed has its stake account at
// find_program_address([vote, pool, u32_le(seed)]) in SPL; seed 0 omits the seed bytes. Deriving it
// any other way makes UpdateValidatorListBalance skip the validator silently (#171).
const VALIDATOR_SEED = 7;

describe("validator seed", () => {
  const provider = setupConfirmedProvider();
  const connection = provider.connection;

  let program: anchor.Program<Staker>;
  let owner: anchor.Wallet;
  let stakeManager: Keypair;
  let stakePoolInfo: CreateStakePoolResponse;
  let stakePool: PublicKey;
  let validatorVoteAccount: PublicKey;
  let validatorStakeAccount: PublicKey;

  before(async () => {
    owner = provider.wallet as anchor.Wallet;
    const manager = Keypair.generate();
    stakeManager = Keypair.generate();
    const user = Keypair.generate();
    await requestAirdrop(connection, user.publicKey, 20);

    const voteAccounts = (await connection.getVoteAccounts())?.current;
    if (!voteAccounts?.length) {
      throw new Error("No vote account found");
    }
    validatorVoteAccount = new PublicKey(voteAccounts[0].votePubkey);
    program = await initStaker(owner.publicKey, stakeManager.publicKey);

    stakePoolInfo = await createStakePool(
      program.programId,
      manager,
      Keypair.generate(),
    );
    stakePool = stakePoolInfo.accounts.stakePoolAccount;

    // hand the pool's staker authority to the staker program
    const [stakerAuthorityPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("staker")],
      program.programId,
    );
    const setStakerIx = new TransactionInstruction({
      programId: STAKE_POOL_PROGRAM_ID,
      keys: [
        { pubkey: stakePool, isSigner: false, isWritable: true },
        { pubkey: manager.publicKey, isSigner: true, isWritable: false },
        { pubkey: stakerAuthorityPDA, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(Uint8Array.of(13)), // SetStaker
    });
    await provider.sendAndConfirm(new Transaction().add(setStakerIx), [
      manager,
    ]);

    // a whitelisted user deposits 10 SOL so there is reserve to stake
    await addUserToWhitelist(program, user.publicKey);
    const userPoolTokenATA = await getAssociatedTokenAddress(
      stakePoolInfo.accounts.poolMintAccount,
      user.publicKey,
    );
    await provider.sendAndConfirm(
      new Transaction().add(
        createAssociatedTokenAccountInstruction(
          user.publicKey,
          userPoolTokenATA,
          user.publicKey,
          stakePoolInfo.accounts.poolMintAccount,
        ),
      ),
      [user],
    );
    await program.methods
      .deposit(new BN(10 * LAMPORTS_PER_SOL))
      .accounts({
        user: user.publicKey,
        stakePool,
        depositAuthority: stakePoolInfo.accounts.depositAuthorityAccount,
        withdrawAuthority: stakePoolInfo.accounts.withdrawAuthorityAccount,
        poolReserve: stakePoolInfo.accounts.reserveStakeAccount,
        userPoolTokenAccount: userPoolTokenATA,
        feeTokenAccount: stakePoolInfo.accounts.feesTokenAccount,
        poolMint: stakePoolInfo.accounts.poolMintAccount,
        referralFeeTokenAccount: stakePoolInfo.accounts.feesTokenAccount,
      })
      .signers([user])
      .rpc();

    validatorStakeAccount = findValidatorStakeAccount(
      validatorVoteAccount,
      stakePool,
      VALIDATOR_SEED,
    );
  });

  async function validatorInfo() {
    return getValidatorStakeInfo(
      connection,
      stakePoolInfo.accounts.validatorListAccount,
      validatorVoteAccount,
    );
  }

  // Raises the validator's stake by `lamports` through the staker program, or lowers it when
  // `increase` is false, using the transient seed the validator list expects.
  async function changeValidatorStake(increase: boolean, lamports: number) {
    const transientStakeSeed = recordedTransientStakeSeed(
      await validatorInfo(),
    );
    const ephemeralStakeSeed = new BN(0);
    const method = increase
      ? program.methods.increaseValidatorStake
      : program.methods.decreaseValidatorStake;
    return method(new BN(lamports), transientStakeSeed, ephemeralStakeSeed)
      .accounts({
        signer: stakeManager.publicKey,
        validatorVoteAccount,
        stakePool,
        reserveStake: stakePoolInfo.accounts.reserveStakeAccount,
        withdrawAuthority: stakePoolInfo.accounts.withdrawAuthorityAccount,
        validatorList: stakePoolInfo.accounts.validatorListAccount,
        validatorStakeAccount,
        transientStakeAccount: findTransientStakeAccount(
          validatorVoteAccount,
          stakePool,
          transientStakeSeed,
        ),
        ephemeralStakeAccount: findEphemeralStakeAccount(
          stakePool,
          ephemeralStakeSeed,
        ),
      })
      .signers([stakeManager])
      .rpc();
  }

  it("Derives the validator stake account with a 4-byte seed, and none for seed 0", () => {
    const vote = Keypair.generate().publicKey;
    const pool = Keypair.generate().publicKey;
    const u32le = (seed: number) => {
      const buffer = Buffer.alloc(4);
      buffer.writeUInt32LE(seed);
      return buffer;
    };
    const derive = (seeds: Buffer[]) =>
      PublicKey.findProgramAddressSync(
        seeds,
        STAKE_POOL_PROGRAM_ID,
      )[0].toBase58();

    for (const seed of [1, VALIDATOR_SEED, 0xffffffff]) {
      assert.equal(
        findValidatorStakeAccount(vote, pool, seed).toBase58(),
        derive([vote.toBuffer(), pool.toBuffer(), u32le(seed)]),
        `seed ${seed}`,
      );
    }
    assert.equal(
      findValidatorStakeAccount(vote, pool).toBase58(),
      derive([vote.toBuffer(), pool.toBuffer()]),
    );
    assert.equal(
      findValidatorStakeAccount(vote, pool, 0).toBase58(),
      derive([vote.toBuffer(), pool.toBuffer()]),
    );
  });

  it("Adds a validator with a nonzero seed at the address SPL derives", async () => {
    await program.methods
      .addValidator(VALIDATOR_SEED)
      .accounts({
        stakePool,
        reserveStake: stakePoolInfo.accounts.reserveStakeAccount,
        withdrawAuthority: stakePoolInfo.accounts.withdrawAuthorityAccount,
        validatorList: stakePoolInfo.accounts.validatorListAccount,
        validatorStakeAccount,
        validatorVoteAccount,
      })
      .signers([owner.payer])
      .rpc();

    const info = await validatorInfo();
    assert.equal(info.validator_seed_suffix, VALIDATOR_SEED);
    assert.isAbove(await connection.getBalance(validatorStakeAccount), 0);
    assert.equal(
      await connection.getBalance(
        findValidatorStakeAccount(validatorVoteAccount, stakePool),
      ),
      0,
    );
  });

  it("Increases the validator's stake", async () => {
    const txHash = await changeValidatorStake(true, 3 * LAMPORTS_PER_SOL);
    const event = await getEvent(program, txHash, "validatorStakeIncreased");
    assert.strictEqual(
      event.data.validator.toBase58(),
      validatorVoteAccount.toBase58(),
    );
  });

  it("Updates the validator list and the pool for the validator", async () => {
    const stakeRent = await connection.getMinimumBalanceForRentExemption(
      StakeProgram.space,
    );
    const transient = findTransientStakeAccount(
      validatorVoteAccount,
      stakePool,
      recordedTransientStakeSeed(await validatorInfo()),
    );
    const transientBalance = await connection.getBalance(transient);
    const stakeBalancePre = await connection.getBalance(validatorStakeAccount);
    assert.isAbove(transientBalance, 0);

    // UpdateStakePoolBalance fails with StakeListOutOfDate if the list update skipped the validator
    await moveEpochForwardAndUpdatePool(
      connection,
      stakePoolInfo.accounts,
      validatorVoteAccount,
    );

    const { epoch } = await connection.getEpochInfo("confirmed");
    const info = await validatorInfo();
    assert.equal(Number(info.last_update_epoch), epoch);
    assert.equal(await connection.getBalance(transient), 0);
    assert.equal(
      await connection.getBalance(validatorStakeAccount),
      stakeBalancePre + transientBalance - stakeRent,
    );
    assert.equal(
      Number(info.active_stake_lamports),
      await connection.getBalance(validatorStakeAccount),
    );
  });

  it("Decreases the validator's stake", async () => {
    const stakeBalancePre = await connection.getBalance(validatorStakeAccount);
    const decrease = 2 * LAMPORTS_PER_SOL;

    const txHash = await changeValidatorStake(false, decrease);

    const event = await getEvent(program, txHash, "validatorStakeDecreased");
    assert.strictEqual(
      event.data.validator.toBase58(),
      validatorVoteAccount.toBase58(),
    );
    assert.equal(
      await connection.getBalance(validatorStakeAccount),
      stakeBalancePre - decrease,
    );
  });

  it("Removes the validator", async () => {
    await moveEpochForwardAndUpdatePool(
      connection,
      stakePoolInfo.accounts,
      validatorVoteAccount,
    );
    const transientStakeSeed = recordedTransientStakeSeed(
      await validatorInfo(),
    );

    const txHash = await program.methods
      .removeValidator()
      .accounts({
        stakePool,
        withdrawAuthority: stakePoolInfo.accounts.withdrawAuthorityAccount,
        validatorList: stakePoolInfo.accounts.validatorListAccount,
        validatorStakeAccount,
        transientStakeAccount: findTransientStakeAccount(
          validatorVoteAccount,
          stakePool,
          transientStakeSeed,
        ),
      })
      .signers([owner.payer])
      .rpc();

    const event = await getEvent(program, txHash, "validatorRemoved");
    assert.strictEqual(
      event.data.stakeAccount.toBase58(),
      validatorStakeAccount.toBase58(),
    );
    assert.equal(
      (await validatorInfo()).status,
      StakeStatus.DeactivatingValidator,
    );
  });
});

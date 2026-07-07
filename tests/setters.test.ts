import * as anchor from "@coral-xyz/anchor";
import { initStaker, fetchEvent, getEvent, requestAirdrop , setupConfirmedProvider} from "./helpers";
import { assert } from "chai";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { Staker } from "../target/types/staker";
import { getAccount } from "@solana/spl-token";

describe("Setters", () => {
  
  const provider = setupConfirmedProvider();

  let program: anchor.Program<Staker>;
  let accessAddress: PublicKey;
  let owner: anchor.Wallet;
  let user: Keypair;
  let stakeManager: Keypair;

  before(async () => {
    owner = provider.wallet as anchor.Wallet;
    anchor.setProvider(provider);
    user = Keypair.generate();
    stakeManager = Keypair.generate();
    program = await initStaker(provider.wallet.publicKey, stakeManager.publicKey);
    
    [accessAddress] = PublicKey.findProgramAddressSync(
      [Buffer.from("access")],
      program.programId
    );
  });

  it("Can pause the staker", async () => {
    const tx = await program.methods
      .pause()
      .accountsPartial({
        owner: provider.wallet.publicKey,
      })
      .transaction();

    const event = await fetchEvent(program, tx, 0);
    assert.strictEqual(event.name, "stakerPaused");

    // check staker is now paused:
    const access = await program.account.access.fetch(accessAddress);
    assert.strictEqual(access.isPaused, true);
  });

  it("Pausing a paused staker fails", async () => {
    try {
      await program.methods
        .pause()
        .accountsPartial({
          owner: provider.wallet.publicKey,
        })
        .rpc();
      throw new Error("Pausing should fail");
    } catch (e) {
      assert.strictEqual(e.error.errorCode.code, "ContractPaused");
    }
  });

  it("Non-owner pausing the staker fails", async () => {
    try {
      await program.provider.connection.requestAirdrop(
        user.publicKey,
        2 * LAMPORTS_PER_SOL
      );

      await program.methods
        .pause()
        .accountsPartial({
          owner: user.publicKey,
        })
        .signers([user])
        .rpc();
      throw new Error("Pausing should fail");
    } catch (e) {
      assert.strictEqual(e.error.errorCode.code, "NotAuthorized");
    }
  });

  it("Can unpause the staker", async () => {
    const tx = await program.methods
      .unpause()
      .accountsPartial({
        owner: provider.wallet.publicKey,
      })
      .transaction();

    const event = await fetchEvent(program, tx, 0);
    assert.strictEqual(event.name, "stakerUnpaused");

    // check staker is now unpaused:
    const access = await program.account.access.fetch(accessAddress);
    assert.strictEqual(access.isPaused, false);
  });

  it("Unpausing an unpaused staker fails", async () => {
    try {
      await program.methods
        .unpause()
        .accountsPartial({
          owner: provider.wallet.publicKey,
        })
        .rpc();
      throw new Error("Unpausing should fail");
    } catch (e) {
      assert.strictEqual(e.error.errorCode.code, "NotPaused");
    }
  });

  it("Non-owner unpausing the staker fails", async () => {
    try {
      await program.methods
        .unpause()
        .accountsPartial({
          owner: user.publicKey,
        })
        .signers([user])
        .rpc();
      throw new Error("Unpausing should fail");
    } catch (e) {
      assert.strictEqual(e.error.errorCode.code, "NotAuthorized");
    }
  });

  it("Can set a pending owner", async () => {
    const pending_owner = Keypair.generate();
    const tx = await program.methods
      .setPendingOwner(pending_owner.publicKey)
      .transaction();

    const event = await fetchEvent(program, tx, 0);
    assert.strictEqual(event.name, "setPendingOwner");
    assert.strictEqual(
      event.data.currentOwner.toString(),
      provider.wallet.publicKey.toString()
    );
    assert.strictEqual(
      event.data.pendingOwner.toString(),
      pending_owner.publicKey.toString()
    );

    const access_account = await program.account.access.fetch(accessAddress);
    assert.strictEqual(
      access_account.pendingOwner.toString(),
      pending_owner.publicKey.toString()
    );
  });

  it("Can set pending owner twice", async () => {
    await program.methods.setPendingOwner(user.publicKey).rpc();

    const access_account = await program.account.access.fetch(accessAddress);
    assert.strictEqual(
      access_account.pendingOwner.toString(),
      user.publicKey.toString()
    );
  });

  it("Non-owner setting the pending owner fails", async () => {
    try {
      await program.methods
        .setPendingOwner(Keypair.generate().publicKey)
        .accountsPartial({
          owner: user.publicKey,
        })
        .signers([user])
        .rpc();
      throw new Error("Setting the pending owner should fail");
    } catch (e) {
      assert.strictEqual(e.error.errorCode.code, "NotAuthorized");
    }
  });

  it("Can claim ownership", async () => {
    const tx = await program.methods
      .claimOwnership()
      .accounts({
        pendingOwner: user.publicKey,
      })
      .signers([user])
      .transaction();
    tx.feePayer = provider.wallet.publicKey;
    const { blockhash } = await provider.connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.sign(user);

    const event = await fetchEvent(program, tx, 0);
    assert.strictEqual(event.name, "claimedOwnership");
    assert.strictEqual(
      event.data.oldOwner.toString(),
      provider.wallet.publicKey.toString()
    );
    assert.strictEqual(
      event.data.newOwner.toString(),
      user.publicKey.toString()
    );

    // check owner is set:
    const access_account = await program.account.access.fetch(accessAddress);
    assert.strictEqual(
      access_account.owner.toString(),
      user.publicKey.toString()
    );
    assert.strictEqual(access_account.pendingOwner, null);
  });

  it("Claiming ownership with no pending owner fails", async () => {
    try {
      await program.methods
        .claimOwnership()
        .accounts({
          pendingOwner: provider.wallet.publicKey,
        })
        .rpc();
    } catch (e) {
      assert.strictEqual(e.error.errorCode.code, "PendingOwnerNotSet");
    }
  });

  it("Claiming ownership with non pending owner fails", async () => {
    try {
      // set a new pending owner
      await program.methods
        .setPendingOwner(provider.wallet.publicKey)
        .accountsPartial({
          owner: user.publicKey,
        })
        .signers([user])
        .rpc();

      // try to claim ownership with the current owner
      await program.methods
        .claimOwnership()
        .accounts({
          pendingOwner: user.publicKey,
        })
        .signers([user])
        .rpc();

      throw new Error("Claiming ownership should fail");
    } catch (e) {
      assert.strictEqual(e.error.errorCode.code, "NotPendingOwner");
    }

    // reset to original owner
    await program.methods
      .claimOwnership()
      .accounts({
        pendingOwner: provider.wallet.publicKey,
      })
      .rpc();
  });

  it("Non-owner setting the new staker manager fails", async () => {
    try {
      const newStakeManager = Keypair.generate();
      await program.methods
        .setStakeManager()
        .accountsPartial({
          owner: user.publicKey,
          newStakeManager: newStakeManager.publicKey,
          oldStakeManager: stakeManager.publicKey,
        })
        .signers([user])
        .rpc();
      throw new Error("Setting the stake manager should fail");
    } catch (e) {
      assert.strictEqual(e.error.errorCode.code, "NotAuthorized");
    }
  });

  it("Setting a new staker manager with an invalid old staker manager fails", async () => {
    try {
      const newStakeManager = Keypair.generate();
      const invalidOldStakeManager = Keypair.generate();

      // create the invalid old stake manager account
      await requestAirdrop(provider.connection, invalidOldStakeManager.publicKey, 1);
      assert.ok(await provider.connection.getAccountInfo(invalidOldStakeManager.publicKey))

      await program.methods
        .setStakeManager()
        .accounts({
          newStakeManager: newStakeManager.publicKey,
          oldStakeManager: invalidOldStakeManager.publicKey,
        })
        .rpc();
  
      throw new Error("Setting the stake manager should fail");
    } catch (e) {
      // the transaction fails because the old_stake_manager_pda,
      // derived from an invalid old staker manager, does not exist.
      assert.strictEqual(e.error.errorCode.code, "AccountNotInitialized");
    }
  });

  it("Can set the staker manager", async () => {
    const newStakeManager = Keypair.generate();

    const tx = await program.methods
      .setStakeManager()
      .accounts({
        newStakeManager: newStakeManager.publicKey,
        oldStakeManager: stakeManager.publicKey,
      })
      .transaction();

    const txHash = await program.provider.sendAndConfirm(tx, [owner.payer], {
      commitment: "confirmed",
    })
    assert.ok(txHash);
    
    // verify the StakeManagerSet event
    const event = await getEvent(program, txHash, "stakeManagerSet");
    assert.ok(event);

    assert.strictEqual(
      event.data.oldStakeManager.toString(),
      stakeManager.publicKey.toString()
    );
    assert.strictEqual(
      event.data.newStakeManager.toString(),
      newStakeManager.publicKey.toString()
    );

    // verify the new stake manager PDA exists
    const [stakeManagerPDA] = PublicKey.findProgramAddressSync([
      Buffer.from("stake_manager"),
      newStakeManager.publicKey.toBuffer(),
    ], program.programId);
    const stakeManagerData = await program.account.stakeManager.fetch(stakeManagerPDA);
    assert.ok(stakeManagerData, "Stake manager should exist");

    // verify the old staker manager PDA does not exist
    const [oldStakeManagerPDA] = PublicKey.findProgramAddressSync([
      Buffer.from("stake_manager"),
      stakeManager.publicKey.toBuffer(),
    ], program.programId);

    try {
      await program.account.stakeManager.fetch(oldStakeManagerPDA);
      throw new Error("Stake manager should not exist");
    } catch (e) {
      assert.equal(
        e,
        "Error: Account does not exist or has no data " +
          oldStakeManagerPDA.toString()
      );
    }
  });

});
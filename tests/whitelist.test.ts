import * as anchor from "@coral-xyz/anchor";
import { fetchEvent, initStaker , setupConfirmedProvider} from "./helpers";
import { assert } from "chai";
import { Keypair, PublicKey } from "@solana/web3.js";
import { Staker } from "../target/types/staker";

describe("Whitelist", () => {

  const provider = setupConfirmedProvider();

  let program: anchor.Program<Staker>;
  let user: Keypair;
  let agent: Keypair;

  before(async () => {
    anchor.setProvider(provider);
    user = Keypair.generate();
    agent = Keypair.generate();
    program = await initStaker(provider.wallet.publicKey, provider.wallet.publicKey);
  });


  it("Can add an agent", async () => {
    const tx = await program.methods.addAgent(agent.publicKey).transaction();

    const event = await fetchEvent(program, tx, 1);

    assert.strictEqual(event.name, "agentAdded");
    assert.strictEqual(
      event.data.newAgent.toString(),
      agent.publicKey.toString()
    );

    // check agent is now added
    const [agent_address] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), agent.publicKey.toBuffer()],
      program.programId
    );
    const new_agent = await program.account.agent.fetch(agent_address);
    assert.ok(new_agent, "Agent account should exist");
  });

  it("Adding an existing agent fails", async () => {
    try {
      await program.methods.addAgent(agent.publicKey).rpc();
      throw new Error("Adding an existing agent should fail");
    } catch (e) {
      // 0x00 code reflects that an account already exists
      assert.strictEqual(
        e.transactionMessage,
        "Transaction simulation failed: Error processing Instruction 0: custom program error: 0x0"
      );
    }
  });

  it("Non-agent adding an existing agent fails", async () => {
    try {
      await program.methods
        .addAgent(agent.publicKey)
        .accounts({
          signer: user.publicKey,
        })
        .signers([user])
        .rpc();
      throw new Error("Non-agent adding an existing agent should fail");
    } catch (e) {
      assert.strictEqual(e.error.errorCode.code, "AccountNotInitialized");
    }
  });

  it("Can remove an agent", async () => {
    const tx = await program.methods.removeAgent(agent.publicKey).transaction();

    const event = await fetchEvent(program, tx, 0);

    assert.strictEqual(event.name, "agentRemoved");
    assert.strictEqual(
      event.data.removedAgent.toString(),
      agent.publicKey.toString()
    );

    // check agent does not exist
    const [agent_address] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), agent.publicKey.toBuffer()],
      program.programId
    );
    try {
      await program.account.agent.fetch(agent_address);
      throw new Error("Agent should not exist");
    } catch (e) {
      assert.equal(
        e,
        "Error: Account does not exist or has no data " +
          agent_address.toString()
      );
    }
  });

  it("Removing a non-existant agent fails", async () => {
    try {
      await program.methods.removeAgent(agent.publicKey).rpc();
      throw new Error("Removing a non-existant agent should fail");
    } catch (e) {
      assert.strictEqual(e.error.errorCode.code, "AccountNotInitialized");
    }
  });

  it("Non-agent removing an agent fails", async () => {
    await program.methods.addAgent(agent.publicKey).rpc();

    try {
      await program.methods
        .removeAgent(agent.publicKey)
        .accounts({
          signer: user.publicKey,
        })
        .signers([user])
        .rpc();
      throw new Error("Non-agent removing an agent should fail");
    } catch (e) {
      assert.strictEqual(e.error.errorCode.code, "AccountNotInitialized");
    }
  });

  it("Cannot remove owner as an agent", async () => {
    try {
      await program.methods
        .removeAgent(provider.wallet.publicKey)
        .accounts({
          signer: agent.publicKey,
        })
        .signers([agent])
        .rpc();
      throw new Error("Removing owner should fail");
    } catch (e) {
      assert.strictEqual(e.error.errorCode.code, "CannotRemoveOwner");
    }
  });

  it("Can add a user to the whitelist", async () => {
    const tx = await program.methods
      .addUserToWhitelist(user.publicKey)
      .transaction();

    const event = await fetchEvent(program, tx, 1);

    assert.strictEqual(event.name, "whitelistingStatusChanged");

    assert.strictEqual(event.data.user.toString(), user.publicKey.toString());

    assert.ok("none" in event.data.oldStatus);
    assert.ok("whitelisted" in event.data.newStatus);

    // check user is now added
    const [user_address] = PublicKey.findProgramAddressSync(
      [Buffer.from("user"), user.publicKey.toBuffer()],
      program.programId
    );
    const whitelist_user = await program.account.userStatus.fetch(user_address);
    assert.ok(whitelist_user, "User account should exist");
    assert.equal(
      JSON.stringify(whitelist_user.status),
      JSON.stringify({ whitelisted: {} })
    );
  });

  it("Adding a whitelisted user to the whitelist fails", async () => {
    try {
      await program.methods.addUserToWhitelist(user.publicKey).rpc();
      throw new Error("Readding user to whitelist should fail");
    } catch (e) {
      assert.strictEqual(e.error.errorCode.code, "AlreadyWhitelisted");
    }
  });

  it("Can add a user to the blacklist", async () => {
    const tx = await program.methods
      .addUserToBlacklist(user.publicKey)
      .transaction();

    const event = await fetchEvent(program, tx, 0);

    assert.strictEqual(event.name, "whitelistingStatusChanged");

    assert.strictEqual(event.data.user.toString(), user.publicKey.toString());

    assert.ok("whitelisted" in event.data.oldStatus);
    assert.ok("blacklisted" in event.data.newStatus);

    // check user is now blacklisted
    const [user_address] = PublicKey.findProgramAddressSync(
      [Buffer.from("user"), user.publicKey.toBuffer()],
      program.programId
    );
    const blacklist_user = await program.account.userStatus.fetch(user_address);
    assert.ok(blacklist_user, "User account should exist");
    assert.equal(
      JSON.stringify(blacklist_user.status),
      JSON.stringify({ blacklisted: {} })
    );
  });

  it("Adding a blacklisted user to the blacklist fails", async () => {
    try {
      await program.methods.addUserToBlacklist(user.publicKey).rpc();
      throw new Error("Readding user to blacklist should fail");
    } catch (e) {
      assert.strictEqual(e.error.errorCode.code, "AlreadyBlacklisted");
    }
  });

  it("Non-agent adding a user to the blacklist fails", async () => {
    try {
      await program.methods
        .addUserToBlacklist(agent.publicKey)
        .accounts({
          signer: user.publicKey,
        })
        .signers([user])
        .rpc();
      throw new Error("Non-agent adding user to blacklist should fail");
    } catch (e) {
      assert.strictEqual(e.error.errorCode.code, "AccountNotInitialized");
    }
  });

  it("Can clear a user's status", async () => {
    const tx = await program.methods
      .clearUserStatus(user.publicKey)
      .transaction();

    const event = await fetchEvent(program, tx, 0);

    assert.strictEqual(event.name, "whitelistingStatusChanged");

    assert.strictEqual(event.data.user.toString(), user.publicKey.toString());

    assert.ok("blacklisted" in event.data.oldStatus);
    assert.ok("none" in event.data.newStatus);

    // check user is now blacklisted
    const [user_address] = PublicKey.findProgramAddressSync(
      [Buffer.from("user"), user.publicKey.toBuffer()],
      program.programId
    );
    const cleared_user = await program.account.userStatus.fetch(user_address);
    assert.ok(cleared_user, "User account should exist");
    assert.equal(
      JSON.stringify(cleared_user.status),
      JSON.stringify({ none: {} })
    );
  });

  it("Clearing the status of a cleared user fails", async () => {
    try {
      await program.methods.clearUserStatus(user.publicKey).rpc();
      throw new Error("Re-clearing user should fail");
    } catch (e) {
      assert.strictEqual(e.error.errorCode.code, "AlreadyCleared");
    }
  });

  it("Clearing the status of a new user fails", async () => {
    try {
      await program.methods.clearUserStatus(agent.publicKey).rpc();
      throw new Error("Re-clearing user should fail");
    } catch (e) {
      assert.strictEqual(e.error.errorCode.code, "AlreadyCleared");
    }
  });

  it("Non-agent clearing a user's status fails", async () => {
    try {
      await program.methods.addUserToWhitelist(agent.publicKey).rpc();
      await program.methods
        .clearUserStatus(agent.publicKey)
        .accounts({
          signer: user.publicKey,
        })
        .signers([user])
        .rpc();
      throw new Error("Non-agent clearing user should fail");
    } catch (e) {
      assert.strictEqual(e.error.errorCode.code, "AccountNotInitialized");
    }
  });
});

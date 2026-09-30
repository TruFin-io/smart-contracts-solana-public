import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { Staker } from "../target/types/staker";
import {
  initStaker,
  requestAirdrop,
  createStakePool,
  updatePoolStakeBalance,
  getEvent,
  setupConfirmedProvider,
} from "./helpers";
import { CreateStakePoolResponse } from "./stake_pool/types";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  getAccount,
} from "@solana/spl-token";
import { assert } from "chai";

describe("Third-party whitelisting", () => {
  // Confirmed commitment + preflight avoids the local validator's intermittent
  // "Blockhash not found" (see setupConfirmedProvider in helpers).
  const provider = setupConfirmedProvider();
  const connection = provider.connection;

  let program: anchor.Program<Staker>;
  let owner: anchor.Wallet; // provider wallet — a regular agent registered at init
  let custodian: Keypair; // a registered third-party agent
  let custodianB: Keypair; // a second registered third-party agent
  let stakePoolInfo!: CreateStakePoolResponse; // set by the nested "with a stake pool" suite

  // PDA helpers
  const thirdPartyAgentPDA = (agent: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("third_party_agent"), agent.toBuffer()],
      program.programId
    )[0];
  const thirdPartyUserPDA = (user: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("third_party_user"), user.toBuffer()],
      program.programId
    )[0];
  const userStatusPDA = (user: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("user"), user.toBuffer()],
      program.programId
    )[0];

  // assert a failure is the system program's account-already-in-use error, i.e.
  // `init` hit an existing PDA (e.g. a ThirdPartyUser already claimed elsewhere)
  const assertAlreadyInUse = (e: any) => {
    const logs: string[] = e.transactionLogs ?? e.logs ?? [];
    assert.ok(
      logs.some((l) => l.includes("already in use")),
      `expected an "already in use" account-init-collision error, got: ${e}`
    );
  };

  // build the deposit accounts for a given user / ATA
  const depositAccounts = (user: PublicKey, userPoolTokenATA: PublicKey) => ({
    user,
    stakePool: stakePoolInfo.accounts.stakePoolAccount,
    depositAuthority: stakePoolInfo.accounts.depositAuthorityAccount,
    withdrawAuthority: stakePoolInfo.accounts.withdrawAuthorityAccount,
    poolReserve: stakePoolInfo.accounts.reserveStakeAccount,
    userPoolTokenAccount: userPoolTokenATA,
    feeTokenAccount: stakePoolInfo.accounts.feesTokenAccount,
    poolMint: stakePoolInfo.accounts.poolMintAccount,
    referralFeeTokenAccount: stakePoolInfo.accounts.feesTokenAccount,
  });

  // create the user's pool-token ATA (deposit requires it to already exist)
  const createUserATA = async (user: Keypair): Promise<PublicKey> => {
    const ata = await getAssociatedTokenAddress(
      stakePoolInfo.accounts.poolMintAccount,
      user.publicKey
    );
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        user.publicKey,
        ata,
        user.publicKey,
        stakePoolInfo.accounts.poolMintAccount
      )
    );
    await provider.sendAndConfirm(tx, [user]);
    return ata;
  };

  // bump the pool's last_update_epoch to the current epoch so DepositSol does
  // not fail with "stake list and pool out of date" (0x11). Works with zero
  // validators; needed because short epochs can roll over during setup.
  const updatePool = async () => {
    await updatePoolStakeBalance(
      stakePoolInfo.accounts.stakePoolAccount,
      stakePoolInfo.accounts.withdrawAuthorityAccount,
      stakePoolInfo.accounts.validatorListAccount,
      stakePoolInfo.accounts.reserveStakeAccount,
      stakePoolInfo.accounts.poolMintAccount,
      stakePoolInfo.accounts.feesTokenAccount
    );
  };

  before(async () => {
    anchor.setProvider(provider);
    owner = provider.wallet as anchor.Wallet;
    custodian = Keypair.generate();
    custodianB = Keypair.generate();

    program = await initStaker(owner.publicKey, owner.publicKey);

    // custodians fund the rent for the PDAs they create
    await requestAirdrop(connection, custodian.publicKey, 100);
    await requestAirdrop(connection, custodianB.publicKey, 100);
  });

  // ---------------------------------------------------------------------------
  // Third-party agent registration
  // ---------------------------------------------------------------------------

  it("A regular agent can register a third-party agent", async () => {
    const sig = await program.methods
      .addThirdPartyAgent(custodian.publicKey)
      .rpc({ commitment: "confirmed" });

    const event = await getEvent(program, sig, "thirdPartyAgentAdded");
    assert.ok(event);
    assert.strictEqual(
      event.data.agent.toString(),
      custodian.publicKey.toString()
    );

    const account = await program.account.thirdPartyAgent.fetch(
      thirdPartyAgentPDA(custodian.publicKey)
    );
    assert.ok(account, "third-party agent account should exist");

    // register a second custodian used by later tests
    await program.methods
      .addThirdPartyAgent(custodianB.publicKey)
      .rpc({ commitment: "confirmed" });
  });

  it("A random signer cannot register a third-party agent", async () => {
    const stranger = Keypair.generate();
    try {
      await program.methods
        .addThirdPartyAgent(Keypair.generate().publicKey)
        .accountsPartial({ signer: stranger.publicKey })
        .signers([stranger])
        .rpc();
      throw new Error("a non-agent should not be able to register");
    } catch (e) {
      assert.strictEqual(e.error.errorCode.code, "AccountNotInitialized");
    }
  });

  it("A third-party agent cannot register another third-party agent", async () => {
    try {
      await program.methods
        .addThirdPartyAgent(Keypair.generate().publicKey)
        .accountsPartial({ signer: custodian.publicKey })
        .signers([custodian])
        .rpc();
      throw new Error("a third-party agent should not be able to register");
    } catch (e) {
      // custodian holds no regular [b"agent", custodian] PDA
      assert.strictEqual(e.error.errorCode.code, "AccountNotInitialized");
    }
  });

  it("A regular agent can remove a third-party agent", async () => {
    const temp = Keypair.generate();
    await program.methods
      .addThirdPartyAgent(temp.publicKey)
      .rpc({ commitment: "confirmed" });

    const sig = await program.methods
      .removeThirdPartyAgent(temp.publicKey)
      .rpc({ commitment: "confirmed" });

    const event = await getEvent(program, sig, "thirdPartyAgentRemoved");
    assert.ok(event);
    assert.strictEqual(event.data.agent.toString(), temp.publicKey.toString());

    try {
      await program.account.thirdPartyAgent.fetch(
        thirdPartyAgentPDA(temp.publicKey)
      );
      throw new Error("third-party agent account should be closed");
    } catch (e) {
      assert.include(e.toString(), "Account does not exist");
    }
  });

  // ---------------------------------------------------------------------------
  // Eligibility (status == None is the security crux)
  // ---------------------------------------------------------------------------

  it("Cannot onboard a user already whitelisted by TruFin", async () => {
    const user = Keypair.generate();
    // TruFin (a regular agent) whitelists the user directly
    await program.methods.addUserToWhitelist(user.publicKey).rpc();

    try {
      await program.methods
        .thirdPartyAddUserToWhitelist(user.publicKey)
        .accountsPartial({ signer: custodian.publicKey })
        .signers([custodian])
        .rpc();
      throw new Error("onboarding a whitelisted user should fail");
    } catch (e) {
      assert.strictEqual(
        e.error.errorCode.code,
        "UserNotEligibleForThirdPartyWhitelisting"
      );
    }
  });

  it("Cannot onboard a blacklisted user", async () => {
    const user = Keypair.generate();
    await program.methods.addUserToBlacklist(user.publicKey).rpc();

    try {
      await program.methods
        .thirdPartyAddUserToWhitelist(user.publicKey)
        .accountsPartial({ signer: custodian.publicKey })
        .signers([custodian])
        .rpc();
      throw new Error("onboarding a blacklisted user should fail");
    } catch (e) {
      assert.strictEqual(
        e.error.errorCode.code,
        "UserNotEligibleForThirdPartyWhitelisting"
      );
    }
  });

  it("Cannot onboard a user already whitelisted by another custodian", async () => {
    const user = Keypair.generate();
    // custodian A onboards the user
    await program.methods
      .thirdPartyAddUserToWhitelist(user.publicKey)
      .accountsPartial({ signer: custodian.publicKey })
      .signers([custodian])
      .rpc({ commitment: "confirmed" });

    // custodian B cannot claim the same user — the ThirdPartyUser PDA is in use
    try {
      await program.methods
        .thirdPartyAddUserToWhitelist(user.publicKey)
        .accountsPartial({ signer: custodianB.publicKey })
        .signers([custodianB])
        .rpc();
      throw new Error("onboarding another custodian's user should fail");
    } catch (e) {
      // init on an existing ThirdPartyUser PDA fails with "already in use"
      assertAlreadyInUse(e);
    }

    // ownership is unchanged: the user is still claimed by custodian A
    const tpUser = await program.account.thirdPartyUser.fetch(
      thirdPartyUserPDA(user.publicKey)
    );
    assert.strictEqual(tpUser.agent.toString(), custodian.publicKey.toString());
  });

  // ---------------------------------------------------------------------------
  // Ownership scoping
  // ---------------------------------------------------------------------------

  it("A custodian can manage a user it owns but not one owned by another", async () => {
    const owned = Keypair.generate();
    await program.methods
      .thirdPartyAddUserToWhitelist(owned.publicKey)
      .accountsPartial({ signer: custodian.publicKey })
      .signers([custodian])
      .rpc({ commitment: "confirmed" });

    // another custodian cannot blacklist a user it does not own
    try {
      await program.methods
        .thirdPartyAddUserToBlacklist(owned.publicKey)
        .accountsPartial({ signer: custodianB.publicKey })
        .signers([custodianB])
        .rpc();
      throw new Error("blacklisting another agent's user should fail");
    } catch (e) {
      assert.strictEqual(e.error.errorCode.code, "NotUserOwner");
    }

    // another custodian cannot clear a user it does not own
    try {
      await program.methods
        .thirdPartyClearUserStatus(owned.publicKey)
        .accountsPartial({ signer: custodianB.publicKey })
        .signers([custodianB])
        .rpc();
      throw new Error("clearing another agent's user should fail");
    } catch (e) {
      assert.strictEqual(e.error.errorCode.code, "NotUserOwner");
    }

    // the owning custodian can blacklist its own user
    const sig = await program.methods
      .thirdPartyAddUserToBlacklist(owned.publicKey)
      .accountsPartial({ signer: custodian.publicKey })
      .signers([custodian])
      .rpc({ commitment: "confirmed" });

    const event = await getEvent(
      program,
      sig,
      "thirdPartyWhitelistingStatusChanged"
    );
    assert.strictEqual(
      event.data.agent.toString(),
      custodian.publicKey.toString()
    );
    assert.ok("blacklisted" in event.data.newStatus);

    const status = await program.account.userStatus.fetch(
      userStatusPDA(owned.publicKey)
    );
    assert.equal(
      JSON.stringify(status.status),
      JSON.stringify({ blacklisted: {} })
    );
  });

  // ---------------------------------------------------------------------------
  // Blacklist override — a regular agent's blacklist beats a custodian
  // ---------------------------------------------------------------------------

  it("A custodian cannot lift a TruFin blacklist on a user it owns", async () => {
    const user = Keypair.generate();
    await program.methods
      .thirdPartyAddUserToWhitelist(user.publicKey)
      .accountsPartial({ signer: custodian.publicKey })
      .signers([custodian])
      .rpc({ commitment: "confirmed" });

    // TruFin (regular agent) blacklists the custodian's user
    await program.methods.addUserToBlacklist(user.publicKey).rpc();

    // the custodian cannot clear the blacklist...
    try {
      await program.methods
        .thirdPartyClearUserStatus(user.publicKey)
        .accountsPartial({ signer: custodian.publicKey })
        .signers([custodian])
        .rpc();
      throw new Error("custodian clearing a blacklisted user should fail");
    } catch (e) {
      assert.strictEqual(e.error.errorCode.code, "CannotClearBlacklistedUser");
    }

    // ...nor re-whitelist (ThirdPartyUser still exists + status != None)
    try {
      await program.methods
        .thirdPartyAddUserToWhitelist(user.publicKey)
        .accountsPartial({ signer: custodian.publicKey })
        .signers([custodian])
        .rpc();
      throw new Error("custodian re-whitelisting a blacklisted user should fail");
    } catch (e) {
      // the ThirdPartyUser PDA still exists, so init fails with "already in use"
      assertAlreadyInUse(e);
    }

    // the user remains blacklisted
    const status = await program.account.userStatus.fetch(
      userStatusPDA(user.publicKey)
    );
    assert.equal(
      JSON.stringify(status.status),
      JSON.stringify({ blacklisted: {} })
    );
  });

  // ---------------------------------------------------------------------------
  // Clear releases the claim and allows clean re-onboarding
  // ---------------------------------------------------------------------------

  it("Clearing a user closes its ThirdPartyUser PDA and allows re-onboarding", async () => {
    const user = Keypair.generate();
    await program.methods
      .thirdPartyAddUserToWhitelist(user.publicKey)
      .accountsPartial({ signer: custodian.publicKey })
      .signers([custodian])
      .rpc({ commitment: "confirmed" });

    // custodian clears its own whitelisted user
    await program.methods
      .thirdPartyClearUserStatus(user.publicKey)
      .accountsPartial({ signer: custodian.publicKey })
      .signers([custodian])
      .rpc({ commitment: "confirmed" });

    const status = await program.account.userStatus.fetch(
      userStatusPDA(user.publicKey)
    );
    assert.equal(
      JSON.stringify(status.status),
      JSON.stringify({ none: {} })
    );

    // the ThirdPartyUser claim is released (account closed)
    try {
      await program.account.thirdPartyUser.fetch(
        thirdPartyUserPDA(user.publicKey)
      );
      throw new Error("ThirdPartyUser should be closed");
    } catch (e) {
      assert.include(e.toString(), "Account does not exist");
    }

    // the user can be cleanly re-onboarded, possibly by a different custodian
    await program.methods
      .thirdPartyAddUserToWhitelist(user.publicKey)
      .accountsPartial({ signer: custodianB.publicKey })
      .signers([custodianB])
      .rpc({ commitment: "confirmed" });

    const tpUser = await program.account.thirdPartyUser.fetch(
      thirdPartyUserPDA(user.publicKey)
    );
    assert.strictEqual(
      tpUser.agent.toString(),
      custodianB.publicKey.toString()
    );
  });

  // ---------------------------------------------------------------------------
  // Agent release — TruFin can force-release any custodian's claim
  // ---------------------------------------------------------------------------

  it("A regular agent can force-release any custodian's user claim", async () => {
    const user = Keypair.generate();
    // custodian onboards the user
    await program.methods
      .thirdPartyAddUserToWhitelist(user.publicKey)
      .accountsPartial({ signer: custodian.publicKey })
      .signers([custodian])
      .rpc({ commitment: "confirmed" });

    // a non-agent cannot force-release
    const stranger = Keypair.generate();
    try {
      await program.methods
        .agentReleaseThirdPartyUser(user.publicKey)
        .accountsPartial({ signer: stranger.publicKey })
        .signers([stranger])
        .rpc();
      throw new Error("a non-agent force-release should fail");
    } catch (e) {
      assert.strictEqual(e.error.errorCode.code, "AccountNotInitialized");
    }

    // a regular TruFin agent releases the claim regardless of the owning custodian
    const sig = await program.methods
      .agentReleaseThirdPartyUser(user.publicKey)
      .rpc({ commitment: "confirmed" });

    const event = await getEvent(program, sig, "thirdPartyUserReleased");
    assert.ok(event);
    assert.strictEqual(event.data.user.toString(), user.publicKey.toString());
    assert.strictEqual(
      event.data.agent.toString(),
      custodian.publicKey.toString()
    );

    // the ThirdPartyUser claim PDA is closed
    try {
      await program.account.thirdPartyUser.fetch(
        thirdPartyUserPDA(user.publicKey)
      );
      throw new Error("ThirdPartyUser should be closed");
    } catch (e) {
      assert.include(e.toString(), "Account does not exist");
    }
  });

  // ---------------------------------------------------------------------------
  // Atomic onboarding-and-deposit (requires a stake pool)
  // ---------------------------------------------------------------------------

  describe("with a stake pool", () => {
    before(async () => {
      stakePoolInfo = await createStakePool(
        program.programId,
        Keypair.generate(), // pool manager
        Keypair.generate() // pool staker
      );
    });

    it("Onboards and deposits for a fresh user in a single atomic transaction", async () => {
      const user = Keypair.generate();
      await requestAirdrop(connection, user.publicKey, 100);
      const userATA = await createUserATA(user);

      const depositAmount = new BN(10 * LAMPORTS_PER_SOL);

      // ix1: custodian whitelists the user; ix2: the user deposits
      const ix1 = await program.methods
        .thirdPartyAddUserToWhitelist(user.publicKey)
        .accountsPartial({ signer: custodian.publicKey })
        .instruction();
      const ix2 = await program.methods
        .deposit(depositAmount)
        .accountsPartial(depositAccounts(user.publicKey, userATA))
        .instruction();

      // ensure the pool is current for the epoch so DepositSol succeeds
      await updatePool();

      const tx = new Transaction().add(ix1, ix2);
      const sig = await provider.sendAndConfirm(tx, [custodian, user], {
        commitment: "confirmed",
      });
      assert.ok(sig);

      // the user is owned by the custodian
      const tpUser = await program.account.thirdPartyUser.fetch(
        thirdPartyUserPDA(user.publicKey)
      );
      assert.strictEqual(tpUser.agent.toString(), custodian.publicKey.toString());

      // the user is whitelisted
      const status = await program.account.userStatus.fetch(
        userStatusPDA(user.publicKey)
      );
      assert.equal(
        JSON.stringify(status.status),
        JSON.stringify({ whitelisted: {} })
      );

      // the deposit minted pool tokens to the user
      const poolTokens = await getAccount(connection, userATA);
      assert(Number(poolTokens.amount) > 0, "user should hold pool tokens");

      // the whitelisting event carries the custodian as the KYC attestation
      const event = await getEvent(
        program,
        sig,
        "thirdPartyWhitelistingStatusChanged"
      );
      assert.ok(event);
      assert.strictEqual(event.data.user.toString(), user.publicKey.toString());
      assert.strictEqual(
        event.data.agent.toString(),
        custodian.publicKey.toString()
      );
      assert.ok("none" in event.data.oldStatus);
      assert.ok("whitelisted" in event.data.newStatus);

      // a subsequent deposit needs only the plain deposit instruction
      await updatePool();
      const sig2 = await program.methods
        .deposit(new BN(1 * LAMPORTS_PER_SOL))
        .accountsPartial(depositAccounts(user.publicKey, userATA))
        .signers([user])
        .rpc({ commitment: "confirmed" });
      assert.ok(sig2);

      // re-sending the onboarding instruction for an onboarded user fails
      try {
        await program.methods
          .thirdPartyAddUserToWhitelist(user.publicKey)
          .accountsPartial({ signer: custodian.publicKey })
          .signers([custodian])
          .rpc();
        throw new Error("re-onboarding an existing user should fail");
      } catch (e) {
        // ThirdPartyUser already exists, so init fails with "already in use"
        assertAlreadyInUse(e);
      }
      const stillOwned = await program.account.thirdPartyUser.fetch(
        thirdPartyUserPDA(user.publicKey)
      );
      assert.strictEqual(
        stillOwned.agent.toString(),
        custodian.publicKey.toString()
      );
    });

    it("The atomic onboarding-and-deposit reverts entirely when paused", async () => {
      const user = Keypair.generate();
      await requestAirdrop(connection, user.publicKey, 100);
      const userATA = await createUserATA(user);

      // pause the program
      await program.methods.pause().accountsPartial({ owner: owner.publicKey }).rpc();

      try {
        const ix1 = await program.methods
          .thirdPartyAddUserToWhitelist(user.publicKey)
          .accountsPartial({ signer: custodian.publicKey })
          .instruction();
        const ix2 = await program.methods
          .deposit(new BN(5 * LAMPORTS_PER_SOL))
          .accountsPartial(depositAccounts(user.publicKey, userATA))
          .instruction();

        const tx = new Transaction().add(ix1, ix2);
        try {
          await provider.sendAndConfirm(tx, [custodian, user]);
          throw new Error("the atomic transaction should fail while paused");
        } catch (e) {
          assert.include(e.toString(), "ContractPaused");
        }

        // the whole transaction reverted: no whitelisted-but-not-deposited residue
        try {
          await program.account.thirdPartyUser.fetch(
            thirdPartyUserPDA(user.publicKey)
          );
          throw new Error("ThirdPartyUser should not have been created");
        } catch (e) {
          assert.include(e.toString(), "Account does not exist");
        }
      } finally {
        // always unpause so a failed assertion can't leave the program paused
        await program.methods
          .unpause()
          .accountsPartial({ owner: owner.publicKey })
          .rpc();
      }
    });
  });
});

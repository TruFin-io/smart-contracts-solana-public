import { getEvent , setupConfirmedProvider} from './helpers';
import * as anchor from "@coral-xyz/anchor";
import { assert } from "chai";
import { Keypair, PublicKey} from '@solana/web3.js';
import { Staker } from "../target/types/staker";

describe("Staker init", () => {

  const provider = setupConfirmedProvider();
  anchor.setProvider(provider);
  let program = anchor.workspace.Staker as anchor.Program<Staker>;

  it("Initializes staker and emits init event", async () => {
    const treasury = Keypair.generate();
    const default_validator = Keypair.generate();

    const stakeManager = Keypair.generate();
    let tx = await program.methods.initializeStaker().accounts({
      ownerInfo: provider.wallet.publicKey,
      stakeManagerInfo: stakeManager.publicKey,
    }).transaction();

    const txHash = await program.provider.sendAndConfirm(tx, [], {
      commitment: "confirmed",
    })
    
    const event = (await getEvent(program, txHash, "stakerInitialized")).data as StakerInitializedEvent;
    assert.strictEqual((event.owner).toString(), program.provider.publicKey.toString());
    assert.strictEqual((event.stakeManager).toString(), stakeManager.publicKey.toString());

    const [accessAddress] = PublicKey.findProgramAddressSync([
      Buffer.from("access")], program.programId);
    const access = await program.account.access.fetch(accessAddress);
    assert.strictEqual((access.owner).toString(), provider.wallet.publicKey.toString());
    assert.strictEqual(access.isPaused, false);

    // verify stake manager PDA exists
    const [stakeManagerPDA] = PublicKey.findProgramAddressSync([
      Buffer.from("stake_manager"), stakeManager.publicKey.toBuffer()], program.programId);

    const stakeManagerData = await program.account.stakeManager.fetch(stakeManagerPDA);
    assert.ok(stakeManagerData, "Stake manager should exist");

  });
});

interface StakerInitializedEvent {
  owner: PublicKey;
  stakeManager: PublicKey;
  treasury: PublicKey;
  defaultValidator: PublicKey;
  fee: anchor.BN;
  distFee: anchor.BN;
  minDepositAmount: anchor.BN;
  token: PublicKey;
}
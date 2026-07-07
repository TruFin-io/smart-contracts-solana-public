import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import * as borsh from "borsh";
import { LAMPORTS_PER_SOL, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { initStaker, createStakePool, addUserToWhitelist, deposit , setupConfirmedProvider} from "./helpers";
import { CreateStakePoolResponse, DataV2, DataV2Schema } from "./stake_pool/types";
import { createPoolTokenMetadata } from "@solana/spl-stake-pool";
import { assert } from "chai";
import { MPL_TOKEN_METADATA_PROGRAM_ID } from "@metaplex-foundation/mpl-token-metadata";
import { createAssociatedTokenAccount, createTransferInstruction, getAccount, getAssociatedTokenAddress } from "@solana/spl-token";
import { Staker } from "../target/types/staker";


describe("TruSOL", () => {

  const provider = setupConfirmedProvider();
  let wallet = provider.wallet as anchor.Wallet;
  let manager = Keypair.generate();
  let stakeManager = Keypair.generate();
  let program: anchor.Program<Staker>;
  let stakePoolInfo: CreateStakePoolResponse;

  before(async () => {
    // get local validator account
    const voteAccountsAll = await provider.connection.getVoteAccounts();
    let voteAccounts = voteAccountsAll?.current;
    if (voteAccounts?.length == 0) {
      throw new Error("No vote accounts found");
    }

    program = await initStaker(provider.wallet.publicKey, stakeManager.publicKey);
    const staker = Keypair.generate();

    // create the stake pool with the manager and staker authorities
    stakePoolInfo = await createStakePool(
      program.programId,
      manager, // Manager authority
      staker, // Staker authority
    );
  });

  it("Creates TruSOL metadata", async () => {
    // create the pool token metadata instruction
    let ixs = await createPoolTokenMetadata(
      provider.connection as any,
      stakePoolInfo.accounts.stakePoolAccount, // stake pool account
      wallet.publicKey, // payer
      "Tru SOL Token", // token name
      "TruSOL",        // token symbol
      "https://trufin.io" // token uri
    );

    // add the instructions to a transaction
    const createMetadataTx = new Transaction();
    createMetadataTx.add(...ixs.instructions);

    // send the transaction
    const txHash = await provider.sendAndConfirm(createMetadataTx, [manager]);
    assert.ok(txHash);
  });


  it("Fetches TruSOL metadata", async () => {
    const TOKEN_METADATA = new PublicKey(MPL_TOKEN_METADATA_PROGRAM_ID.toString());
    const [metadataPDA] = await PublicKey.findProgramAddressSync(
      [
        Buffer.from("metadata"),
        TOKEN_METADATA.toBuffer(),
        stakePoolInfo.accounts.poolMintAccount.toBuffer(),
      ],
      TOKEN_METADATA
    );

    // fetch the pool token metadata account
    const tokenMetadata = await provider.connection.getAccountInfo(metadataPDA);
    
    // deserialize the pool token metadata
    const offset = 69;
    const metadataBuffer = tokenMetadata.data.slice(offset);
    const metadata = borsh.deserializeUnchecked(
      DataV2Schema,
      DataV2,
      metadataBuffer
    );

    // verify the pool poken metadata
    assert.equal(metadata.name, "Tru SOL Token");
    assert.equal(metadata.symbol, "TruSOL");
    assert.equal(metadata.uri, "https://trufin.io");
  });


  it("Can transfer tokens between users", async () => {

    const sender = wallet.publicKey;
    const recipient = Keypair.generate().publicKey;

    // create recipient's ata
    await createAssociatedTokenAccount(
      provider.connection,
      wallet.payer, // payer
      stakePoolInfo.accounts.poolMintAccount,
      recipient, // owner
    );
    const recipientATA = await getAssociatedTokenAddress(
      stakePoolInfo.accounts.poolMintAccount,
      recipient
    );

    // the sender deposits 10 SOL to the staker to get some TruSOL
    const depositAmount = new BN(10 * LAMPORTS_PER_SOL);
    await addUserToWhitelist(program, sender);
    await deposit(provider.connection, program, wallet, stakePoolInfo.accounts, depositAmount);

    // get the TruSOL balance of the sender before the transfer
    const senderATA = await getAssociatedTokenAddress(stakePoolInfo.accounts.poolMintAccount, sender);
    const senderBalancePre = Number((await getAccount(provider.connection, senderATA)).amount);

    // create and send the transfer transaction
    const transderAmount = 2 * LAMPORTS_PER_SOL;
    const txSig = await anchor.web3.sendAndConfirmTransaction(
      provider.connection,
      new Transaction().add(
        createTransferInstruction(
          senderATA,
          recipientATA,
          sender,
          transderAmount,
          [],
        )
      ),
      [wallet.payer]
    );
    assert.ok(txSig);

    // verify that TruSOL tokens were transferred from the sender to the recipient
    const senderBalance = Number((await getAccount(provider.connection, senderATA)).amount);
    const recipientBalance = Number((await getAccount(provider.connection, recipientATA)).amount);
    assert.equal(senderBalance, senderBalancePre - transderAmount);
    assert.equal(recipientBalance, transderAmount);
  });

});

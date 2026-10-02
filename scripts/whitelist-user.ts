import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import { getConnection, getStakerProgramId } from "./utils";

// Get the Solana connection
const connection = getConnection();

// get config variables
const staker_program_id = new PublicKey(getStakerProgramId());

// load the owner keypair
const owner_keypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(`${process.cwd()}/accounts/owner.json`, "utf-8"))) // Replace with your keypair file
);

// configure the Anchor provider
const provider = new AnchorProvider(
  connection,
  new Wallet(owner_keypair),
  { commitment: "confirmed" }
);
anchor.setProvider(provider);

// A script to whitelist a user
// usage: yarn whitelist-user <user_address>
async function main() {

  // parse arguments
  const args = process.argv.slice(2);
  const user = args.length === 1 && new PublicKey(args[0])
  if (!user) {
    console.error("Usage: yarn whitelist-user <user_address>");
    process.exit(1);
  }

  // Add user to whitelist
  const program = await Program.at(staker_program_id, provider);
  const tx = await program.methods
    .addUserToWhitelist(user)
    .accounts({
      signer: owner_keypair.publicKey,
    })
    .signers([owner_keypair])
    .rpc();
    // Comment the line above and uncomment the few lines below to print the transaction
    // .instruction();

    // const agentAddress = "";
    // const [agentAccount] = PublicKey.findProgramAddressSync(
    //   [Buffer.from("agent"), new PublicKey(agentAddress).toBuffer()],
    //   staker_program_id
    // );
    // console.log("agentAccount", agentAccount.toBase58());
    
    // const [userWhitelistAccount] = PublicKey.findProgramAddressSync(
    //   [Buffer.from("user"), user.toBuffer()],
    //   staker_program_id
    // );
    // console.log("userWhitelistAccount", userWhitelistAccount.toBase58());


  console.log("Whitelist user tx:", tx);
}

// Run the main function
main().catch((error) => {
    console.error("Unexpected error:", error);
    process.exit(1);
});

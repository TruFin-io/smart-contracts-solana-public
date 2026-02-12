#!/bin/bash

# The name of the test file to run. If not provided defaults to all test files in the tests directory
test_file_name=${1:-"*"}

# Stop on the first error
set -e

# Set ANCHOR_PROVIDER_URL for local validator
export ANCHOR_PROVIDER_URL="http://127.0.0.1:8899"
export ANCHOR_WALLET="$HOME/.config/solana/id.json"

# Build the Staker program
RUSTUP_TOOLCHAIN="nightly-2024-11-19" anchor build --provider.cluster devnet --program-name staker

# Output the program ID from the staker keypair
PROGRAM_ID=`solana address -k accounts/staker-program.json`
echo "PROGRAM_ID: $PROGRAM_ID"

# Start the local validator with Token Metadata program from devnet and deploy pre-compiled binary of SPL Stake Pool program  
START_VALIDATOR="solana-test-validator --clone-upgradeable-program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s --clone-upgradeable-program SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy --url mainnet-beta --slots-per-epoch 128 --reset"
DEPLOY_PROGRAM="anchor deploy --program-name staker --program-keypair accounts/staker-program.json"
RUN_TEST="yarn ts-mocha -p ./tsconfig.json -t 1000000"

# Function to check if the RPC server is up
rpc_is_ready() {
  echo "Checking if RPC server is ready..."
  sleep 2

  if ! curl -s http://127.0.0.1:8899 >/dev/null; then
    echo "RPC server is not ready..."
    return 1
  fi

  echo "RPC server is ready."
  return 0
}

# Function to wait for the validator to produce confirmed blocks
wait_for_confirmed_blocks() {
  MIN_SLOT=${1:-10}
  echo "Waiting for validator to produce confirmed blocks..."
  for i in $(seq 1 60); do
    SLOT=$(solana slot --commitment confirmed 2>/dev/null)
    if [ -n "$SLOT" ] && [ "$SLOT" -gt "$MIN_SLOT" ] 2>/dev/null; then
      echo "Validator is producing confirmed blocks (slot: $SLOT)."
      return 0
    fi
    sleep 1
  done
  echo "WARNING: Timed out waiting for confirmed blocks."
  return 1
}

# Ensure the local validator is not already running
echo "Checking for existing local validator..."
pkill -f solana-test-validator || true

# Run the test file(s) in the tests directory
for TEST_FILE in tests/${test_file_name}.test.ts; do
  echo "======================================================"
  echo "Running test file: $TEST_FILE"
  echo "======================================================"

  echo "Starting local validator..."
  $START_VALIDATOR > /dev/null 2>&1 &
  VALIDATOR_PID=$!
  echo "validator PID: $VALIDATOR_PID"
  sleep 2 # Wait for the validator to start

  solana config set --url http://127.0.0.1:8899

  # Wait for the RPC server to be ready, restart if necessary
  while ! rpc_is_ready; do
    echo "Stopping local validator..."
    pkill -f solana-test-validator || true
    echo "Restarting local validator..."
    $START_VALIDATOR > /dev/null 2>&1 &
    VALIDATOR_PID=$!
    echo "validator PID: $VALIDATOR_PID"
  done

  # Wait for the validator to produce confirmed blocks before deploying
  wait_for_confirmed_blocks

  solana program show SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy

  # Deploy the program
  echo "Deploying program..."
  $DEPLOY_PROGRAM

  # Ensure new confirmed blocks are produced after deployment so recent blockhashes are usable.
  SLOT_AFTER_DEPLOY=$(solana slot --commitment confirmed 2>/dev/null || echo 0)
  wait_for_confirmed_blocks $((SLOT_AFTER_DEPLOY + 5))

  # Run the test file
  echo "Running test file: $TEST_FILE"
  $RUN_TEST "$TEST_FILE"

  # Stop the local validator
  echo "Stopping local validator..."
  kill $VALIDATOR_PID
  sleep 1
done

echo "======================================================"
echo "All tests completed!"
echo "======================================================"

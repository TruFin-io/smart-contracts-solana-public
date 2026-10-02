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

DEPLOY_PROGRAM="anchor deploy --program-name staker --program-keypair accounts/staker-program.json"
RUN_TEST="yarn ts-mocha -p ./tsconfig.json -t 1000000"

# Short epochs by default, so tests calling moveEpochForward advance epochs in
# seconds rather than the ~2 days a real epoch takes.
DEFAULT_SLOTS_PER_EPOCH=32

# Per-test-file epoch length overrides, as "<test file>:<slots per epoch>".
#
# add_validator_donation needs the opposite of a short epoch: each scenario must
# complete inside ONE epoch, because AddValidatorToPool, DepositSol and
# WithdrawStake all reject a pool whose last_update_epoch is behind (error 0x11),
# and updating the pool mid-scenario would absorb the owner donation that the test
# exists to observe. A scenario measures ~14 slots, so 32 leaves no usable margin.
SLOTS_PER_EPOCH_OVERRIDES=(
  "tests/add_validator_donation.test.ts:432000"
)

# Returns the slots-per-epoch to use for a given test file.
slots_per_epoch_for() {
  local test_file="$1" entry
  for entry in "${SLOTS_PER_EPOCH_OVERRIDES[@]}"; do
    if [ "${entry%%:*}" = "$test_file" ]; then
      echo "${entry##*:}"
      return
    fi
  done
  echo "$DEFAULT_SLOTS_PER_EPOCH"
}

# Where the validator's own output goes. Keeping it lets failures such as an
# invalid epoch value, a failed program clone or a port already in use be
# diagnosed, instead of surfacing later as a confusing deploy or RPC error.
VALIDATOR_LOG="${TMPDIR:-/tmp}/solana-test-validator.log"

# Starts the local validator with the Token Metadata and SPL Stake Pool programs
# cloned from mainnet. Takes the slots-per-epoch and sets VALIDATOR_PID.
start_validator() {
  : > "$VALIDATOR_LOG"
  solana-test-validator \
    --clone-upgradeable-program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s \
    --clone-upgradeable-program SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy \
    --url mainnet-beta \
    --slots-per-epoch "$1" \
    --reset > "$VALIDATOR_LOG" 2>&1 &
  VALIDATOR_PID=$!
  echo "validator PID: $VALIDATOR_PID (log: $VALIDATOR_LOG)"
}

# Stops the validator started by start_validator, waiting for the process to
# actually exit. Without the wait, the old validator can still be holding port
# 8899 when the next one starts, which fails as "Address already in use".
stop_validator() {
  [ -n "${VALIDATOR_PID:-}" ] || return 0
  echo "Stopping local validator ($VALIDATOR_PID)..."
  kill "$VALIDATOR_PID" 2>/dev/null || true
  # Reap it here so the shell does not report the signal asynchronously.
  { wait "$VALIDATOR_PID"; } 2>/dev/null || true
  VALIDATOR_PID=""
}

# Prints the tail of the validator log, for when startup did not go to plan.
dump_validator_log() {
  if [ -s "$VALIDATOR_LOG" ]; then
    echo "--- last 20 lines of $VALIDATOR_LOG ---"
    tail -20 "$VALIDATOR_LOG"
    echo "----------------------------------------"
  fi
}

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
  dump_validator_log
  return 1
}

# Ensure a validator left over by an earlier run is not already holding the ports.
#
# The pattern is anchored to the flags this script always passes, because a bare
# `pkill -f solana-test-validator` matches ANY process whose command line merely
# mentions the name -- including a shell that invoked this script, or a `tail -f`
# on the validator log -- and kills it.
echo "Checking for existing local validator..."
pkill -f 'solana-test-validator .*--clone-upgradeable-program' || true

# Run the test file(s) in the tests directory
for TEST_FILE in tests/${test_file_name}.test.ts; do
  echo "======================================================"
  echo "Running test file: $TEST_FILE"
  echo "======================================================"

  SLOTS_PER_EPOCH=$(slots_per_epoch_for "$TEST_FILE")

  echo "Starting local validator (slots-per-epoch: $SLOTS_PER_EPOCH)..."
  start_validator "$SLOTS_PER_EPOCH"
  sleep 2 # Wait for the validator to start

  solana config set --url http://127.0.0.1:8899

  # Wait for the RPC server to be ready, restart if necessary
  while ! rpc_is_ready; do
    dump_validator_log
    stop_validator
    echo "Restarting local validator..."
    start_validator "$SLOTS_PER_EPOCH"
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

  # Stop the local validator before moving on to the next test file
  stop_validator
done

echo "======================================================"
echo "All tests completed!"
echo "======================================================"

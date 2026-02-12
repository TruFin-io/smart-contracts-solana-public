
build:
	RUSTUP_TOOLCHAIN="nightly-2024-11-19" anchor build

test: clean
	./test.sh

check-format:
	cargo fmt --check
	cargo clippy --workspace --tests -- --warn clippy::all

clean:
	anchor clean
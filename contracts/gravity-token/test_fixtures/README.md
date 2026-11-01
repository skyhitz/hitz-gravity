# Test fixtures

Two tiny, unrelated Soroban contracts used only to give a registered
pool / router a real WASM hash and then change it, so the tests can
exercise the fail-soft integrity check against a genuine on-chain
upgrade.

- `pool_v1.wasm`: copy of `doctest_fixtures/contract.wasm` (`test_add_u64`) from soroban-sdk 25.3.1.
- `pool_v2.wasm`: copy of `test_wasms/test_contract_data.wasm` from soroban-sdk 25.3.1.

Both come from the soroban-sdk crate (Apache-2.0). They are never deployed.

- `gravity_token_mainnet_v1.0.0.wasm`: the HITZ token bytecode deployed on
  mainnet (`CBAPZAZN…OY4EU`), fetched from the ledger. SHA-256
  `befa64d9d56feba32e18e09f1c364b8a4d863016337bb933ba12cc5c0a8e5b08`, which
  is also its on-chain Wasm hash. The migration rehearsal
  (`contracts/sovereign-vault/tests/mainnet_migration.rs`) upgrades it to
  the current build, exactly as mainnet will be upgraded.

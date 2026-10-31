# Test fixtures

Two tiny, unrelated Soroban contracts used only to give a registered
pool / router a real WASM hash and then change it, so the tests can
exercise the fail-soft integrity check against a genuine on-chain
upgrade.

- `pool_v1.wasm`: copy of `doctest_fixtures/contract.wasm` (`test_add_u64`) from soroban-sdk 25.3.1.
- `pool_v2.wasm`: copy of `test_wasms/test_contract_data.wasm` from soroban-sdk 25.3.1.

Both come from the soroban-sdk crate (Apache-2.0). They are never deployed.

# Wallet Studio

Multi-wallet transaction orchestration for Base mainnet and Base Sepolia (OP Stack, EVM, ETH gas). Uses viem's Base chain definitions and transaction serializers.

Default mode is **simulation** (no broadcasts). Switch to `live` only when you intend to send real transactions.

## BTC69K integration

Run all Studio commands from the wallet-studio repository root.

Keep the BTC69K checkout next to this one:

```text
GitHub/
  bitcoin-fun/     # protocol contracts, Foundry tools, BTC69K website
  wallet-studio/   # bundler, wallet dashboard, curve tests, saved wallets
```

For integrated testing use Node.js 24+, install dependencies in both repositories, and run `npm run local:install-foundry` in bitcoin-fun. Set `BTC69K_PROJECT_ROOT` to an absolute path if that checkout lives elsewhere. Standalone `npm run studio` does not require bitcoin-fun.

| Command (from wallet-studio) | Purpose |
| --- | --- |
| `npm run studio` | Persistent ten-wallet dashboard on port 4310 |
| `npm run local:curve:up` | Guarded local curve, Studio 4312, website 3001 |
| `npm run local:curve:test` | Isolated automated curve lifecycle and wallet cap checks |
| `npm run local:curve:down` | Stop the local curve services |
| `npm run sepolia:curve:up` | Base Sepolia setup and trading UI on port 4313 |
| `npm run sepolia:curve:down` | Stop the Sepolia UI services |
| `npm run sepolia:curve:rehearse` | Ten-wallet payment routing rehearsal on a local Sepolia fork |

Open the complete authenticated URL printed by each launcher. See [local curve testing](LOCAL_TESTING.md), [Base Sepolia testing](BASE_SEPOLIA_TESTING.md), and [BTC69K payment routing](../bitcoin-fun/PAYMENT_ROUTING.md).

### Existing wallets after the repository move

The original encrypted CLI/Studio wallets live in `data/`. Sepolia vaults, profile bindings, deployment journals and receipts live in `.local/base-sepolia/`. Their contents and passphrases are unchanged. These directories and `.env` are ignored by Git; cloning this repository does not transfer wallets. Keep encrypted backups and their passphrases.

To resume the existing payment deployment with its original ten wallets:

```powershell
cd D:\Shared\GitHub\wallet-studio
$env:SEPOLIA_PROFILE = "payments-v1"
$env:SEPOLIA_WALLET_PROFILE = "default"
# Optional dedicated backend provider; keep its key private.
# $env:BASE_SEPOLIA_RPC_URL = "https://base-sepolia.g.alchemy.com/v2/YOUR_KEY"
npm run sepolia:curve:up
```

Unlock with the original passphrase and resume the same profile. To open the original deployment instead, select `default` for both profile variables.

The migration retained this repository's Git history. The original nested bundler Git metadata and a hash inventory are preserved locally under ignored `.migration/`; historical security evidence is under ignored `.bundler-audit/`. Neither is part of the application or build. See [the security review](BUNDLER_SECURITY_REVIEW.md).

## Local wallet dashboard

```powershell
cd D:\Shared\GitHub\wallet-studio
npm ci --ignore-scripts
npm run studio
```

Open the localhost link printed in the terminal. Create a vault with your own passphrase (at least 16 characters); the dashboard generates **10 EVM wallets**. Choose **Add test ETH** to give every wallet 10 ETH on the local chain, then **Send ETH**, **Distribute ETH**, or **Collect ETH**. Every transfer shows a recipient-and-amount review before you confirm it. Select table checkboxes to limit bulk actions to specific wallets. You can rename wallets, copy/export addresses, create more wallets, and follow transaction receipts in Activity.

The launcher starts [Foundry Anvil](https://getfoundry.sh/anvil/overview/) if installed under `~/.foundry/bin` or on your PATH. Anvil runs on `127.0.0.1:18545`, chain ID 31337, with no pre-unlocked accounts. Its test ETH has no monetary value. The dashboard runs on `127.0.0.1:4310`; keep the terminal running and use Ctrl+C to stop it. Restart with `npm run studio` and open the newly printed link. If Anvil is missing, the dashboard still opens and reports the unavailable local network.

Use the network selector for **Base Sepolia** (84532), where wallets need actual Base Sepolia test ETH, or **Base mainnet** (8453), which is **read-only in this testing UI**. The same addresses work on each network; balances and activity are separate. Studio sends real signed transactions to the selected test chain and is independent of the CLI's simulation setting.

The encrypted vault lives at `data/studio/vault.json`, independently of existing CLI wallets and `.env` settings. Anvil state is saved at `data/studio/anvil-state.json` every five seconds. The passphrase remains in server memory while unlocked and is cleared after 15 minutes without a protected action or when you lock the vault. Private keys are never returned to the browser. Vault settings lets you download an encrypted backup; retain its passphrase separately. To restore a backup, stop Studio, preserve the current vault file, copy the backup to `data/studio/vault.json`, and restart. The passphrase cannot be recovered if lost.

The server accepts loopback requests only, checks Host and Origin, and requires its launch token plus an HttpOnly session cookie. It provides no arbitrary RPC proxy, raw-key export, token approvals, or contract-call endpoint. Local software running as your user can still access your files and local node; this is a local testing tool.

Validation: `npm test` includes the vault/API security tests and a real ten-wallet Anvil integration test when Anvil is installed at `~/.foundry/bin`; that integration test is explicitly skipped otherwise. `npm run typecheck` checks both server and React UI.

## Network

| Network | Chain ID | Public RPC | Sequencer |
|---------|----------|------------|-----------|
| Base mainnet (`mainnet`) | `8453` | `https://mainnet.base.org` | `https://mainnet-sequencer.base.org` |
| Base Sepolia (`sepolia`) | `84532` | `https://sepolia.base.org` | `https://sepolia-sequencer.base.org` |

The default network is `sepolia`. `base` and `base-mainnet` alias `mainnet`; `testnet` and `base-sepolia` alias `sepolia`. Unknown CLI networks and modes are rejected. Select a network with `BUNDLER_NETWORK` or `--network`.

Set `ALCHEMY_API_KEY` for automatic Base provider URLs, or set `RPC_URL` and optionally `RPC_URL_SECONDARY` for your selected chain. Supply `WS_URL` or an Alchemy key for WebSocket subscriptions; otherwise events use HTTP polling. Changing `--network` does not rewrite explicit custom endpoint or DEX settings. `health` checks each read endpoint's chain ID. Sources: [Base RPC documentation](https://docs.base.org/base-chain/api-reference/rpc-overview), [Base sequencer configuration](https://github.com/base/node), [Alchemy networks](https://www.alchemy.com/docs/reference/node-supported-chains).

## Quick start

```bash
cd D:\Shared\GitHub\wallet-studio
cp .env.example .env
# Set a unique WALLET_PASSPHRASE of at least 16 characters in .env first.
npm ci --ignore-scripts
npm run build

# Paper demo (simulation): creates wallets + buy bundle + execute + dashboard
npm run dev -- demo

# Check either network without broadcasting
npm run dev -- --network sepolia health
npm run dev -- --network mainnet health
```

## What is implemented

| Module | Role |
|--------|------|
| `WalletManager` | create/import/encrypt wallets, balances, fund, consolidate, export |
| `NonceManager` | reserve / release / reconcile nonces across workers |
| `RpcManager` | multi-endpoint failover, latency/health checks |
| `SequencerClient` | optional raw-tx submission to the selected Base sequencer |
| `SubmissionMetrics` | submit/confirm latency p50/p95 for tuning concurrency |
| `GasManager` | fee estimates, gas distribution, wallet gas audits |
| `FundingPlanner` | compute + execute per-wallet funding for a bundle |
| `TokenManager` | ERC-20 metadata, transfer/approve/mint/burn, deploy hook |
| `DexManager` + adapters | pluggable DEX quotes/swaps (`mock`, optional Uniswap V2) |
| `BundleBuilder` | create/clone bundles, buy plans, validate, cancel |
| `Simulator` | dry-run balances, calldata, gas |
| `ExecutionEngine` | parallel workers, lifecycle states, retry/resume/reconcile |
| `EventMonitor` | Transfer / Approval / Swap log subscriptions |
| Dashboard | ASCII bundle status board |
| CLI | full lifecycle from the terminal |

## Architecture

```text
Bundler
  ├── WalletManager + NonceManager
  ├── BundleBuilder + FundingPlanner
  ├── ExecutionEngine ──► DexAdapter ──► RPC / Sequencer
  ├── GasManager + RpcManager + SubmissionMetrics
  ├── TokenManager
  └── Simulator / EventMonitor / Dashboard
```

Actions are generic EVM calls (`SWAP`, `APPROVE`, `TRANSFER`, `CONTRACT_CALL`, …), so the engine stays strategy-agnostic.

## CLI examples

```bash
# Create 5 wallets + export addresses
npm run dev -- wallet create traders --count 5
npm run dev -- wallet export --csv

# Import a key through hidden terminal input (never pass the key as an argument)
npm run dev -- wallet import --label trader

# Create a bundle targeting a token
npm run dev -- bundle create --name launch-1 --token 0xYourToken

# Single buy or bulk buy plan
npm run dev -- bundle add-buy <bundleId> --wallet 0x... --amount 0.1
npm run dev -- bundle add-buy-plan <bundleId> --plan '[{"wallet":"0x...","amountEth":"0.1"}]'

# Funding plan (attach + optionally execute)
npm run dev -- bundle funding-plan <bundleId> --funder 0xFunder --attach
npm run dev -- bundle funding-execute <bundleId>

# Validate → simulate → execute → dashboard
npm run dev -- bundle validate <bundleId>
npm run dev -- bundle simulate <bundleId>
npm run dev -- --mode simulation bundle execute <bundleId>
npm run dev -- bundle dashboard <bundleId>

# Recovery: reconcile existing submissions before any new work
npm run dev -- bundle retry-failed <bundleId>
npm run dev -- bundle resume <bundleId>
npm run dev -- bundle reconcile <bundleId>

# Tx history
npm run dev -- tx list --bundle <bundleId>
```

## Live DEX + sequencer

```bash
# .env
BUNDLER_NETWORK=sepolia
DEX_ROUTER_ADDRESS=0x...
WETH_ADDRESS=0x...
BUNDLER_MODE=live
USE_SEQUENCER=true   # sign locally, eth_sendRawTransaction to sequencer
```

The **mock** adapter is available only in simulation mode. Live buys require a configured real router and WETH address; persisted mock actions are rejected before signing. The configured real adapter takes precedence when present.

Every live bundle transaction is signed locally. Its computed hash and nonce are stored before broadcasting. `retry-failed`, `resume`, and `reconcile` retain this identity: a timeout or missing receipt never automatically causes another send. Actions with prior submission evidence, including confirmed reverts, require explicit investigation before creating replacement actions. Older ambiguous records without a hash also remain blocked. Cloning resets execution state and represents a new spending instruction; do not clone pending transactions as a recovery shortcut.

Direct sequencer submission is optional and is not an atomic bundle service or an ordering guarantee. Sequencer endpoints are excluded from read-RPC failover and are only health-checked when `USE_SEQUENCER=true`. Start with the standard RPC path. Use a verified Uniswap V2-compatible router on the selected chain; V3/Universal Router addresses do not implement this adapter's ABI.

Gas estimates currently cover L2 execution only. Keep an additional ETH reserve for Base's L1 data and operator fees; the funding estimate is not a complete transaction-fee quote.

## Token deploy note

`TokenManager.deployToken` contains placeholder bytecode and supports simulation only. Live deployment is explicitly disabled. Enabling it requires a reviewed compiled artifact and a corresponding implementation change; replacing the bytecode alone does not enable broadcasting.

## Data

With `DATA_DIR` empty, local JSON lives under `./data/base-mainnet` or `./data/base-sepolia` (gitignored), selected after CLI/programmatic network overrides. An explicit `DATA_DIR` overrides this separation:

- `wallets.json` — encrypted private keys (AES-256-GCM)
- `bundles.json` — bundle definitions + action states
- `transactions.json` — execution history

New bundles record their `chainId`. Execution, simulation, funding, cloning, and reconciliation reject bundles for another chain or legacy bundles without a chain ID. Existing data is not automatically moved or relabelled. Use `bundle list` / `bundle show` to inspect old records, and create fresh bundles for Base. This migration replaces the old Robinhood profiles; `mainnet` now means Base. Wallet import/re-encryption remains explicit, and existing encrypted wallets are left untouched.

Set a unique `WALLET_PASSPHRASE` of at least 16 characters before creating, importing, or using wallet keys. Empty, short, and former example passphrases are rejected. Read-only health/configuration operations do not require a passphrase.

Changing `.env` does not re-encrypt existing wallet files. Back up the encrypted store, set the new passphrase in `.env`, then run `npm run dev -- wallet reencrypt` and enter the old passphrase at the hidden prompt. The migration updates all wallets atomically and leaves the original store intact if decryption fails. It supports recovering wallets encrypted with the former example passphrase. Re-encryption does not undo prior exposure of a private key.

For automation, `wallet import --key-stdin` and `wallet reencrypt --passphrase-stdin` accept secure input streams. Do not embed secrets in shell commands or scripts.

JSON updates use cross-process locks and atomic replacement. New files request owner-only permissions on POSIX systems; on Windows, restrict the data directory with your account's filesystem ACLs. Bundle execution uses one `.execution.lock` per data directory. After a crash, remove a leftover lock directory only after verifying its owning process has stopped. Then reconcile pending transactions. Use one data directory per wallet set and avoid editing bundle definitions during execution.

## Dependency security

The unused `oscar-redis` dependency and its transitive chain have been removed. Direct dependencies are pinned to the reviewed lockfile versions. `.npmrc` disables lifecycle scripts by default; use `npm ci --ignore-scripts` for reproducible installation. Review dependency and lockfile changes before updating them. These source changes do not establish whether an earlier installation compromised a machine.

## Tests & example

```bash
# Build and run unit/security regression tests (fake transactions, temporary stores)
npm test

# programmatic example
npx tsx examples/basic-bundle.ts
```

## Programmatic use

```ts
import { Bundler } from "base-token-bundler";

const bundler = Bundler.create({ mode: "simulation", network: "sepolia" });
const wallet = await bundler.wallets.createWallet("bot-1");
const bundle = await bundler.bundles.createBundle("batch", "0xToken");
await bundler.bundles.addBuyActions(bundle.id, [
  { wallet: wallet.address, amountEth: "0.05" },
]);
await bundler.executor.executeBundle(bundle.id);
console.log(await bundler.dashboard(bundle.id));
```

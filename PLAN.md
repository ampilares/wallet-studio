# Wallet Studio: NFT minting on Base with 100 wallets

Planning baseline: 18 September 2026; current-state notes updated 23 September 2026. This is the historical NFT extension roadmap, not authorization to move funds. See [the codebase audit](CODEBASE_AUDIT.md) for the maintenance findings and completed fixes.

## Existing implementation: use as the foundation

The canonical project is `D:/Shared/GitHub/wallet-studio`, with origin `https://github.com/ampilares/wallet-studio.git`. It was migrated from bitcoin-fun on September 17. The temporary OneDrive copy has been reconciled back into this checkout. See [RECONCILIATION.md](RECONCILIATION.md) and [README.md](README.md). Existing Git history, credentials, wallet vaults, and transaction data remain in place.

The implementation reuses the React UI (`ui/`), authenticated local server (`src/studio/`), encrypted vault, Base RPC and nonce handling, and JSON storage. The dashboard creates ten wallets initially and supports up to 200. NFT campaigns and reviewed mainnet ETH distribution are implemented, with durable transaction recovery and explicit mainnet gates. Generic mainnet Send/Collect remains disabled. See [README.md](README.md) for supported operations.

The architecture and phases below are target requirements, not instructions to rebuild working components. Preserve the current TypeScript layout and JSON storage initially. Evaluate SQLite only when implementing campaign persistence and recovery proves it necessary. First add an NFT collection adapter and campaign records around the existing services, then extend the UI. Keep the legacy BTC69K token/curve integrations optional.

Campaign configuration, API-level per-wallet proof mapping, Base fee estimates, budgets, ERC-721/ERC-1155 receipt checks and the reviewed mainnet mint path now exist. The broader rollout still calls for a controlled end-to-end 100-wallet NFT campaign and operational validation of the collection-specific adapters. JSON persistence remains in use; SQLite, watch-only/keystore imports and fee replacement are roadmap items. Sections below describe the original target design, not a statement that every phase remains unimplemented.

## Objective and assumptions

Build a local application that lets one operator select 100 controlled wallets, configure a mint campaign, check eligibility and funding, and execute and track one mint per wallet on Base. Quantity per wallet can be configurable within the collection's rules.

The initial assumption is minting an existing collection. Each wallet signs its own transaction; minting 100 NFTs from one wallet and distributing them is a different workflow. Confirm the collection contract and wallet source before implementation. If the objective is a new collection, add contract deployment and metadata work as described below.

MVP scope: one operator, one active campaign, Base Sepolia and Base mainnet, ETH-priced or free mints, and one explicitly supported collection adapter. ERC-721 and ERC-1155 collections need their own mint-function configuration; their token standards do not define a universal public mint function. ERC-20 payments, scheduled launch racing, bridging, and NFT consolidation are later extensions.

## Proposed architecture

- React and TypeScript dashboard for wallets, campaign setup, preflight, execution, and results.
- Local Node.js/TypeScript service with viem for contract reads, simulation, signing integration, and transaction submission. viem supports validating contract calls through `simulateContract` before writing ([documentation](https://viem.sh/docs/contract/simulateContract)). Simulation is a snapshot and cannot guarantee inclusion or future success.
- Current implementation: locked, atomically replaced JSON files for wallets, campaigns and attempts. SQLite is a future migration to evaluate if measured history size or contention warrants it; Redis is unnecessary for the current local operator workflow.
- Separate signer/vault module. The dashboard and ordinary API responses receive addresses and statuses, never private keys.
- Configurable primary and fallback RPC endpoints, verified against the expected chain ID on connection. Use a production provider with adequate quotas and rate limiting for the full run.

Base mainnet uses chain ID 8453; Base Sepolia uses 84532, and both use ETH for gas ([Base network documentation](https://docs.base.org/get-started/connect-to-base)). Keep their wallet groups, funding actions, and campaigns visibly separated.

Current source modules remain `ui/`, `src/studio/`, `src/chain/`, `src/wallet/`, `src/nft/` and `src/database/`. No directory migration is required by this roadmap.

## Implementation sequence

### 1. Application and storage foundation

Create the dashboard, local service, database migrations, configuration validation, and structured log redaction. Bind the service to loopback and protect state-changing requests with a session token and origin checks.

Define `Wallet`, `Campaign`, `MintJob`, `TransactionAttempt`, `FundingJob`, and `AuditEvent` records. Persist chain, contract, wallet selection, function/arguments, quantity, value, cost limits, and confirmation policy in an immutable campaign snapshot when execution starts. Changing these creates a new revision requiring a fresh review.

Acceptance: create and reopen a draft campaign; wrong-network RPC configuration is rejected.

### 2. Wallet management and signing

Support encrypted keystore import and optional generation of a fresh group of 100 wallets with a reviewed wallet library. Deduplicate by address and record labels, groups, signer references, and derivation paths where applicable. Address-only imports are watch-only until a signer is attached.

Use an established encrypted keystore format and operating-system protection for stored credentials; do not create custom cryptography. Unlock signing for a bounded session. Never put secrets in browser storage, logs, CSV exports, or source control. Provide encrypted backup and restore verification before funding generated wallets.

This canonical repository is outside OneDrive. Preserve existing vault locations during the extension. If configuring a different storage path, use a private directory outside cloud-synced folders; repository ignore rules alone do not prevent cloud synchronization. The current dashboard retains data/studio by default and supports an explicit STUDIO_DATA_DIR override.

Acceptance: 100 unique wallets load, balances refresh, a locked vault cannot sign, and backups restore the same addresses without exposing keys in the UI or logs.

### 3. Collection configuration and preflight

Require the Base contract address, reviewed ABI, exact mint function, arguments, recipient mapping, payment amount, quantity, and any wallet-specific allowlist proof or signature. Check deployed bytecode and use verified contract information where available. Reject unsupported mint mechanisms with a clear explanation.

The adapter reads sale state, price, limits, and remaining supply where the contract exposes them. Simulate the actual call from each selected wallet, including its real arguments and payment. Show a result per wallet: ready, underfunded, ineligible, sale inactive, sold out, or contract error. Recheck time-sensitive inputs immediately before submission.

Acceptance: successful and failing simulations are attributed to the correct wallet, with useful revert reasons. A contract/price/configuration change invalidates the previous review.

### 4. Funding and cost controls

Calculate each wallet's shortfall from its existing Base ETH balance, mint payment, estimated transaction fees, and an explicit buffer. Base fees include L2 execution and L1 data/security components; estimating only execution gas understates cost ([Base fee documentation](https://docs.base.org/specifications/transactions/network-fees)).

Show the aggregate cost and a funding preview. Optionally distribute only shortfalls from an operator-selected funding wallet after explicit execution confirmation. Track funding in its own durable queue, serialize the funding wallet's nonces, and confirm transfers before marking recipients funded. Include funding transaction fees in the funding wallet's required balance.

Apply per-wallet payment limits, transaction fee settings, and a campaign spend ceiling. Reserve budget atomically before concurrent submissions; account for pending transactions, replacements, and fees spent on reverted transactions. Refresh L1 estimates and explain that a spend budget is an application control, not a protocol-level guarantee of a precise final fee.

Budget model: sum of mint payments + mint transaction fees + funding transaction fees + explicit contingency. Existing wallet balances reduce additional funding required. Do not hard-code a fiat or ETH estimate before the collection is known.

Acceptance: underfunded wallets cannot start; concurrent jobs cannot independently consume the same available budget; interrupted funding resumes without paying recipients twice.

### 5. Durable mint execution

Start with five concurrent wallet jobs, configurable up to ten after measurement. This is an initial tuning choice, not a chain limit. Rate-limit submission and polling separately, with backoff for provider throttling. Maintain one in-flight transaction per wallet across funding and mint operations using wallet/chain locks and pending nonce reconciliation.

Persist job transitions: draft -> preflight -> ready -> signed -> submitted -> included -> confirmed, plus blocked, reverted, cancelled-before-send, and unresolved states. Record transaction payload, nonce, locally computed transaction hash, replacement lineage, receipt block hash, actual fees, and decoded mint results.

Before broadcasting, durably store the signed transaction in protected local storage and its deterministic hash. If submission times out or the process stops, reconcile the hash and nonce before taking further action. Rebroadcast identical signed bytes when appropriate; never treat a timeout as permission to mint again with a new nonce. Fee replacements use the same nonce and intended call within budget. A consumed nonce with no identified outcome stays unresolved for investigation.

Enforce a unique logical job identity per campaign revision, wallet, and mint operation. Prevent two workers or repeated Start clicks from claiming the same job. Do not retry deterministic contract reverts automatically; transient transport errors use bounded retries and reconciliation.

Pause stops new dispatch while receipt monitoring continues. Stop cannot undo submitted transactions. Distinguish inclusion, configured confirmation depth, and finality; detect receipt disappearance/block-hash changes after reorgs and reconcile. Successful receipts must also contain the expected mint events or contract-specific outcome; decode token IDs and verify the expected recipient.

Acceptance: interruption immediately before and after broadcast does not cause an extra mint; restart recovers pending jobs; a partial failure does not erase completed results.

### 6. Dashboard and reporting

Implement five screens: Wallets, New Campaign, Preflight Review, Live Run, and Results. Show 100 per-wallet rows with balance, readiness, transaction status, explorer link, token IDs, actual spend, and error reason.

Provide Start, Pause, Resume, Stop New Submissions, and controlled retry for eligible failed jobs. Require an execution review showing chain, contract, wallet count, quantities, and budget. CSV/JSON exports contain operational results only.

Acceptance: every selected wallet has an explicit outcome, and submitted/pending transactions remain visible after reopening the application.

### 7. Verification and rollout

Use local test contracts to cover free/paid minting, supply exhaustion, per-wallet limits, allowlists, ERC-721 and ERC-1155 events, incorrect recipients, and reverts. Test fee arithmetic with integer base units, wallet deduplication, job claiming, budget reservation, and secret redaction.

Inject RPC throttling, timeouts after accepted broadcasts, nonce conflicts, replacements, crashes at persistence boundaries, and simulated reorgs. On Base Sepolia, execute a complete 100-wallet campaign against a controlled collection and verify receipts and resulting ownership/balances. Test restarting midway and resuming.

Roll out on mainnet only after operator approval: one wallet, then a small group, then the remaining selected wallets, without re-minting the pilot wallets. A sold-out or changing public sale may prevent all 100 wallets from minting; the application must report that accurately.

Release gate: all 100 jobs are accounted for; normal successful test runs produce the intended NFTs; recovery tests do not generate unintended duplicate mints; spend reconciliation matches receipts; private keys remain out of logs, exports, and the project tree.

## If the collection is yours

Add collection requirements, ERC-721/ERC-1155 contract selection, contract tests/review, metadata hosting, deployment, verification, mint permissions, and supply settings. Decide whether 100 wallets must each originate a mint or only receive NFTs. If only ownership matters, an owner-authorized batch mint to recipients may reduce operational work, subject to the contract's gas limits. This changes the core transaction model and should be decided before implementing the adapter.

## Inputs needed before implementation

- Existing collection address/mint page, or confirmation that a new collection must be deployed.
- Whether the 100 wallets already exist and how signing access will be provided; never supply seeds or private keys in chat.
- Quantity per wallet, supported sale mechanism, and whether each wallet must be the minting sender.
- Maximum mint price, total budget, funding source, and acceptable run duration.

Recommended first milestone: a single-wallet Base Sepolia mint with secure signing and durable recovery, followed by the same workflow expanded to 100 wallets. Complete the execution engine before adding convenience features.

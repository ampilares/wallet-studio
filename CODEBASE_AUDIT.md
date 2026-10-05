# Codebase audit and remediation

Date: 23 September 2026. Scope: the current canonical working tree, including pre-existing uncommitted NFT, funding, Garlic and security changes. This is a source review and local verification, not a mainnet execution or a complete external contract audit.

## Findings and implementation plan

| ID | Priority | Finding and consequence | Remediation | Status |
| --- | --- | --- | --- | --- |
| A01 | High | Legacy wallet funding/consolidation and token sends bypass the mainnet gate, send before journaling identity, and release nonces on ambiguous RPC errors. A retry can duplicate spending. | Route these calls through a durable sender with the shared execution lock, mainnet/chain checks, hash-before-send persistence and receipt-only reconciliation. | Fixed |
| A02 | High | CLI execution checks pending submissions only in the selected bundle. Another bundle or legacy send can reuse a wallet with unresolved work. Cancellation, stale edits and replacement receipts can also obscure signed identity. | Check unresolved transactions across journals; reject history-erasing saves/deletes under the store lock; preserve signed actions on cancellation; require matching receipt hashes. | Fixed |
| A03 | High | Studio ETH execution trusts an earlier review's pending-transfer checks, does not check NFT pending work, and retains an unlocked passphrase throughout a batch. | Recheck journal conflicts and session authorization before each signature and broadcast; normalize selected addresses. NFT/funding workers also recheck session/mainnet gates before broadcast. | Fixed |
| A04 | Medium | ERC-1155 receipt verification counts unique IDs rather than event quantities. A zero-value event can look like a mint and multiple units of one ID fail verification. | Decode and sum positive event quantities; verify balances at the receipt block while retaining unique IDs for display. | Fixed |
| A05 | Medium | Request URL parsing occurs outside the HTTP handler's catch block. A malformed request target can cause an unhandled rejection. | Validate request targets inside the error boundary and regression-test server survival. | Fixed |
| A06 | Medium | Studio reconciles only the last 80 displayed activity rows. Older unresolved transfers can remain blocked indefinitely. | Reconcile all pending records on the selected network independently of display pagination. | Fixed |
| A07 | Medium | CLI execution and RPC health persist or display raw provider exceptions, which can include credential-bearing URLs and signed payloads. | Use sanitized operational errors at persistence/output boundaries, including nested distribution errors and sequencer responses. | Fixed |
| A08 | Medium | The test command inherits the real environment and working directory; configuration loads `.env`, and constructor ACL hardening can touch operational files. The explicit test-file list also misses new tests. | Add an isolated test runner with temporary working directory, clean environment and source-based discovery. | Fixed |
| A09 | Medium | Legacy funding analysis sends the full target balance to partially funded wallets and omits transfer fees from its affordability claim. | Calculate per-wallet shortfalls, exclude the funder, and identify fee reserves separately. Recheck shortfalls before sending and stop on ambiguity. | Fixed |
| A10 | Low | `PLAN.md` still says NFT minting is absent, mainnet is read-only and the vault limit is 100. Placeholder ERC-20 bytecode remains exposed as a simulated deployment artifact. | Correct historical/current-state documentation and remove misleading executable placeholder bytecode; retain ABI/constructor validation. | Fixed |
| A11 | Medium | Reserving a nonce advanced the submitted-nonce boundary even if preparation failed. Releasing the reservation could leave an unsent nonce gap. | Keep unsigned reservations separate from the submitted boundary; a released unsigned nonce is reusable. | Fixed |
| A12 | Medium | The bundle summary adds gas units and labels the result wei, understating costs by the effective gas price. | Record receipt prices, multiply units by price, and label the result L2 execution fees. Missing historical prices produce an unknown value. | Fixed |
| A13 | Medium | Studio's separate startup ACL code did not remove existing explicit broad grants, and the shared hardener omitted vault/campaign/funding files. | Use the shared restrictive hardener at Studio startup and cover the current secret-bearing stores. | Fixed |
| A14 | Medium | `/api/sepolia/setup` unlocks vaults through the extension handler before the standalone unlock limiter. | Apply the same failure counter and cooldown to both unlock routes. | Fixed |

Order: isolate verification first; close signing/recovery gaps; correct receipt/API/history behavior; remove stale implementation and documentation; run type checks, the full local suite and production UI build. Each material security or transaction change gets a behavioral regression test.

## Baseline and scope limits

- Server and UI type checking passed before edits.
- `npm audit --ignore-scripts --json` reported zero known advisories (121 dependency entries). Advisory matching does not establish package integrity or absence of malicious code.
- The initial test runner could not spawn subprocesses under the Windows sandbox (`EPERM`); this was an environment failure, not an assertion failure.
- Existing wallets, credentials, saved campaign/funding records and Git history are preserved. Verification uses disposable vaults and local nodes or mocked RPCs.
- BTC69K curve/Sepolia integrations, exported SDK APIs and historical security evidence are still referenced and are not treated as dead code merely because the NFT UI does not use them.

## Implementation and regression evidence

### Signing, recovery and nonces (A01–A03, A11)

The previous legacy send sequence was reserve -> send -> record success. The new [direct sender](src/core/DirectTransactionSender.ts) prepares and signs locally, writes the deterministic hash/nonce, then broadcasts. A lost reply leaves the original record pending and blocks another signature from that wallet across restarts. `wallet reconcile` checks that hash and canonical receipt block without resending. Direct calls now wait for a receipt before a distribution continues. Simulation estimates without decrypting a wallet.

[WalletManager](src/wallet/WalletManager.ts) and [TokenManager](src/token/TokenManager.ts) use this sender, including the mainnet gate. WalletManager also verifies that the decrypted key matches the requested address. [ExecutionEngine](src/core/ExecutionEngine.ts) and [transactionSafety](src/core/transactionSafety.ts) block unresolved work across journals within the same data directory. Signed history is no longer marked cancelled, and a replacement receipt cannot confirm the original action. [NonceManager](src/wallet/NonceManager.ts) no longer treats a reservation as a submission.

[StudioService](src/studio/service.ts) rechecks transfer/NFT conflicts inside its operation lock, including when the conflicting transaction appeared after preview. It deduplicates mixed-case wallet selections and checks that the session is still unlocked after asynchronous preparation. NFT/funding workers perform the same final authorization checks. Transactions already submitted cannot be undone by locking.

Regressions: all six legacy wallet/token send entrypoints reject a disabled mainnet gate before key access; wrong-chain direct sends fail; a lost reply produces one signature and one broadcast across restart/reconciliation; concurrent sends hold the shared lock; a second bundle cannot evade pending identity; replacement receipts remain unresolved; stale saves, removals and deletes cannot erase signed history; real Anvil tests cover stale reviews, mixed-case selection and lock-during-nonce-lookup.

### Receipt/accounting corrections (A04, A06, A09, A12)

[NFT decoding](src/nft/adapter.ts) now aggregates positive ERC-1155 event values by token ID. [Campaign settlement](src/nft/CampaignService.ts) compares the sum to the reviewed quantity and checks balances at the receipt block. This follows the event quantity semantics in the [ERC-1155 specification](https://eips.ethereum.org/EIPS/eip-1155#specification). Unique token IDs remain available to existing UI consumers; quantity metadata is additive.

Tests cover repeated IDs, batch events, wrong recipients, zero-value events, correct multi-unit mints and insufficient resulting balances. Studio's activity test places a pending receipt outside the 80-row display window and verifies it still settles.

[FundingPlanner](src/core/FundingPlanner.ts) computes target minus current balance, omits the sender and duplicate addresses, includes L2 gas estimates plus a separate batch reserve, and rechecks recipients before dispatch. A test starts a wallet at 0.0015 ETH against a 0.002 ETH target: it receives 0.0005 ETH once, and rerunning after funding sends nothing. This reserve is an application allowance, not a guaranteed Base fee cap.

[BundleBuilder](src/core/BundleBuilder.ts) computes L2 fees as gas used × effective gas price. The CLI explicitly labels those fees; NFT/mainnet Studio funding retain L1/operator accounting. Legacy records without receipt prices return `gasSpentWei: null`, displayed as `not recorded`.

### API, secrets and test isolation (A05, A07, A08, A13, A14)

[Server](src/studio/server.ts) rejects malformed/absolute request targets within its catch boundary, and applies a shared cooldown to standalone and Sepolia unlock attempts. Tests send a malformed target followed by valid requests, and prove that five failed Sepolia unlocks block both routes.

[Error handling](src/security/errors.ts) uses categorized provider failures, strips provider URLs and raw transaction data at CLI boundaries, and prevents sequencer response bodies from reaching logs. Tests inject fake credential-bearing URLs/payloads into diagnostics and nested distribution results. Existing historical logs/records are preserved; this change prevents new leakage at these reviewed boundaries rather than rewriting audit history.

[Permission hardening](src/security/sensitiveFiles.ts) now covers current vault, transaction, campaign and funding files. [Studio startup](src/studio/start.ts) uses that shared implementation. The permission test adds an explicit Everyone grant to disposable Windows files and checks it is removed. No operational file permissions were changed while running this audit.

[Test runner](scripts/test.mjs) preserves only necessary OS environment variables, points dotenv at a nonexistent disposable file, runs from a temporary working directory, discovers compiled tests from current sources and cleans up after exit. The full suite uses mocked providers or disposable local nodes. It does not load the real `.env`, create wallets in the operational data directory, or mutate the operational ACLs.

### Stale code and compatibility (A10)

- Removed the incomplete ERC-20 executable bytecode blob and artifact wrapper. `deployToken` simulation now returns constructor data with `deploymentSupported: false`; live deployment remains disabled. Consumers expecting its former `bytecode`, `address` or `hash` fields must use the documented new simulation result.
- Removed an unused simulator client reference and its `void` suppression.
- Replaced duplicate Studio startup ACL logic with the shared security helper.
- Corrected `PLAN.md` to distinguish the original roadmap from the implemented 200-wallet NFT/funding features and current directory layout. README documents direct-send recovery and isolated testing.
- Normalized two legacy Windows-encoded separator characters in `src/curve/service.ts` to valid UTF-8 while preserving its behavior.
- Retained the curve/Sepolia integration, simulation/mock DEX support, exported rate limiter, Solidity example, historical reports and migration notes. They have current references or a documented role; removing them would remove supported workflows or provenance.

## Verification

- Baseline: 71 tests passed, zero skipped, after resolving the sandbox's subprocess restriction with an isolated run.
- Server and React UI type checks: passed.
- TypeScript build: passed.
- Production UI build (esbuild and Tailwind): passed; Windows subprocess access was required.
- Final expanded regression suite: **94 tests passed, zero failed, zero skipped** (23 more tests than the baseline), including the real 199-recipient local funding run. Command: `node scripts/test.mjs` after `npm run build`; `npm test` performs that build and isolated run together.
- Dependency advisory check: zero known vulnerabilities; dependencies and lockfile versions were not changed.
- Whitespace/diff check: passed.

## Remaining engineering roadmap and limits

The 14 findings above are implemented. These larger improvements are separate follow-up work, not prerequisites for the fixes:

1. **Broader rollout testing:** run a controlled 100-wallet NFT campaign on a dedicated test contract, exercising ERC-721/1155 ownership, provider throttling and restart during minting. Acceptance: every job accounted for, no extra signatures for ambiguous jobs, and spend matched to receipts. This audit did not broadcast on public chains or run the live Genesis drop/adjacent BTC69K fork rehearsal.
2. **Persistence scaling:** benchmark history sizes and JSON rewrite contention before considering SQLite. A migration should import a copy, compare wallet/journal identities and support rollback; it must not move the existing vault implicitly.
3. **Responsiveness:** profile synchronous scrypt during large wallet creation/unlock workflows; if it is a practical bottleneck, move KDF work to a bounded worker pool with cancellation and secret-lifetime tests.
4. **Recovery operations:** retain the intentional fail-closed behavior for stale filesystem locks and signed-but-unconfirmed CLI records. A future recovery UI must establish process ownership and transaction outcome before allowing replacements. Direct CLI reconciliation does not rebroadcast signed bytes; the NFT/Studio funding paths retain their existing identical-byte recovery mechanisms.

This review covers first-party source, configuration, launch/build scripts, storage and relevant dependency advisories. It is not a host-forensics review, registry-integrity re-audit, or independent review of every external contract. Mainnet fee-oracle behavior is modeled in local funding tests; local success is not a prediction of a public mint's availability or fees. User credentials, wallets, transaction history, pre-existing uncommitted work and Git history were preserved. No commit or push was made.

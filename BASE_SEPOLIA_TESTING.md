# Base Sepolia curve testing

Start with `npm run sepolia:curve:up` from the wallet-studio repository root. Open the token-bearing link printed by the launcher. The setup UI runs at 127.0.0.1:4313; the BTC69K website starts at 127.0.0.1:3001 after deployment. Stop the UI services with `npm run sepolia:curve:down`. Stopping services does not reverse or stop transactions already submitted to Sepolia.

## Setup and funding

1. Connect Phantom's public EVM address or paste it into the setup form. It becomes the separate website wallet.
2. Create a unique vault passphrase of at least 16 characters directly in the browser. This protects ten trading wallets and one deployment/funding wallet. Never enter a Phantom recovery phrase or private key.
3. Download the encrypted backup and retain its passphrase. Restarting prompts for the same passphrase; the accounts and deployment persist.
4. Send 0.05 **Base Sepolia ETH** to the generated deployment account displayed in the setup UI. This is a conservative funding budget, not a gas quote. The account funds each test wallet up to 0.003 ETH and pays deployment gas. The remaining ETH stays in the encrypted account. The sender must confirm the transfer in Phantom on Base Sepolia (chain 84532).
5. Select Deploy and fund. Setup deploys the same protocol contracts used by the Base deployment graph, with test-only mock cbBTC and MockGenesis721. The test deployment account controls curve opening, mock quote minting, and test administrative roles. It is not a production Safe configuration. NFT metadata is explicitly test-only.
6. After setup completes, open the wallet controls. Connect Phantom to the localhost Launchpad to use the separate website wallet. Its quote balance is prefunded with 1 mock cbBTC.

The curve starts with 3,450,000 BTC69K, 0.0625 virtual quote reserve, a 0.25 mock-cbBTC graduation target, 150 guard blocks and a cumulative cap of 34,500 BTC69K per wallet. Opening the curve does not start the guard; its first successful buy does. The UI never starts buying as part of setup.

## Cap run and trading

Buy all 10 wallets to cap executes repeated concurrent batches with bounded approvals. Public-network inclusion order and block are not guaranteed. The runner recalculates remaining purchase allowance, refuses to continue near guard expiry, and revokes unused allowances after the run. Quote precision can leave less than one quote-unit's purchasable output below the cap. Selling does not restore the cumulative allowance.

Stop after this round stops future cap rounds; already submitted transactions may still confirm. Vault auto-locking prevents new signatures until unlocked. A failed or unresolved earlier batch blocks a new cap run. Refresh reconciles receipts without sending another transaction. Do not interpret a timeout as a failed transaction.

The full local-fork rehearsal also tests graduation and a real Uniswap v4 swap. Sepolia post-graduation trades call the v4 adapter's quoteExactInput and swapExactInput functions; they do not use the mock-AMM reserve formula. Concurrent v4 swaps may revert when the 1% minimum output is no longer available. Automated checks/reset buttons remain exclusive to Anvil.

## Persistence and fresh tests

Files are under `.local/base-sepolia/default`: encrypted vaults, settings, deployment manifest, v4 codehash pin, deployment transaction journal, and curve transaction reports. The launcher runs one server on port 4313 and rejects a second owner of that port. It never stores Phantom keys.

A deployment step's transaction hash and input digest are saved before broadcasting. Resume waits for that exact hash; it never silently signs a replacement. An ambiguous submission that never receives a receipt needs investigation or a new profile. Changed deployment inputs also require a fresh profile. A signed-but-never-broadcast crash is intentionally not retried automatically.

Sepolia cannot rewind. For a new guard window, stop the services, set a new `SEPOLIA_PROFILE` (letters/digits/hyphens/underscores), and restart. Each profile has fresh contracts. To reuse the original ten wallets and deployment account, also set `SEPOLIA_WALLET_PROFILE=default` on the first start of the new profile and unlock with the original passphrase. The source binding persists in `wallet-profile.json`; vault files remain in the original profile. Without a wallet source, a new profile creates new accounts. Retain old profiles and backups for recovery. The usual default-profile restart preserves the existing test.

## RPC and verification

`BASE_SEPOLIA_RPC_URL` optionally selects a dedicated HTTPS provider for the backend. The website uses the public Base Sepolia RPC, so provider credentials are not injected into browser assets. RPC chain ID is checked before deployment sends; the curve runner uses one dedicated endpoint with no public fallback. Anvil mutation methods are blocked in the Sepolia curve service.

The v4 core address is pinned to `0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408`, listed in the [official Uniswap deployments](https://developers.uniswap.org/docs/protocols/v4/deployments). Its observed runtime codehash is persisted and checked on deployment resume. This is a test profile; production deployment still uses DeployBase.s.sol and its independently configured verification inputs.

Run `npm run sepolia:curve:rehearse` to deploy and trade on an isolated Anvil fork at port 18548, chain ID 84532. Only the local fork receives signed transactions. The public Sepolia endpoint supplies fork data. Use the Foundry runtime installed in the bitcoin-fun checkout at `.tools/foundry` (or `~/.foundry/bin`); the setup launcher compiles current artifacts before serving. Both launchers compile artifacts from the bitcoin-fun checkout. Set `BTC69K_PROJECT_ROOT` if it is not the sibling directory.

If Chrome blocks the local page, review that browser block yourself. Friday cannot bypass it or confirm Phantom transfers. No public deployment is complete until the wallet has been funded and the deployment receipts confirm.

## ETH, WETH and Test USDC payments

See [BTC69K payment routing](../bitcoin-fun/PAYMENT_ROUTING.md) for the fresh-profile setup, seeded Uniswap v3 pools, payment selector, atomic purchase router, and mixed-payment ten-wallet rehearsal. An already opened curve cannot add a router.

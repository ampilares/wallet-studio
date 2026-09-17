# BTC69K Launchpad + ten-wallet curve testing

This isolated profile runs the real BTC69K website Launchpad and the Wallet Studio curve controls against one Anvil deployment. It uses disposable test funds and a separate encrypted ten-wallet vault. Existing `.env.local`, CLI wallets, Studio vaults and the normal local stack are preserved.

From the wallet-studio repository root, after installing dependencies in both wallet-studio and bitcoin-fun and installing Foundry in bitcoin-fun:

```powershell
npm run local:curve:up
```

Keep that terminal running. Open the **Wallet Studio link printed in the terminal**, which includes the temporary session token, and [BTC69K Launchpad](http://127.0.0.1:3001/launchpad). The website also links to the authenticated Studio page.

| Service | Local address |
| --- | --- |
| BTC69K website | `http://127.0.0.1:3001/launchpad` (`/trade` redirects here) |
| Wallet Studio Curve Test | `http://127.0.0.1:4312/curve` — use the printed token link initially |
| Shared Anvil RPC | `http://127.0.0.1:8546`, chain ID `31337` |

**Website workflow:** CONNECT WALLET → LOCAL ANVIL WALLET connects the separate prefunded account `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC`. It has local ETH and mock cbBTC. Enter `0.001` cbBTC, inspect the quote/minimum, and buy; approval and purchase are separate transactions. Sell part of the BTC69K afterward. You can instead import that development-only account into a browser wallet using the standard Anvil test mnemonic documented in [the BTC69K local guide](../bitcoin-fun/LOCAL_DEVELOPMENT.md). Custom browser-wallet addresses require owner-funded mock cbBTC; the faucet is intentionally owner-only.

**Ten-wallet workflow:** the Curve Test screen shows ten wallets, each initially funded with 10 ETH and 1 mock cbBTC. The local deployment enforces **34,500 BTC69K cumulative purchases per wallet for 150 blocks**, starting with the first successful buy. Click **Buy all 10 wallets to cap** to run repeated simultaneous batches (up to a quarter-cap per round). All ten wallets participate regardless of checkbox selection. The runner stops at the closest purchasable amount below the cap: eight-decimal cbBTC cannot always buy the exact remaining token fraction. The table shows guard purchases and remaining allowance; selling does not restore it. The runner approves a bounded 0.01 mock-cbBTC budget per wallet and revokes unused allowances afterward. It does not reset the chain or skip the guard window. After expiry, use **Reset test** for another cap run. Manual batches default to 0.0001 cbBTC per wallet.

Select wallets to sell tokens. At the target, select exactly one wallet and choose Graduate to AMM. The website changes venue automatically. The local AMM is a test implementation, not the deployed production Uniswap v4 pool.

**Prepare test funds** tops fixture wallets and the separate website wallet back up to 10 ETH and 1 mock cbBTC. **Reset test** restores the original deployment snapshot, funds the wallets and opens trading again. Reset also discards the website wallet's local trades and invalidates old reviews; it does not affect another local chain. The disposable fixture stays unlocked while its process runs. Its random passphrase is held only in that process, so restarting creates new wallets instead of recovering an old fixture. Use ordinary Wallet Studio for wallets that need persistent passphrase access.

Run repeatable checks without changing the interactive fixture:

```powershell
npm run local:curve:test
npm test
../bitcoin-fun/.tools/foundry/forge.exe test --root ../bitcoin-fun/contracts --match-contract 'CurveLocalTest|ProtocolTest|BitcoinV4Test|LaunchSequenceTest'
npm --prefix ../bitcoin-fun run typecheck --workspace web
```

The automated runner deploys its own guarded chain on port `18547`. It verifies all ten wallets buying to the cap in simultaneous rounds, over-cap rejections, selling without restoring allowance, and the exact 150-block expiry boundary. It then advances local blocks past the guard to check post-guard buys, review validation, slippage failures, graduation and mock-AMM trades. The UI's **Run automated checks** runs the full suite after resetting the interactive chain; it ends at the AMM. Use **Buy all 10 wallets to cap** to leave the UI at the guarded cap instead. Reports and receipt evidence are saved under the printed `.local/curve-test/<fixture>/runs/<run>` directory. Restart `local:curve:up` to apply the new immutable guard settings to an older deployment.

Stop the interactive stack with Ctrl+C in its terminal or:

```powershell
npm run local:curve:down
```

The launcher refuses occupied ports and shuts down only its own child processes. Reports remain on disk. If a browser blocks the localhost page, review that browser/extension block yourself; the application does not bypass it.


# BTC Genesis Miners — Base mainnet

Use `D:\Shared\GitHub\wallet-studio`, not the old OneDrive copy. This preset is for the [OpenSea collection](https://opensea.io/collection/btc-genesis-miners) and its **public** SeaDrop mint, not an allowlist or signed mint.

## Start

1. Set `STUDIO_BASE_MAINNET_RPC_URL` in the repo's private `.env` to your **Base mainnet** Alchemy HTTPS URL. Do not commit or share that file. The public Base RPC works when this variable is empty but may rate-limit. Studio does not use the CLI's `RPC_URL` or `ALCHEMY_API_KEY` for this connection.
2. For the session in which you intend to mint, run:

   ```powershell
   cd D:\Shared\GitHub\wallet-studio
   $env:MAINNET_SEND_ENABLED = "true"
   npm run studio
   ```

3. Open the complete localhost URL printed by the launcher. Unlock your existing Studio vault. Keep the terminal open. Do not create a different vault or change `STUDIO_DATA_DIR` if you want your existing wallets.
4. Select **Base mainnet**. Select the intended wallets on **Wallets**, then **NFT campaigns → Use BTC Genesis preset**. With no selection, all vault wallets are included: review the displayed count carefully.
5. Review the live settings, fee limits and approval checkbox, then **Save Genesis draft**. Each selected address needs real **ETH on Base (8453)** for gas. You can fund addresses externally, or fund one Studio wallet then use **Wallets → Distribute ETH** to fund the others with a reviewed batch (see below). Local test ETH, Sepolia ETH and Ethereum-mainnet ETH do not fund a Base address balance.
6. Once the public sale is active and the selected wallets are funded, click **Run preflight**. Resolve every blocked/underfunded wallet. A review lasts five minutes. **Start minting** is the separate action that signs and broadcasts real transactions.
7. Watch the per-wallet hashes and token IDs. **Reconcile transactions** reads existing receipts without signing or sending. If a broadcast times out, do not recreate the campaign or clear its data. **Recover / resume recorded run** may rebroadcast only the original signed bytes and may start remaining ready jobs. Stop/pause cannot undo a broadcast.
8. Stop Studio with Ctrl+C and remove the session gate when finished:

   ```powershell
   Remove-Item Env:MAINNET_SEND_ENABLED
   ```

If you also enabled the gate inside `.env`, set it back to `false`. Restart Studio after changing RPC configuration. `BUNDLER_MODE=simulation` is a CLI setting, **not** a dashboard mint safety switch.

## Fund all wallets from one Studio wallet

Choose **Base mainnet → Wallets → Distribute ETH**. Fund the displayed sender address from your external wallet or exchange using **Base ETH**. Select recipients on the Wallets page first, or leave selection empty to fund all other vault wallets. A 200-wallet vault makes **199 separate transfers**; the already-funded sender is excluded. Use **Create wallets** to add the remaining capacity in one operation (for example, add 190 to an initial ten-wallet vault). Existing wallets and addresses are preserved.

Enter the ETH amount per recipient and per-transfer fee allowance, then **Review**. The review lists every full address, amount, total recipient funding and total fee allowance. The sender needs enough ETH for their sum; leave additional ETH for the sender's own NFT mint. The service checks Base chain ID, plain EOA recipients, balances, nonces and Base fees. Reviews expire after five minutes. Your approval checkbox and `MAINNET_SEND_ENABLED=true` are both required for **Confirm / resume funding**. No funds move during review.

The batch runs in the background, waits for two confirmations per transfer, and may take several minutes. Reopen **Distribute ETH** to follow the saved batch. **Stop new transfers** cannot undo broadcasts. After a timeout/restart, **Reconcile receipts**, then **Refresh remaining review** if expired, and resume the **same batch**. Confirmed/reverted transfers are never signed again. Unresolved transfers retain their original hash and encrypted signed bytes; explicit resume may rebroadcast only those identical bytes. Failed/reverted recipients require manual inspection and are not automatically paid again. Do not create a fresh batch to retry already-paid recipients.

Funding history is saved in the private vault directory as `mainnet-funding.json`; encrypted recovery bytes never go to the browser. The funding worker shares the vault lock with NFT minting and transfers. A hard crash can leave the lock described below. Ordinary mainnet **Send ETH** and **Collect ETH** remain disabled. Base's variable L1 fee cannot be absolutely capped, even though a conservative allowance is checked before each signature.

## Pinned configuration

| Setting | Value |
| --- | --- |
| Chain | Base mainnet, 8453 |
| NFT collection | `0xe7503B685EAD99128d5f145d502fc928281C182c` |
| Transaction destination | SeaDrop `0x00005EA00Ac477B1030CE78506496e8C2dE24bf5` |
| Permitted fee recipient | `0x0000a26b00c1F0DF003000390027140000fAa719` |
| Call | `mintPublic(collection, feeRecipient, address(0), 1)` |
| Transaction value | 0 ETH; paying wallet receives the NFT |
| Public opening | 19 September 2026 16:24 UTC / 20 September 02:24 Sydney |
| Public closing | 3 October 2026 16:24 UTC / 4 October 03:24 Sydney |
| Supply / wallet limit | 256 / one minted per wallet |

These settings were read from Base and are checked again at preflight and before each new signature. Changed price, dates, wallet cap, fee settings, fee recipient or supply cap block the pinned preset. Availability is not guaranteed; other minters can consume supply between simulation and inclusion. No approval transaction is required for this free ETH mint.

Default controls are **0.0001 ETH maximum estimated total fee per wallet**, a **0.00001 ETH extra buffer**, and a campaign budget of wallet count × 0.0001 ETH. These are configurable limits, **not** a fee quote or instruction to deposit that exact amount. The service estimates padded execution gas, Base L1 data fees and operator fees, then checks the real wallet balance. Actual fees include the receipt's L1 fee. Base L1 fees can change after submission and cannot be absolutely capped by the signed EIP-1559 transaction.

The preset uses two concurrent wallets and two confirmations. Confirmation verifies collection-address-filtered mint events, exactly one token, and `ownerOf` at the receipt block. Two confirmations are not Ethereum-level finality. Journal identities survive restarts; retries never reset a signed, reverted or successful-but-unverified transaction. Encrypted recovery bytes remain server-side.

After a hard crash, the shared `.studio-operation.lock` may remain in the vault directory. Do not delete it while any Studio process is running. Once the old owner is confirmed stopped, remove only that empty lock directory, restart, and reconcile the recorded campaign. Never delete the campaign journal to unblock a mint.

## Validation

`npm test` covers transaction identity, ambiguous broadcasts, duplicate starts, common vault locking, budgets, receipt verification and recovery. `npm run nft:genesis:fork-test` reads Base into an isolated localhost Anvil fork (chain ID 31337), generates a disposable vault and mints against the actual collection contracts there. It advances **only the fork's** time to the sale opening when needed, verifies ownership and blocks a repeat mint. It never signs or broadcasts a Base-mainnet transaction; local fork gas costs are not a mainnet fee quote. Foundry Anvil is required.

References: [verified collection on BaseScan](https://basescan.org/address/0xe7503b685ead99128d5f145d502fc928281c182c#code), [OpenSea SeaDrop source](https://github.com/ProjectOpenSea/seadrop/blob/main/src/SeaDrop.sol).

# Wallet Studio repository reconciliation

Date: 19 September 2026.

The canonical project is `D:/Shared/GitHub/wallet-studio`, connected to `https://github.com/ampilares/wallet-studio.git`. Its HEAD during reconciliation was `e8bce2da4ee885f16aca430aecb078983a99ac45` (`migrated from bitcoin-fun`). Continue development here.

An initial Codex project pointed to `C:/Users/allen/OneDrive/Documents/ChatGPT/wallet-studio`, an empty repository without a remote. The NFT plan was written there, then the existing implementation was copied into that directory. That duplicate is not the canonical repository.

Comparison found 88 shared source/configuration/documentation files. Only four files had adaptation differences, plus two new planning/provenance documents. Existing uncommitted security and Garlic changes in the GitHub checkout are preserved.

Reconciled changes:

- Added the NFT extension plan, revised around the existing implementation and correct project path.
- Added optional `STUDIO_DATA_DIR` support to the standalone launcher and `.env.example`.
- Kept the existing `data/studio` default to preserve wallet lookup. The OS-data default introduced for the OneDrive copy was deliberately not carried over.
- Added startup output showing the actual vault directory and the existing 100-wallet capacity; corrected stale vault-location text in the UI.
- Updated README instructions and the programmatic import example.

No saved wallets, credentials, transaction history, Git metadata, dependency versions, or deployment profiles were copied or moved. No commits, pushes, or public-chain transactions were performed during reconciliation. Before-images of the four changed files were retained in the duplicate workspace's ignored `.local/reconcile/before` directory.

For the Codex project, select Edit project, add `D:/Shared/GitHub/wallet-studio`, and make it the primary folder. This app setting must be changed separately from the repository files. The old OneDrive copy may be retained as a backup; it should no longer be used for development.

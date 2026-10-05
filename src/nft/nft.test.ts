import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodeAbiParameters, encodeEventTopics, keccak256, parseAbi, type Address, type Hex, type TransactionReceipt } from "viem";
import { anvil } from "viem/chains";
import { StudioService } from "../studio/service.js";
import { classifySimulationError, decodeMintAmounts, decodeMintReceipt, encodeMint, validateCampaignInput } from "./adapter.js";
import type { MintCampaign, MintCampaignInput } from "./types.js";
import { JsonStore } from "../database/JsonStore.js";
import { genesisCalldata, genesisInput, GENESIS, mintTarget } from "./genesis.js";
import { publicCampaign } from "./CampaignService.js";

const wallet = "0x1111111111111111111111111111111111111111" as Address;
const contract = "0x2222222222222222222222222222222222222222" as Address;

function single1155(to: Address, id: bigint, value: bigint) {
  return { address: contract,
    topics: encodeEventTopics({ abi: parseAbi(["event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)"]), eventName: "TransferSingle", args: { operator: contract, from: "0x0000000000000000000000000000000000000000", to } }),
    data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [id, value]) };
}

test("ERC-1155 decoding sums units by ID and ignores zero-value mint events", () => {
  const batch = { address: contract,
    topics: encodeEventTopics({ abi: parseAbi(["event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)"]), eventName: "TransferBatch", args: { operator: contract, from: "0x0000000000000000000000000000000000000000", to: wallet } }),
    data: encodeAbiParameters([{ type: "uint256[]" }, { type: "uint256[]" }], [[42n, 99n], [2n, 4n]]) };
  const receipt = { logs: [single1155(wallet, 42n, 3n), single1155(wallet, 7n, 0n), single1155(contract, 8n, 1n), batch] } as unknown as TransactionReceipt;
  assert.deepEqual([...decodeMintAmounts("ERC1155", wallet, receipt, contract)], [["42", 5n], ["99", 4n]]);
  assert.deepEqual(decodeMintReceipt("ERC1155", wallet, receipt, contract), ["42", "99"]);
});

function input(wallets: Address[] = [wallet]): MintCampaignInput {
  return {
    name: "QA mint", network: "local", contract, standard: "ERC721",
    functionSignature: "function mint(address recipient, uint256 quantity) payable", functionName: "mint",
    arguments: [{ kind: "wallet" }, { kind: "quantity" }], wallets, quantity: 2,
    pricePerTokenWei: "100", feeBufferWei: "10", maxFeePerWalletWei: "1000000",
    spendCeilingWei: "2000000", confirmations: 1, concurrency: 5,
  };
}

test("NFT adapter validates and deterministically encodes reviewed mint calls", () => {
  const campaign = input();
  validateCampaignInput(campaign);
  const data = encodeMint(campaign, wallet);
  assert.match(data, /^0x[a-f0-9]+$/);
  assert.equal(data.length, 8 + 64 + 64 + 2);
  assert.throws(() => validateCampaignInput({ ...campaign, wallets: [wallet, wallet] }), /duplicates/);
  assert.throws(() => validateCampaignInput({ ...campaign, spendCeilingWei: "1.5" }), /integer amount/);
});

test("NFT adapter supports per-wallet allowlist arguments and useful revert classification", () => {
  const proof = `0x${"ab".repeat(32)}`;
  const campaign: MintCampaignInput = { ...input(), functionSignature: "function allowlistMint(address recipient, uint256 quantity, bytes32[] proof) payable", functionName: "allowlistMint", arguments: [{ kind: "wallet" }, { kind: "quantity" }, { kind: "wallet-specific", key: "proof" }], walletArguments: { [wallet.toLowerCase()]: { proof: [proof] } } };
  assert.doesNotThrow(() => encodeMint(campaign, wallet));
  assert.equal(classifySimulationError(new Error("execution reverted: invalid allowlist proof")).status, "ineligible");
  assert.equal(classifySimulationError(new Error("execution reverted: SOLD OUT")).status, "sold-out");
});

test("NFT receipt verification accepts only mint events to the expected wallet", () => {
  const abi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"]);
  const topics = encodeEventTopics({ abi, eventName: "Transfer", args: { from: "0x0000000000000000000000000000000000000000", to: wallet, tokenId: 42n } });
  const receipt = { logs: [{ address: contract, data: "0x", topics }] } as unknown as TransactionReceipt;
  assert.deepEqual(decodeMintReceipt("ERC721", wallet, receipt, contract), ["42"]);
  assert.deepEqual(decodeMintReceipt("ERC721", contract, receipt, contract), []);
  assert.deepEqual(decodeMintReceipt("ERC721", wallet, receipt, wallet), []);
});

test("NFT campaign drafts persist without wallet secrets", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "wallet-studio-nft-"));
  try {
    const studio = new StudioService(directory);
    const passphrase = "NFT test vault passphrase only";
    await studio.setup(passphrase, 10);
    const addresses = (await studio.metadata()).wallets.map(wallet => wallet.address);
    const draft = await studio.nft.create(input(addresses));
    const revision = await studio.nft.update(draft.id, { ...draft.input, name: "QA mint revision" });
    assert.equal(revision.revision, 2);
    assert.equal(revision.previousCampaignId, draft.id);
    const reopened = new StudioService(directory);
    const saved = await reopened.nft.list("local");
    assert.equal(saved[0]?.id, revision.id);
    assert.ok(saved.some(row => row.id === draft.id), "an immutable prior revision is retained");
    const disk = await readFile(path.join(directory, "nft-campaigns.json"), "utf8");
    assert.ok(!disk.includes(passphrase));
    assert.ok(!disk.includes("encryptedPrivateKey"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Genesis preset pins the free one-per-wallet SeaDrop call and rejects changed terms", () => {
  const preset = genesisInput([wallet]);
  validateCampaignInput(preset);
  assert.equal(mintTarget(preset), GENESIS.seaDrop);
  assert.equal(encodeMint(preset, wallet), genesisCalldata());
  for (const change of [{ pricePerTokenWei: "1" }, { quantity: 2 }, { contract }, { network: "sepolia" as const }, { confirmations: 1 }]) {
    assert.throws(() => validateCampaignInput({ ...preset, ...change }));
  }
  assert.throws(() => validateCampaignInput({ ...preset, arguments: [{ kind: "literal", value: contract }, ...preset.arguments.slice(1)] }));
});

test("Genesis accepts the verified revised schedule and still blocks changed settings", async () => {
  assert.equal(GENESIS.startTime, 1789835040);
  assert.equal(GENESIS.endTime, 1791044640);
  const expectedDrop = { mintPrice: 0n, startTime: GENESIS.startTime, endTime: GENESIS.endTime, maxTotalMintableByWallet: 1, feeBps: 1000, restrictFeeRecipients: true };
  let drop: Omit<typeof expectedDrop, "startTime" | "endTime"> & { startTime: number; endTime: number } = { ...expectedDrop };
  let recipients: Address[] = [GENESIS.feeRecipient];
  let maxSupply = 256n;
  const studio = new StudioService(path.join(tmpdir(), "genesis-readonly-schedule-test"));
  studio.chainConnection = (async () => ({ client: {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "getPublicDrop") return drop;
      if (functionName === "getAllowedFeeRecipients") return recipients;
      if (functionName === "getMintStats") return [0n, 10n, maxSupply];
      throw new Error("Unexpected read");
    },
    getBlock: async () => ({ timestamp: BigInt(GENESIS.startTime + 1) }),
  } })) as unknown as StudioService["chainConnection"];
  const status = await studio.nft.genesisStatus();
  assert.equal(status.matches, true);
  assert.equal(status.active, true);
  for (const change of [
    { startTime: 1789833600 }, { endTime: 1791043200 },
    { startTime: GENESIS.startTime + 1 }, { endTime: GENESIS.endTime + 1 },
    { mintPrice: 1n }, { maxTotalMintableByWallet: 2 },
    { feeBps: 1001 }, { restrictFeeRecipients: false },
  ]) {
    drop = { ...expectedDrop, ...change };
    assert.equal((await studio.nft.genesisStatus()).matches, false);
  }
  drop = { ...expectedDrop };
  recipients = [contract];
  assert.equal((await studio.nft.genesisStatus()).matches, false);
  recipients = [GENESIS.feeRecipient];
  maxSupply = 257n;
  assert.equal((await studio.nft.genesisStatus()).matches, false);
});

test("RPC error classification does not expose provider keys or signed data", () => {
  const classified = classifySimulationError(new Error("RPC https://base-mainnet.g.alchemy.com/v2/SECRET_KEY execution reverted: proof 0xSIGNATURE"));
  assert.equal(classified.status, "ineligible");
  assert.ok(!classified.reason.includes("SECRET"));
  assert.ok(!classified.reason.includes("SIGNATURE"));
});

test("NFT campaigns accept 200 wallets but reject 201 without raising the Genesis per-wallet mint limit", () => {
  const wallets = Array.from({ length: 201 }, (_, index) => `0x${(index + 1).toString(16).padStart(40, "0")}` as Address);
  assert.doesNotThrow(() => validateCampaignInput(genesisInput(wallets.slice(0, 200))));
  assert.throws(() => validateCampaignInput(genesisInput(wallets)), /200 wallets/);
  assert.throws(() => validateCampaignInput({ ...genesisInput(wallets.slice(0, 200)), quantity: 2 }), /exactly one/);
});

async function executionFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "wallet-studio-nft-exec-"));
  const studio = new StudioService(directory);
  await studio.setup("NFT execution fixture password", 1);
  const address = (await studio.metadata()).wallets[0].address;
  const state = { sends: 0, throwAfterSend: false, receiptAvailable: true, wrongCollection: false, wrongOwner: false, pendingNonce: 0, head: 12n, blockHash: `0x${"11".repeat(32)}` as Hex, hash: `0x${"00".repeat(32)}` as Hex, beforeEstimate: undefined as (() => Promise<void>) | undefined, erc1155: false, mintedQuantity: 3n, tokenBalance: 3n };
  const receipt = (): TransactionReceipt => ({
    transactionHash: state.hash, blockHash: state.blockHash, blockNumber: 10n, status: "success", gasUsed: 100n, effectiveGasPrice: 2n,
    logs: state.erc1155 ? [single1155(address, 42n, state.mintedQuantity)] : [{ address: state.wrongCollection ? address : contract, data: "0x", topics: encodeEventTopics({ abi: parseAbi(["event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"]), eventName: "Transfer", args: { from: "0x0000000000000000000000000000000000000000", to: address, tokenId: 42n } }) }],
  } as unknown as TransactionReceipt);
  const client = {
    getCode: async () => "0x6000", getBalance: async () => 100000000n,
    estimateGas: async () => { await state.beforeEstimate?.(); return 100n; },
    estimateFeesPerGas: async () => ({ maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }),
    getTransactionCount: async ({ blockTag }: { blockTag: string }) => blockTag === "pending" ? state.pendingNonce : 0,
    sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => { state.sends++; state.hash = keccak256(serializedTransaction); if (state.throwAfterSend) throw new Error("RPC secret URL timeout after accept"); return state.hash; },
    waitForTransactionReceipt: async () => { if (!state.receiptAvailable) throw new Error("timeout"); return receipt(); },
    getTransactionReceipt: async () => { if (!state.receiptAvailable) throw new Error("not found"); return receipt(); },
    getBlockNumber: async () => state.head, getBlock: async () => ({ hash: state.blockHash }),
    readContract: async () => state.erc1155 ? state.tokenBalance : state.wrongOwner ? contract : address,
  };
  studio.chainConnection = async () => ({ chain: anvil, client, transport: undefined }) as unknown as Awaited<ReturnType<StudioService["chainConnection"]>>;
  const draft = await studio.nft.create({ ...input([address]), quantity: 1, confirmations: 2 });
  const waitIdle = async () => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const result = await studio.nft.get(draft.id);
      if (result.status !== "running") {
        // Wait for the worker's finally block to release the shared operation lock.
        try { await studio.exclusiveOperation(async () => undefined); return result; } catch { /* Still draining. */ }
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("Fixture worker did not finish");
  };
  return { studio, draft, state, directory, waitIdle, async cleanup() { studio.lock(); assert.equal(path.dirname(directory), path.resolve(tmpdir())); assert.ok(path.basename(directory).startsWith("wallet-studio-nft-exec-")); await rm(directory, { recursive: true, force: true }); } };
}

test("NFT execution signs once, verifies ownership, and settles costs idempotently", async () => {
  const f = await executionFixture();
  try {
    assert.equal((await f.studio.nft.preflight(f.draft.id)).status, "reviewed");
    const starts = await Promise.allSettled([f.studio.nft.start(f.draft.id), f.studio.nft.start(f.draft.id)]);
    assert.equal(starts.filter(result => result.status === "fulfilled").length, 1);
    const completed = await f.waitIdle();
    assert.equal(completed.status, "completed");
    assert.equal(f.state.sends, 1);
    assert.equal(completed.spentWei, "300");
    assert.equal(completed.reservedWei, "0");
    assert.equal(completed.jobs[0].attempts.length, 1);
    assert.deepEqual(completed.jobs[0].tokenIds, ["42"]);
    await f.studio.nft.reconcile(completed.id);
    await f.studio.nft.preflight(completed.id);
    assert.equal((await f.studio.nft.get(completed.id)).spentWei, "300");
    assert.equal(f.state.sends, 1);
    const json = JSON.stringify(publicCampaign(completed));
    assert.ok(!json.includes("encryptedSignedTransaction"));
    assert.ok(!json.includes(completed.jobs[0].attempts[0].encryptedSignedTransaction));
    const another = await f.studio.nft.create(f.draft.input);
    assert.equal((await f.studio.nft.preflight(another.id)).jobs[0].status, "contract-error");
  } finally { await f.cleanup(); }
});

test("ambiguous broadcast preserves identity and reservation through restart, then reconciles without resending", async () => {
  const f = await executionFixture();
  try {
    await f.studio.nft.preflight(f.draft.id);
    f.state.throwAfterSend = true;
    f.state.receiptAvailable = false;
    await f.studio.nft.start(f.draft.id);
    const unresolved = await f.waitIdle();
    assert.equal(unresolved.jobs[0].status, "unresolved");
    assert.ok(BigInt(unresolved.reservedWei) > 0n);
    assert.equal(unresolved.jobs[0].attempts.length, 1);
    await assert.rejects(f.studio.nft.retry(f.draft.id), /Reconcile/);
    await assert.rejects(f.studio.nft.update(f.draft.id, f.draft.input), /immutable/);
    const reopened = new StudioService(f.directory);
    reopened.chainConnection = f.studio.chainConnection;
    assert.equal((await reopened.nft.list())[0].jobs[0].txHash, unresolved.jobs[0].txHash);
    f.state.receiptAvailable = true;
    await reopened.nft.reconcile(f.draft.id);
    const reconciled = await reopened.nft.get(f.draft.id);
    assert.equal(reconciled.jobs[0].status, "confirmed");
    assert.equal(reconciled.reservedWei, "0");
    assert.equal(f.state.sends, 1);
    assert.equal(reconciled.jobs[0].attempts.length, 1);
  } finally { await f.cleanup(); }
});

test("receipt from another collection never confirms and retry does not erase its successful transaction", async () => {
  const f = await executionFixture();
  try {
    await f.studio.nft.preflight(f.draft.id);
    f.state.wrongCollection = true;
    await f.studio.nft.start(f.draft.id);
    const blocked = await f.waitIdle();
    assert.equal(blocked.jobs[0].status, "blocked");
    assert.equal(blocked.spentWei, "300");
    const checked = await f.studio.nft.retry(f.draft.id);
    assert.equal(checked.jobs[0].txHash, blocked.jobs[0].txHash);
    assert.equal(checked.jobs[0].status, "blocked");
    await assert.rejects(f.studio.nft.start(f.draft.id));
    assert.equal(f.state.sends, 1);
  } finally { await f.cleanup(); }
});

test("confirmation depth and pending nonces fail closed", async () => {
  const f = await executionFixture();
  try {
    f.state.pendingNonce = 1;
    assert.notEqual((await f.studio.nft.preflight(f.draft.id)).jobs[0].status, "ready");
    f.state.pendingNonce = 0;
    await f.studio.nft.preflight(f.draft.id);
    f.state.head = 10n;
    await f.studio.nft.start(f.draft.id);
    const pending = await f.waitIdle();
    assert.equal(pending.jobs[0].status, "unresolved");
    assert.ok(BigInt(pending.reservedWei) > 0n);
    f.state.head = 11n;
    assert.equal((await f.studio.nft.reconcile(f.draft.id)).jobs[0].status, "confirmed");
  } finally { await f.cleanup(); }
});

test("stop during requote prevents signing, and active workers hold the common vault lock", async () => {
  const f = await executionFixture();
  try {
    await f.studio.nft.preflight(f.draft.id);
    f.state.beforeEstimate = async () => {
      await assert.rejects(f.studio.exclusiveOperation(async () => undefined), /operation/);
      await assert.rejects(f.studio.nft.preflight(f.draft.id), /operation/);
      await f.studio.nft.control(f.draft.id, "stop");
    };
    await f.studio.nft.start(f.draft.id);
    const stopped = await f.waitIdle();
    assert.equal(stopped.status, "stopped");
    assert.equal(f.state.sends, 0);
    assert.equal(stopped.reservedWei, "0");
    assert.equal(stopped.jobs[0].attempts.length, 0);
  } finally { await f.cleanup(); }
});

test("mainnet requires both gates even when a matching reviewed campaign is persisted", async () => {
  const f = await executionFixture();
  const previousGate = process.env.MAINNET_SEND_ENABLED;
  try {
    await f.studio.nft.preflight(f.draft.id);
    const store = new JsonStore<MintCampaign[]>(path.join(f.directory, "nft-campaigns.json"), []);
    const setApproval = async (approved: boolean) => store.update(rows => rows.map(row => {
      const input: MintCampaignInput = { ...row.input, network: "mainnet", mainnetApproved: approved };
      return { ...row, input, fingerprint: createHash("sha256").update(JSON.stringify(input)).digest("hex") };
    }));
    await setApproval(true);
    process.env.MAINNET_SEND_ENABLED = "false";
    await assert.rejects(f.studio.nft.start(f.draft.id), /Mainnet requires/);
    await setApproval(false);
    process.env.MAINNET_SEND_ENABLED = "true";
    await assert.rejects(f.studio.nft.start(f.draft.id), /Mainnet requires/);
    assert.equal(f.state.sends, 0);
  } finally { if (previousGate === undefined) delete process.env.MAINNET_SEND_ENABLED; else process.env.MAINNET_SEND_ENABLED = previousGate; await f.cleanup(); }
});

test("expired review cannot start and a wrong owner is never confirmed", async () => {
  const f = await executionFixture();
  try {
    await f.studio.nft.preflight(f.draft.id);
    const store = new JsonStore<MintCampaign[]>(path.join(f.directory, "nft-campaigns.json"), []);
    await store.update(rows => rows.map(row => ({ ...row, reviewedAt: new Date(Date.now() - 360_000).toISOString() })));
    await assert.rejects(f.studio.nft.start(f.draft.id), /Review expired/);
    assert.equal(f.state.sends, 0);
    await f.studio.nft.preflight(f.draft.id);
    f.state.wrongOwner = true;
    await f.studio.nft.start(f.draft.id);
    assert.equal((await f.waitIdle()).jobs[0].status, "blocked");
  } finally { await f.cleanup(); }
});

test("ERC-1155 settlement requires the reviewed quantity and recipient balance", async () => {
  for (const [quantity, minted, balance, expected] of [[3, 3n, 3n, "confirmed"], [1, 0n, 0n, "blocked"], [3, 3n, 2n, "blocked"]] as const) {
    const f = await executionFixture();
    try {
      f.state.erc1155 = true; f.state.mintedQuantity = minted; f.state.tokenBalance = balance;
      await new JsonStore<MintCampaign[]>(path.join(f.directory, "nft-campaigns.json"), []).update(rows => rows.map(row => ({ ...row, input: { ...row.input, standard: "ERC1155", quantity } })));
      await f.studio.nft.preflight(f.draft.id);
      await f.studio.nft.start(f.draft.id);
      assert.equal((await f.waitIdle()).jobs[0].status, expected);
      assert.equal(f.state.sends, 1);
    } finally { await f.cleanup(); }
  }
});

test("locking the vault during NFT requote prevents further signing", async () => {
  const f = await executionFixture();
  try {
    await f.studio.nft.preflight(f.draft.id);
    f.state.beforeEstimate = async () => { f.studio.lock(); };
    await f.studio.nft.start(f.draft.id);
    const stopped = await f.waitIdle();
    assert.equal(f.state.sends, 0);
    assert.equal(stopped.jobs[0].attempts.length, 0);
    assert.equal(stopped.reservedWei, "0");
  } finally { await f.cleanup(); }
});

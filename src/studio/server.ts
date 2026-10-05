import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { StudioService, StudioError } from "./service.js";
import { isRateLimitError } from "./errors.js";
import type { CurveService } from "../curve/service.js";
import type { MintCampaignInput } from "../nft/types.js";
import { publicCampaign } from "../nft/CampaignService.js";
import { MAX_STUDIO_WALLETS } from "./limits.js";

const network = z.enum(["local", "sepolia", "mainnet"]);
const transfer = z.object({ network, kind: z.enum(["send", "distribute", "collect"]), from: z.string().max(42), to: z.string().max(42), wallets: z.array(z.string().max(42)).max(MAX_STUDIO_WALLETS), amount: z.string().max(40) }).strict();
const wei = z.string().regex(/^\d+$/).max(80);
const mintArgument = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("wallet") }).strict(),
  z.object({ kind: z.literal("quantity") }).strict(),
  z.object({ kind: z.literal("literal"), value: z.unknown() }).strict(),
  z.object({ kind: z.literal("wallet-specific"), key: z.string().min(1).max(80) }).strict(),
]);
const mintCampaign = z.object({
  adapter: z.literal("btc-genesis-seadrop").optional(),
  name: z.string().min(1).max(80), network, contract: z.string().length(42),
  standard: z.enum(["ERC721", "ERC1155"]), functionSignature: z.string().min(1).max(1_000),
  functionName: z.string().regex(/^[A-Za-z_$][\w$]*$/).max(100), arguments: z.array(mintArgument).max(20),
  walletArguments: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  wallets: z.array(z.string().length(42)).min(1).max(MAX_STUDIO_WALLETS), quantity: z.number().int().min(1).max(100),
  pricePerTokenWei: wei, feeBufferWei: wei, maxFeePerWalletWei: wei, spendCeilingWei: wei,
  confirmations: z.number().int().min(1).max(64), concurrency: z.number().int().min(1).max(10),
  mainnetApproved: z.boolean().optional(),
}).strict();
const matches = (a: string, b: string) => /^[a-f0-9]{64}$/.test(a) && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createStudioServer(service: StudioService, publicDir: string, port: number, launchToken = randomBytes(32).toString("hex"), curve?: Pick<CurveService, "state" | "preview" | "start" | "busy">, extra?: (route: string, input: unknown) => Promise<unknown>) {
  const session = randomBytes(32).toString("hex");
  const origin = `http://127.0.0.1:${port}`;
  let unlockFailures = 0;
  let unlockBlockedUntil = 0;
  function json(response: ServerResponse, value: unknown, status = 200) {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(value));
  }
  function unlockBlocked(response: ServerResponse) {
    if (Date.now() >= unlockBlockedUntil) return false;
    json(response, { error: "Wait 30 seconds before trying another passphrase." }, 429);
    return true;
  }
  async function attemptUnlock<T>(work: () => Promise<T>) {
    try { const result = await work(); unlockFailures = 0; return result; }
    catch (error) {
      if (++unlockFailures >= 5) { unlockBlockedUntil = Date.now() + 30_000; unlockFailures = 0; }
      throw error;
    }
  }
  async function body(request: IncomingMessage) {
    if (!request.headers["content-type"]?.startsWith("application/json")) throw new StudioError("Use JSON requests.");
    const buffers: Buffer[] = [];
    let length = 0;
    for await (const chunk of request) {
      length += chunk.length;
      if (length > 524_288) throw new StudioError("Request is too large.");
      buffers.push(Buffer.from(chunk));
    }
    try { return JSON.parse(Buffer.concat(buffers).toString("utf8")) as unknown; }
    catch { throw new StudioError("Invalid request."); }
  }
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (request.headers.host !== `127.0.0.1:${port}` || (request.headers.origin && request.headers.origin !== origin) || request.headers["sec-fetch-site"] === "cross-site") {
      json(response, { error: "Only the local dashboard may access this server." }, 403); return;
    }
    try {
      const target = request.url ?? "/";
      if (!target.startsWith("/") || target.startsWith("//")) throw new StudioError("Invalid request target.");
      const url = new URL(target, origin);
      if (!url.pathname.startsWith("/api/")) {
        if (request.method !== "GET") { json(response, { error: "Method not allowed" }, 405); return; }
        if (curve && url.pathname === "/") { response.writeHead(302, { Location: "/curve" }); response.end(); return; }
        const files: Record<string, [string, string]> = { "/": ["index.html", "text/html"], "/app.js": ["app.js", "text/javascript"], "/app.css": ["app.css", "text/css"], "/favicon.svg": ["favicon.svg", "image/svg+xml"] };
        const asset = files[url.pathname === "/curve" && curve ? "/" : url.pathname];
        if (!asset) { json(response, { error: "Not found" }, 404); return; }
        const content = await readFile(path.join(publicDir, asset[0]));
        response.writeHead(200, { "Content-Type": asset[1] }); response.end(content); return;
      }
      if (request.headers["x-studio-request"] !== "1" || (request.method !== "GET" && request.headers.origin !== origin)) {
        json(response, { error: "Invalid local request." }, 403); return;
      }
      if (url.pathname === "/api/session" && request.method === "POST") {
        const input = z.object({ token: z.string().max(128) }).strict().parse(await body(request));
        if (!matches(input.token, launchToken)) { json(response, { error: "Open the dashboard using the link printed by npm run studio." }, 401); return; }
        response.setHeader("Set-Cookie", `studio_${port}=${session}; HttpOnly; SameSite=Strict; Path=/`);
        json(response, { ok: true }); return;
      }
      const cookie = request.headers.cookie?.split(";").map(v => v.trim()).find(v => v.startsWith(`studio_${port}=`))?.split("=")[1] ?? "";
      if (!matches(cookie, session)) { json(response, { error: "Open the dashboard using the link printed by npm run studio." }, 401); return; }
      if (extra && url.pathname.startsWith("/api/sepolia/")) {
        if (!["GET", "POST"].includes(request.method ?? "")) throw new StudioError("Method not allowed");
        if (url.pathname === "/api/sepolia/setup") {
          if (request.method !== "POST") throw new StudioError("Use POST to unlock the Sepolia vault.");
          if (unlockBlocked(response)) return;
          const input = await body(request);
          json(response, await attemptUnlock(() => extra(url.pathname, input))); return;
        }
        json(response, await extra(url.pathname, request.method === "POST" ? await body(request) : undefined)); return;
      }
      if (curve && url.pathname.startsWith("/api/curve/")) {
        if (request.method === "GET" && url.pathname === "/api/curve/state") { json(response, await curve.state()); return; }
        if (request.method === "POST") {
          const input = await body(request);
          if (url.pathname === "/api/curve/preview") {
            if (curve.busy) throw new StudioError("Wait for the current operation to finish.");
            const parsed = z.object({ payment:z.enum(["cbBTC","ETH","WETH","USDC"]).optional(), operation: z.enum(["buy", "sell", "graduate"]), amount: z.string().max(30), wallets: z.array(z.string().length(42)).min(1).max(10), tight: z.boolean() }).strict().parse(input);
            json(response, await curve.preview(parsed)); return;
          }
          if (url.pathname === "/api/curve/run") {
            const parsed = z.object({ action: z.enum(["prepare", "reset", "execute", "test", "cap", "stop"]), id: z.string().uuid().optional() }).strict().parse(input);
            if (parsed.action === "execute" && !parsed.id) throw new StudioError("Review the trade first.");
            json(response, curve.start(parsed.action, parsed.id)); return;
          }
        }
        json(response, { error: "Not found" }, 404); return;
      }
      if (url.pathname.startsWith("/api/nft/")) {
        if (curve || extra) throw new StudioError("Use the standalone Wallet Studio NFT controls, not an isolated rehearsal vault.");
        if (request.method === "GET" && url.pathname === "/api/nft/genesis") {
          try { json(response, await service.nft.genesisStatus()); }
          catch { throw new StudioError("Cannot read the Genesis drop on Base. Check STUDIO_BASE_MAINNET_RPC_URL and try again."); }
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/nft/campaigns") {
          const selectedNetwork = url.searchParams.get("network");
          json(response, (await service.nft.list(selectedNetwork ? network.parse(selectedNetwork) : undefined)).map(publicCampaign)); return;
        }
        if (request.method !== "POST") { json(response, { error: "Not found" }, 404); return; }
        const input = await body(request);
        const nftJson = async (result: ReturnType<typeof service.nft.get>) => json(response, publicCampaign(await result));
        if (url.pathname === "/api/nft/campaigns") { await nftJson(service.nft.create(mintCampaign.parse(input) as MintCampaignInput)); return; }
        if (url.pathname === "/api/nft/update") {
          const parsed = z.object({ id: z.string().uuid(), campaign: mintCampaign }).strict().parse(input);
          await nftJson(service.nft.update(parsed.id, parsed.campaign as MintCampaignInput)); return;
        }
        const parsed = z.object({ id: z.string().uuid() }).strict().parse(input);
        if (url.pathname === "/api/nft/preflight") { await nftJson(service.nft.preflight(parsed.id)); return; }
        if (url.pathname === "/api/nft/start") { await nftJson(service.nft.start(parsed.id)); return; }
        if (url.pathname === "/api/nft/retry") { await nftJson(service.nft.retry(parsed.id)); return; }
        if (url.pathname === "/api/nft/reconcile") { await nftJson(service.nft.reconcile(parsed.id)); return; }
        if (url.pathname === "/api/nft/pause") { await nftJson(service.nft.control(parsed.id, "pause")); return; }
        if (url.pathname === "/api/nft/resume") { await nftJson(service.nft.control(parsed.id, "resume")); return; }
        if (url.pathname === "/api/nft/stop") { await nftJson(service.nft.control(parsed.id, "stop")); return; }
        json(response, { error: "Not found" }, 404); return;
      }
      if (url.pathname.startsWith("/api/funding/")) {
        if (curve || extra) throw new StudioError("Use standalone Wallet Studio for mainnet funding.");
        if (request.method === "GET" && url.pathname === "/api/funding/batches") { json(response, await service.funding.list()); return; }
        if (request.method !== "POST") { json(response, { error: "Not found" }, 404); return; }
        const input = await body(request);
        if (url.pathname === "/api/funding/preview") {
          const parsed = z.object({ from: z.string().length(42), wallets: z.array(z.string().length(42)).min(1).max(MAX_STUDIO_WALLETS), amount: z.string().max(40), maxFeePerTransfer: z.string().max(40) }).strict().parse(input);
          json(response, await service.funding.preview(parsed)); return;
        }
        if (url.pathname === "/api/funding/start") {
          const parsed = z.object({ id: z.string().uuid(), mainnetApproved: z.literal(true) }).strict().parse(input);
          json(response, await service.funding.start(parsed.id, parsed.mainnetApproved)); return;
        }
        const { id } = z.object({ id: z.string().uuid() }).strict().parse(input);
        if (url.pathname === "/api/funding/review") { json(response, await service.funding.review(id)); return; }
        if (url.pathname === "/api/funding/reconcile") { json(response, await service.funding.reconcile(id)); return; }
        if (url.pathname === "/api/funding/stop") { json(response, await service.funding.stop(id)); return; }
        json(response, { error: "Not found" }, 404); return;
      }
      if (curve) throw new StudioError("Use the isolated Curve Test controls for this vault.");
      if (request.method === "GET" && url.pathname === "/api/state") {
        json(response, await service.state(network.parse(url.searchParams.get("network") ?? "local"))); return;
      }
      if (request.method === "GET" && url.pathname === "/api/backup") {
        response.setHeader("Content-Disposition", 'attachment; filename="wallet-studio-encrypted-backup.json"');
        json(response, await service.backup()); return;
      }
      if (request.method !== "POST") { json(response, { error: "Not found" }, 404); return; }
      const input = await body(request);
      switch (url.pathname) {
        case "/api/setup": {
          const parsed = z.object({ passphrase: z.string().min(16).max(512) }).strict().parse(input);
          await service.setup(parsed.passphrase); break;
        }
        case "/api/unlock": {
          if (unlockBlocked(response)) return;
          const parsed = z.object({ passphrase: z.string().max(512) }).strict().parse(input);
          await attemptUnlock(() => service.unlock(parsed.passphrase));
          break;
        }
        case "/api/lock": service.lock(); break;
        case "/api/wallets": {
          const parsed = z.object({ count: z.number().int().min(1).max(MAX_STUDIO_WALLETS) }).strict().parse(input);
          await service.addWallets(parsed.count); break;
        }
        case "/api/rename": {
          const parsed = z.object({ address: z.string().length(42), label: z.string().max(40) }).strict().parse(input);
          await service.rename(parsed.address, parsed.label); break;
        }
        case "/api/test-funds": {
          const parsed = z.object({ network: z.literal("local"), wallets: z.array(z.string().length(42)).min(1).max(MAX_STUDIO_WALLETS) }).strict().parse(input);
          await service.fundLocal(parsed.wallets); break;
        }
        case "/api/preview": json(response, await service.preview(transfer.parse(input))); return;
        case "/api/execute": {
          const parsed = z.object({ id: z.string().uuid() }).strict().parse(input);
          json(response, await service.execute(parsed.id)); return;
        }
        default: json(response, { error: "Not found" }, 404); return;
      }
      json(response, { ok: true });
    } catch (error) {
      // Never return raw RPC/crypto errors, request payloads, or stack traces.
      json(response, { error: error instanceof StudioError ? error.message : error instanceof z.ZodError ? "Check the entered values and try again." : isRateLimitError(error) ? "The RPC provider is rate-limiting requests. Wait a few seconds, then try again. A dedicated RPC for the selected Base network can avoid repeated limits." : "The operation could not complete. Refresh and check your network connection." }, 400);
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return { server, launchUrl: `${origin}/#token=${launchToken}` };
}

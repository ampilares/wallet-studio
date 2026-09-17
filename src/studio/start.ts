import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StudioService } from "./service.js";
import { createStudioServer } from "./server.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const dataDir = path.join(root, "data", "studio");
const port = 4310;
const rpcUrl = "http://127.0.0.1:18545";
let node: ChildProcess | undefined;

async function nodeReady(): Promise<boolean> {
  try {
    const response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), signal: AbortSignal.timeout(500) });
    const json = await response.json() as { result?: string };
    return Number(json.result) === 31337;
  } catch { return false; }
}

async function main() {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    const identity = execFileSync("whoami.exe", [], { encoding: "utf8", windowsHide: true }).trim();
    execFileSync("icacls.exe", [dataDir, "/inheritance:r", "/grant:r", `${identity}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"], { windowsHide: true, stdio: "pipe" });
  }
  if (!await nodeReady()) {
    const foundry = path.join(homedir(), ".foundry", "bin", process.platform === "win32" ? "anvil.exe" : "anvil");
    node = spawn(existsSync(foundry) ? foundry : "anvil", ["--host", "127.0.0.1", "--port", "18545", "--chain-id", "31337", "--accounts", "0", "--state", path.join(dataDir, "anvil-state.json"), "--state-interval", "5", "--silent"], { windowsHide: true, stdio: "ignore" });
    let failed = false;
    node.once("error", () => { failed = true; });
    node.once("exit", () => { failed = true; });
    for (let attempt = 0; attempt < 30 && !await nodeReady() && !failed; attempt++) await new Promise(resolve => setTimeout(resolve, 250));
    if (!await nodeReady()) console.log("Local node unavailable. Install Foundry/Anvil, or select Base Sepolia in the dashboard.");
  }
  const service = new StudioService(dataDir, rpcUrl);
  const { server, launchUrl } = createStudioServer(service, path.join(root, "dist", "studio", "public"), port);
  server.on("error", () => { console.error("Wallet Studio could not start. Port 4310 may already be in use."); node?.kill(); process.exitCode = 1; });
  server.listen(port, "127.0.0.1", () => console.log(`\nWallet Studio is running locally.\nOpen: ${launchUrl}\n\nCreate your vault in the browser to generate 10 encrypted wallets.\n`));
  const stop = () => { service.lock(); server.close(); node?.kill("SIGTERM"); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
main().catch(() => { console.error("Wallet Studio could not initialize its private data directory."); node?.kill(); process.exitCode = 1; });

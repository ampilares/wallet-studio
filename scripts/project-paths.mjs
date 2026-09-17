import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const studioRoot = fileURLToPath(new URL("../", import.meta.url));
export const bitcoinRoot = path.resolve(process.env.BTC69K_PROJECT_ROOT || path.join(studioRoot, "..", "bitcoin-fun"));
if (!existsSync(path.join(bitcoinRoot, "contracts", "script", "DeployLocal.s.sol"))) {
  throw new Error("BTC69K checkout not found. Keep bitcoin-fun next to wallet-studio, or set BTC69K_PROJECT_ROOT to its absolute path.");
}
export function foundryBinary(name) {
  const filename = process.platform === "win32" ? name + ".exe" : name;
  const candidates = [path.join(bitcoinRoot, ".tools", "foundry", filename), path.join(homedir(), ".foundry", "bin", filename)];
  const found = candidates.find(existsSync);
  if (!found) throw new Error("Foundry " + name + " is missing. Run npm run local:install-foundry from the bitcoin-fun checkout first.");
  return found;
}

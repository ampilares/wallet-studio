// Keep tests away from operational .env files, vaults and directory ACLs.
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
async function testFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await testFiles(file));
    else if (entry.name.endsWith(".test.ts")) {
      files.push(path.join(root, "dist", path.relative(path.join(root, "src"), file).replace(/\.ts$/, ".js")));
    }
  }
  return files.sort();
}

const directory = await mkdtemp(path.join(tmpdir(), "wallet-studio-suite-"));
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|HOMEDRIVE|HOMEPATH|HOME|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\))$/i.test(key)));
environment.DOTENV_CONFIG_PATH = path.join(directory, "absent.env");
try {
  const files = await testFiles(path.join(root, "src"));
  if (!files.length) throw new Error("No test sources found");
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--test", ...files], {
      cwd: directory, env: environment, windowsHide: true, stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", code => resolve(code ?? 1));
  });
} finally {
  if (path.dirname(path.resolve(directory)) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith("wallet-studio-suite-")) throw new Error("Unexpected test directory");
  await rm(directory, { recursive: true, force: true });
}

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const windowsAclScript = `
$ErrorActionPreference = 'Stop'
$target = $env:WALLET_STUDIO_ACL_TARGET
$directory = $env:WALLET_STUDIO_ACL_DIRECTORY -eq 'true'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$allowed = @($identity, 'S-1-5-18', 'S-1-5-32-544')
& icacls.exe $target /inheritance:r | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Unable to disable ACL inheritance' }
$acl = if ($directory) { [IO.Directory]::GetAccessControl($target) } else { [IO.File]::GetAccessControl($target) }
foreach ($entry in $acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier])) {
  $sid = $entry.IdentityReference.Value
  if ($allowed -notcontains $sid) {
    & icacls.exe $target /remove "*$sid" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Unable to remove an existing ACL principal' }
  }
}
$inheritance = if ($directory) { '(OI)(CI)F' } else { 'F' }
& icacls.exe $target /grant:r "*$($identity):$inheritance" "*S-1-5-18:$inheritance" "*S-1-5-32-544:$inheritance" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Unable to apply the restricted ACL' }
`;

function restrict(target, directory) {
  if (!existsSync(target)) return;
  if (process.platform !== "win32") {
    chmodSync(target, directory ? 0o700 : 0o600);
    return;
  }
  const encoded = Buffer.from(windowsAclScript, "utf16le").toString("base64");
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    windowsHide: true, stdio: "pipe",
    env: { ...process.env, WALLET_STUDIO_ACL_TARGET: target, WALLET_STUDIO_ACL_DIRECTORY: String(directory) },
  });
}

export function hardenSensitiveFiles(root, dataDir) {
  const resolved = path.resolve(root, dataDir);
  mkdirSync(resolved, { recursive: true, mode: 0o700 });
  restrict(resolved, true);
  restrict(path.join(root, ".env"), false);
  restrict(path.join(resolved, "wallets.json"), false);
  restrict(path.join(resolved, "bundles.json"), false);
  const legacyData = path.resolve(root, "data");
  restrict(path.join(legacyData, "wallets.json"), false);
  restrict(path.join(legacyData, "bundles.json"), false);
}

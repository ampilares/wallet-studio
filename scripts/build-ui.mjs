import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

await mkdir("dist/studio/public", { recursive: true });
await build({ entryPoints: ["ui/main.tsx"], bundle: true, outfile: "dist/studio/public/app.js", minify: true, platform: "browser", target: "es2022", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } });
execFileSync(process.execPath, ["node_modules/@tailwindcss/cli/dist/index.mjs", "-i", "ui/style.css", "-o", "dist/studio/public/app.css", "--minify"], { stdio: "inherit", windowsHide: true });
for (const file of ["index.html", "favicon.svg"]) await copyFile(`ui/${file}`, `dist/studio/public/${file}`);
console.log("Wallet Studio UI built.");

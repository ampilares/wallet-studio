/** Read a secret without placing it in argv or echoing it to the terminal. */
export async function readSecret(prompt: string, fromStdin = false): Promise<string> {
  const input = process.stdin;
  if (!fromStdin && !input.isTTY) {
    throw new Error("Secret input needs an interactive terminal, or an explicit stdin option with a secure input stream");
  }
  const interactive = !fromStdin;
  if (fromStdin && input.isTTY) throw new Error("Omit the stdin option for hidden interactive input");
  const wasRaw = input.isRaw;
  if (interactive) {
    process.stderr.write(prompt);
    input.setRawMode(true);
  }
  input.setEncoding("utf8");
  try {
    const key = await new Promise<string>((resolve, reject) => {
      let value = "";
      const cleanup = () => {
        input.off("data", onData);
        input.off("end", onEnd);
        input.off("error", onError);
        input.pause();
      };
      const finish = () => { cleanup(); resolve(value.replace(/[\r\n]+$/, "")); };
      const onEnd = () => finish();
      const onError = () => { cleanup(); reject(new Error("Unable to read secret")); };
      const onData = (chunk: string) => {
        for (const char of chunk) {
          if (interactive && (char === "\r" || char === "\n")) { finish(); return; }
          if (char === "\u0003" || char === "\u0004") { cleanup(); reject(new Error("Secret input cancelled")); return; }
          if (interactive && (char === "\u007f" || char === "\b")) value = value.slice(0, -1);
          else value += char;
          if (value.length > 4096) { cleanup(); reject(new Error("Secret input is too long")); return; }
        }
      };
      input.on("data", onData);
      input.once("end", onEnd);
      input.once("error", onError);
      input.resume();
    });
    return key;
  } finally {
    if (interactive) {
      input.setRawMode(wasRaw);
      process.stderr.write("\n");
    }
  }
}

export async function readPrivateKey(fromStdin = false): Promise<`0x${string}`> {
  const key = (await readSecret("Private key (hidden): ", fromStdin)).trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(key)) throw new Error("Invalid private key format");
  return (key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`;
}

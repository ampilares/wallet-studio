import type { Hash, Hex } from "viem";
import { getChain, sequencerUrl, type NetworkName } from "./networks.js";

/**
 * Submit already-signed raw transactions directly to the Base sequencer.
 * @see https://github.com/base/node
 */
export class SequencerClient {
  readonly url: string;
  readonly chainId: number;

  constructor(network: NetworkName, overrideUrl?: string) {
    this.url = overrideUrl ?? sequencerUrl(network);
    this.chainId = getChain(network).id;
  }

  async sendRawTransaction(signedTx: Hex): Promise<Hash> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_sendRawTransaction",
        params: [signedTx],
      }),
    });
    if (!res.ok) {
      throw new Error(`Sequencer HTTP ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as {
      result?: Hash;
      error?: { message?: string };
    };
    if (body.error) {
      throw new Error(body.error.message ?? "Sequencer RPC error");
    }
    if (!body.result) throw new Error("Sequencer returned empty result");
    return body.result;
  }

  async ping(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const started = Date.now();
    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(8_000),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_chainId",
          params: [],
        }),
      });
      const latencyMs = Date.now() - started;
      if (!res.ok) {
        return { ok: false, latencyMs, error: `HTTP ${res.status}` };
      }
      const body = (await res.json()) as { result?: string; error?: { message?: string } };
      if (body.error) return { ok: false, latencyMs, error: body.error.message };
      if (!body.result || Number(body.result) !== this.chainId) {
        return { ok: false, latencyMs, error: `Sequencer chain mismatch: expected ${this.chainId}` };
      }
      return { ok: true, latencyMs };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

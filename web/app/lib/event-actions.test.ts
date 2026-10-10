import { describe, expect, it, vi } from "vitest";
import {
  prepareCheckpointCure,
  confirmCheckpointCure,
  prepareFinalize,
  confirmFinalize,
} from "./event-actions";

/**
 * Fakes eventRegistryClient(publicKey) itself, so these tests can
 * assert on the exact publicKey it was constructed with - the one
 * thing that actually proves the fix (eventRegistryClient bakes
 * publicKey into the built transaction's own source account; see
 * lib/contracts/event-registry.ts's doc comment, confirmed live
 * against testnet: tx.built.source === the publicKey passed in).
 */
const { eventRegistryClient, lastConstructedWith } = vi.hoisted(() => {
  const state = { lastConstructedWith: undefined as string | undefined };
  const client = {
    checkpoint_cure: vi.fn(async () => ({
      result: { isErr: () => false, unwrapErr: () => ({ message: "" }) },
      built: { source: state.lastConstructedWith },
      signAndSend: vi.fn(async () => ({
        result: {
          isErr: () => false,
          unwrap: () => ({ recorded: BigInt(1), any_below_threshold: false, any_missing: false }),
        },
        sendTransactionResponse: { hash: "abc123" },
      })),
    })),
    finalize: vi.fn(async () => ({
      result: { isErr: () => false, unwrapErr: () => ({ message: "" }) },
      built: { source: state.lastConstructedWith },
      signAndSend: vi.fn(async () => ({
        result: { isErr: () => false, unwrap: () => undefined },
        sendTransactionResponse: { hash: "def456" },
      })),
    })),
  };
  return {
    eventRegistryClient: vi.fn((publicKey?: string) => {
      state.lastConstructedWith = publicKey;
      return client;
    }),
    lastConstructedWith: state,
  };
});

vi.mock("./contracts/event-registry", () => ({ eventRegistryClient }));

const ADDRESS_A = "GCWWB2WYVRE4SSMASR6EMFQ7D3K6BEOLN5UQAXGS5YWPX2ZJ44JYKER5";
const ADDRESS_B = "GBXYFBRIS5M7S2UDQ64AE4QHSJG7UIN6VRPDDAEBKP724V344GAL5MJP";

function fakeSigner(publicKey: string) {
  return {
    publicKey,
    signTransaction: vi.fn(async () => ({ signedTxXdr: "fake-xdr" })),
  };
}

describe("event-actions - publicKey wiring", () => {
  it("prepareCheckpointCure builds the client with the connected address as publicKey", async () => {
    await prepareCheckpointCure(BigInt(1), ADDRESS_A);
    expect(eventRegistryClient).toHaveBeenCalledWith(ADDRESS_A);
  });

  it("the prepared transaction's own built source account equals the connected address", async () => {
    const prepared = await prepareCheckpointCure(BigInt(1), ADDRESS_A);
    expect(prepared.tx.built?.source).toBe(ADDRESS_A);
    expect(prepared.preparedFor).toBe(ADDRESS_A);
  });

  it("prepareFinalize builds the client with the connected address as publicKey", async () => {
    await prepareFinalize(BigInt(1), ADDRESS_B);
    expect(eventRegistryClient).toHaveBeenCalledWith(ADDRESS_B);
  });

  it("confirmCheckpointCure signs and sends when the signer matches who it was prepared for", async () => {
    const prepared = await prepareCheckpointCure(BigInt(1), ADDRESS_A);
    const result = await confirmCheckpointCure(prepared, fakeSigner(ADDRESS_A));
    expect(result.txHash).toBe("abc123");
  });

  it("confirmCheckpointCure refuses to sign a transaction prepared for a different address", async () => {
    const prepared = await prepareCheckpointCure(BigInt(1), ADDRESS_A);
    await expect(confirmCheckpointCure(prepared, fakeSigner(ADDRESS_B))).rejects.toThrow(
      /connected wallet changed/i,
    );
  });

  it("confirmFinalize refuses to sign a transaction prepared for a different address", async () => {
    const prepared = await prepareFinalize(BigInt(1), ADDRESS_A);
    await expect(confirmFinalize(prepared, fakeSigner(ADDRESS_B))).rejects.toThrow(
      /connected wallet changed/i,
    );
  });

  it("confirmFinalize signs and sends when the signer matches who it was prepared for", async () => {
    const prepared = await prepareFinalize(BigInt(1), ADDRESS_A);
    const result = await confirmFinalize(prepared, fakeSigner(ADDRESS_A));
    expect(result.txHash).toBe("def456");
  });
});

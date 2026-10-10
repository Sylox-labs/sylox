import { describe, expect, it } from "vitest";
import { resolveKitNetwork } from "./kit";

const FAKE_NETWORKS = {
  PUBLIC: "Public Global Stellar Network ; September 2015",
  TESTNET: "Test SDF Network ; September 2015",
  FUTURENET: "Test SDF Future Network ; October 2022",
};

describe("resolveKitNetwork", () => {
  it("returns the matching network passphrase", () => {
    expect(resolveKitNetwork(FAKE_NETWORKS.TESTNET, FAKE_NETWORKS)).toBe(FAKE_NETWORKS.TESTNET);
  });

  it("throws, rather than falling back to any default, when the passphrase matches no known network", () => {
    expect(() => resolveKitNetwork("some unrecognized passphrase", FAKE_NETWORKS)).toThrow(
      /doesn't match any network the wallet kit knows about/i,
    );
  });

  it("never silently returns TESTNET for an unmatched passphrase", () => {
    let result: string | null = null;
    try {
      result = resolveKitNetwork("not a real network", FAKE_NETWORKS);
    } catch {
      // expected
    }
    expect(result).toBeNull();
  });
});

import { NETWORK_PASSPHRASE } from "@/lib/contracts/deployment";

/**
 * The Stellar Wallets Kit bundles its OWN @stellar/stellar-sdk (17.x),
 * separate from this app's (16.x, what the generated contract bindings
 * were built against - see issue #37 for the planned upgrade). Nothing
 * here imports a type or value from that bundled SDK; everything that
 * crosses the kit/app boundary is a plain XDR string, never a
 * Transaction or other SDK object - those can fail type checks across
 * versions even when TypeScript compiles cleanly, since each SDK's
 * classes are distinct at runtime.
 *
 * Imported only from inside the wallet picker's open handler (never
 * from a module eagerly loaded on every page), and only the three
 * wallet modules this app actually offers (Freighter, xBull, Albedo -
 * each imported by its own subpath, not defaultModules(), which pulls
 * in every "no extra config" module the kit ships, including several
 * this app has no reason to list) - so the fetched bundle is only ever
 * what someone opening the connect modal could actually pick from.
 */
/**
 * Networks is a string enum whose TESTNET value is the exact same
 * passphrase deployments/testnet.json already carries - looked up by
 * value rather than importing Networks.TESTNET directly, so this
 * stays anchored to the deployment record (the app's one source of
 * truth for which network it's pointed at) instead of a second,
 * independent "testnet" constant that could silently drift from it.
 * No fallback to Networks.TESTNET: a passphrase that doesn't match any
 * known kit network is a real misconfiguration (a bad
 * deployments/testnet.json, or a future mainnet deploy the kit
 * doesn't recognize yet) and must fail loudly, not silently connect
 * wallets to the wrong network. A pure function so this one
 * easy-to-get-wrong rule - throw, never fall back - can be unit
 * tested directly, without going through the kit's own dynamic import.
 */
export function resolveKitNetwork(
  passphrase: string,
  knownNetworks: Record<string, string>,
): string {
  const network = Object.values(knownNetworks).find((n) => n === passphrase);
  if (!network) {
    throw new Error(`NETWORK_PASSPHRASE "${passphrase}" doesn't match any network the wallet kit knows about.`);
  }
  return network;
}

async function loadKit() {
  const [{ StellarWalletsKit, Networks }, { FreighterModule }, { xBullModule }, { AlbedoModule }] =
    await Promise.all([
      import("@creit.tech/stellar-wallets-kit"),
      import("@creit.tech/stellar-wallets-kit/modules/freighter"),
      import("@creit.tech/stellar-wallets-kit/modules/xbull"),
      import("@creit.tech/stellar-wallets-kit/modules/albedo"),
    ]);

  const network = resolveKitNetwork(NETWORK_PASSPHRASE, Networks);

  StellarWalletsKit.init({
    modules: [new FreighterModule(), new xBullModule(), new AlbedoModule()],
    network: network as (typeof Networks)[keyof typeof Networks],
  });

  return StellarWalletsKit;
}

let kitPromise: ReturnType<typeof loadKit> | null = null;

/** Lazily loads and initializes the kit exactly once; every caller after the first gets the same in-flight/resolved promise. */
export function getKit() {
  if (!kitPromise) kitPromise = loadKit();
  return kitPromise;
}

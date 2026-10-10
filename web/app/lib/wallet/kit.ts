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
 * from a module eagerly loaded on every page) so the kit's ~300KB+
 * bundle (it pulls in every "no extra config" wallet module via
 * defaultModules()) is fetched only once someone actually opens the
 * connect modal, not on first paint of the Event screen.
 */
async function loadKit() {
  const [{ StellarWalletsKit, Networks }, { defaultModules }] = await Promise.all([
    import("@creit.tech/stellar-wallets-kit"),
    import("@creit.tech/stellar-wallets-kit/modules/utils"),
  ]);

  // Networks is a string enum whose TESTNET value is the exact same
  // passphrase deployments/testnet.json already carries - looked up by
  // value rather than importing Networks.TESTNET directly, so this
  // stays anchored to the deployment record (the app's one source of
  // truth for which network it's pointed at) instead of a second,
  // independent "testnet" constant that could silently drift from it.
  const network = (Object.values(Networks) as string[]).includes(NETWORK_PASSPHRASE)
    ? (NETWORK_PASSPHRASE as (typeof Networks)[keyof typeof Networks])
    : Networks.TESTNET;

  StellarWalletsKit.init({ modules: defaultModules(), network });

  return StellarWalletsKit;
}

let kitPromise: ReturnType<typeof loadKit> | null = null;

/** Lazily loads and initializes the kit exactly once; every caller after the first gets the same in-flight/resolved promise. */
export function getKit() {
  if (!kitPromise) kitPromise = loadKit();
  return kitPromise;
}

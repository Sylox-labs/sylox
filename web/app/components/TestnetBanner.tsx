/**
 * Shown on every page (brief: "Label testnet clearly. Every page shows
 * a testnet banner. While signals are sample data, the asset page
 * shows a 'sample data' badge."). A fixed, deliberately plain strip,
 * not a dismissible toast: it should never be possible to lose track
 * of which network this app is talking to.
 *
 * "Live" here would describe the wrong thing: the contract READS are
 * live (every number on screen comes from a real RPC call, not a
 * mock), but the underlying VALUES on testnet are sample data posted
 * by deploy/post-demo-signals.sh, not a real price feed - there's no
 * live data service yet. Leave this wording in place until there is
 * one; swap it deliberately then, not as a side effect of some other
 * change.
 */
export function TestnetBanner() {
  return (
    <div
      role="status"
      className="rounded-sm border border-risk-crimson/40 bg-risk-crimson/10 px-4 py-2 font-mono text-xs uppercase tracking-wide text-risk-crimson-tint"
    >
      Testnet. Prices are sample data until the live data service ships.
    </div>
  );
}

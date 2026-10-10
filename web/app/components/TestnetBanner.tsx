/**
 * Shown on every page (brief: "Label testnet clearly. Every page shows
 * a testnet banner."). A fixed, deliberately plain strip, not a
 * dismissible toast: it should never be possible to lose track of
 * which network this app is talking to.
 */
export function TestnetBanner() {
  return (
    <div
      role="status"
      className="rounded-sm border border-risk-crimson/40 bg-risk-crimson/10 px-4 py-2 font-mono text-xs uppercase tracking-wide text-risk-crimson-tint"
    >
      Testnet. Sample and live testnet data, not production risk.
    </div>
  );
}

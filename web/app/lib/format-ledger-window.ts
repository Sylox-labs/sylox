const SECS_PER_LEDGER = 5; // Stellar's target ledger close time - used only for a human label, never for anything that needs to be exact.

/** "Events in the last N days" / "...N hours", honestly worked out from the ledger range a scan actually covered - never a fixed 7, since a scan can stop early at REQUEST_CAP (see lib/stellar-rpc-events.ts). */
export function describeScannedWindow(latestLedger: number, oldestLedgerScanned: number): string {
  const ledgers = Math.max(0, latestLedger - oldestLedgerScanned);
  const hours = (ledgers * SECS_PER_LEDGER) / 3600;
  if (hours < 1) return "the last hour";
  if (hours < 24) return `the last ${Math.round(hours)} hour${Math.round(hours) === 1 ? "" : "s"}`;
  const days = hours / 24;
  const rounded = Math.round(days * 10) / 10;
  return `the last ${rounded} day${rounded === 1 ? "" : "s"}`;
}

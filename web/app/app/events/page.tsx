"use client";

import { useEffect, useState } from "react";
import { Eyebrow, Card } from "@sylox/ui/components";
import { TestnetBanner } from "@/components/TestnetBanner";
import { DashboardShell } from "@/components/DashboardShell";
import { listRegistryEvents, type EventListRow } from "@/lib/events-list-data";
import { describeScannedWindow } from "@/lib/format-ledger-window";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      rows: EventListRow[];
      oldestLedgerScanned: number;
      latestLedger: number;
      stoppedAtRequestCap: boolean;
    };

const STATE_LABEL: Record<EventListRow["state"], string> = {
  None: "None",
  Proposed: "Proposed",
  Challenged: "Challenged",
  Escalated: "Challenged", // The contract never sets the unused Challenged variant - challenge() goes straight to Escalated. See lib/event-fixtures.ts's own note.
  Declared: "Declared",
  Rejected: "Rejected",
  Cured: "Cured",
};

function formatCountdown(windowClosesAt: bigint | null): string | null {
  if (windowClosesAt === null) return null;
  const remaining = Number(windowClosesAt) - Math.floor(Date.now() / 1000);
  if (remaining <= 0) return "Window closed";
  const hours = Math.floor(remaining / 3600);
  if (hours >= 24) return `${Math.floor(hours / 24)}d left`;
  if (hours >= 1) return `${hours}h left`;
  return `${Math.floor(remaining / 60)}m left`;
}

export default function EventsPage() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  // Rows resolved so far during a still-running scan - each one has
  // already had its CURRENT state read via event(event_id) (see
  // lib/events-list-data.ts's onRowProgress), so these are real,
  // final rows, just not yet the complete set. Replaced wholesale by
  // state.rows once the scan resolves, at which point this is cleared
  // (its job is only to cover the loading gap).
  const [partialRows, setPartialRows] = useState<EventListRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    const seen = new Map<string, EventListRow>();
    listRegistryEvents({
      onRowProgress: (row) => {
        if (cancelled) return;
        seen.set(row.id.toString(), row);
        // Rows resolve in whatever order their event(id) reads happen
        // to settle in (see events-list-data.ts's onRowProgress doc
        // comment - a later id can resolve before an earlier one), so
        // insertion order alone isn't newest-first. Sorted by
        // proposedAt descending on every update instead, matching the
        // order the final, resolved rows are shown in.
        setPartialRows(Array.from(seen.values()).sort((a, b) => Number(b.proposedAt - a.proposedAt)));
      },
    })
      .then(({ rows, oldestLedgerScanned, latestLedger, stoppedAtRequestCap }) => {
        if (!cancelled) setState({ status: "ready", rows, oldestLedgerScanned, latestLedger, stoppedAtRequestCap });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <DashboardShell title="Events">
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-16 md:px-16 md:py-24">
        <TestnetBanner />

        <Eyebrow className="mt-8">+ EVENTS</Eyebrow>
        <h1 className="mt-4 font-display text-4xl leading-[0.95] tracking-tight text-silo-oatmeal md:text-5xl">
          Every proposed event.
        </h1>

        <div className="mt-12">
          {state.status === "loading" && (
            <>
              <p className="font-mono text-sm text-cyber-tin" role="status">
                {partialRows.length > 0 ? "Loading older events…" : "Loading events from the registry…"}
              </p>
              {partialRows.length > 0 && <EventRows rows={partialRows} className="mt-6" />}
            </>
          )}

          {state.status === "error" && (
            <p className="font-mono text-sm text-risk-crimson" role="alert">
              Could not load events: {state.message}
            </p>
          )}

          {state.status === "ready" && (
            <>
              <p className="font-mono text-xs text-cyber-tin">
                {windowLabel(state.rows.length, state.stoppedAtRequestCap, state.latestLedger, state.oldestLedgerScanned)}
              </p>

              {state.rows.length === 0 ? (
                <p className="mt-6 font-mono text-sm text-cyber-tin">
                  {state.stoppedAtRequestCap
                    ? `No events in ${describeScannedWindow(state.latestLedger, state.oldestLedgerScanned)} scanned.`
                    : "No events yet."}
                </p>
              ) : (
                <EventRows rows={state.rows} className="mt-6" />
              )}
            </>
          )}
        </div>
      </main>
    </DashboardShell>
  );
}

/**
 * The top-of-page summary label. "No events found in..." is only ever
 * honest with zero rows - with rows AND a cap stop, the scan did find
 * real events, just not necessarily all of them, so the label says
 * that instead of contradicting the list rendered right below it.
 */
function windowLabel(
  rowCount: number,
  stoppedAtRequestCap: boolean,
  latestLedger: number,
  oldestLedgerScanned: number,
): string {
  const window = describeScannedWindow(latestLedger, oldestLedgerScanned);
  if (!stoppedAtRequestCap) return `Events in ${window}.`;
  if (rowCount === 0) return `No events found in ${window} scanned.`;
  return `Showing events from ${window}; older history not scanned.`;
}

function EventRows({ rows, className }: { rows: EventListRow[]; className?: string }) {
  return (
    <div className={`flex flex-col gap-3 ${className ?? ""}`}>
      {rows.map((row) => {
        const countdown = formatCountdown(row.windowClosesAt);
        return (
          <Card key={row.id.toString()} href={`/event/${row.id}`} className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="truncate font-display text-lg text-silo-oatmeal">{row.assetCode}</p>
              <p className="font-mono text-xs text-cyber-tin">{row.kind}</p>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              {countdown && <span className="font-mono text-xs text-cyber-tin">{countdown}</span>}
              <span className="rounded-full border border-risk-crimson/40 bg-risk-crimson/10 px-3 py-1 font-mono text-xs uppercase tracking-wide text-risk-crimson-tint">
                {STATE_LABEL[row.state]}
              </span>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

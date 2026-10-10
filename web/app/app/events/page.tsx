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
  const [partialRows, setPartialRows] = useState<EventListRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    listRegistryEvents({
      onProgress: () => {
        // The newest events are what onProgress reports first (see
        // lib/stellar-rpc-events.ts) - this just flags that SOME
        // results have started landing, so the UI can swap its
        // "Loading" message for "Loading older events" while the
        // scan keeps walking further back. The final row list still
        // comes from the resolved listRegistryEvents() call below,
        // which has already read each event's current state via
        // event(event_id) - onProgress's own raw events haven't.
        if (!cancelled) setPartialRows((prev) => prev ?? []);
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
            <p className="font-mono text-sm text-cyber-tin" role="status">
              {partialRows ? "Loading older events…" : "Loading events from the registry…"}
            </p>
          )}

          {state.status === "error" && (
            <p className="font-mono text-sm text-risk-crimson" role="alert">
              Could not load events: {state.message}
            </p>
          )}

          {state.status === "ready" && (
            <>
              <p className="font-mono text-xs text-cyber-tin">
                {state.stoppedAtRequestCap
                  ? `No events found in ${describeScannedWindow(state.latestLedger, state.oldestLedgerScanned)} scanned.`
                  : `Events in ${describeScannedWindow(state.latestLedger, state.oldestLedgerScanned)}.`}
              </p>

              {state.rows.length === 0 ? (
                <p className="mt-6 font-mono text-sm text-cyber-tin">
                  {state.stoppedAtRequestCap
                    ? `No events in ${describeScannedWindow(state.latestLedger, state.oldestLedgerScanned)} scanned.`
                    : "No events yet."}
                </p>
              ) : (
                <div className="mt-6 flex flex-col gap-3">
                  {state.rows.map((row) => {
                    const countdown = formatCountdown(row.windowClosesAt);
                    return (
                      <Card key={row.id.toString()} href={`/event/${row.id}`} className="flex items-center justify-between gap-4">
                        <div className="min-w-0">
                          <p className="truncate font-display text-lg text-silo-oatmeal">{row.assetCode}</p>
                          <p className="font-mono text-xs text-cyber-tin">{row.kind}</p>
                        </div>
                        <div className="flex shrink-0 items-center gap-3">
                          {countdown && (
                            <span className="font-mono text-xs text-cyber-tin">{countdown}</span>
                          )}
                          <span className="rounded-full border border-risk-crimson/40 bg-risk-crimson/10 px-3 py-1 font-mono text-xs uppercase tracking-wide text-risk-crimson-tint">
                            {STATE_LABEL[row.state]}
                          </span>
                        </div>
                      </Card>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </main>
    </DashboardShell>
  );
}

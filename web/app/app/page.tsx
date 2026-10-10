"use client";

import { useEffect, useState } from "react";
import { Eyebrow, Card } from "@sylox/ui/components";
import { fetchExplorerRows, type ExplorerAssetRow } from "@/lib/explorer-data";
import { TestnetBanner } from "@/components/TestnetBanner";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; rows: ExplorerAssetRow[] };

export default function ExplorerPage() {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetchExplorerRows()
      .then((rows) => {
        if (!cancelled) setState({ status: "ready", rows });
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
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-16 md:px-16 md:py-24">
      <TestnetBanner />

      <Eyebrow className="mt-8">+ EXPLORER</Eyebrow>
      <h1 className="mt-4 font-display text-4xl leading-[0.95] tracking-tight text-silo-oatmeal md:text-5xl">
        Every tracked asset, one glance.
      </h1>
      <p className="mt-4 max-w-xl text-base leading-relaxed text-cyber-tin md:text-lg">
        Risk band, latest peg value, and event status, read straight from the
        oracle on every load.
      </p>

      <div className="mt-12">
        {state.status === "loading" && (
          <p className="font-mono text-sm text-cyber-tin" role="status">
            Loading assets from the oracle…
          </p>
        )}

        {state.status === "error" && (
          <p className="font-mono text-sm text-risk-crimson" role="alert">
            Could not load assets: {state.message}
          </p>
        )}

        {state.status === "ready" && state.rows.length === 0 && (
          <p className="font-mono text-sm text-cyber-tin">
            No assets are tracked yet.
          </p>
        )}

        {state.status === "ready" && state.rows.length > 0 && (
          <div className="grid gap-4 md:grid-cols-2">
            {state.rows.map((row) => (
              <AssetCard key={row.asset} row={row} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function AssetCard({ row }: { row: ExplorerAssetRow }) {
  return (
    <Card href={`/asset/${row.asset}`} className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <span
          className="truncate font-mono text-xs text-cyber-tin"
          title={row.asset}
        >
          {row.asset.slice(0, 4)}…{row.asset.slice(-4)}
        </span>
        <span
          className="shrink-0 rounded-full px-3 py-1 font-mono text-xs uppercase tracking-wide"
          style={{
            color: row.band.colorHex,
            backgroundColor: `color-mix(in srgb, ${row.band.colorHex} 16%, transparent)`,
          }}
        >
          {row.band.label}
        </span>
      </div>

      <div className="flex items-baseline gap-3">
        <span className="font-mono text-4xl font-bold text-silo-oatmeal" data-numeric>
          {row.score === null ? "—" : String(row.score).padStart(2, "0")}
        </span>
        <span className="font-mono text-xs uppercase tracking-wide text-cyber-tin">
          risk score
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        {row.stale && (
          <span className="rounded-full border border-cement-grey/40 px-3 py-1 font-mono text-[10px] uppercase tracking-wide text-cyber-tin">
            Stale
          </span>
        )}
        {row.eventInProgress && (
          <span className="rounded-full border border-risk-crimson/50 px-3 py-1 font-mono text-[10px] uppercase tracking-wide text-risk-crimson-tint">
            Event in progress
          </span>
        )}
        {row.eventDeclared && (
          <span className="rounded-full border border-risk-crimson/50 bg-risk-crimson/10 px-3 py-1 font-mono text-[10px] uppercase tracking-wide text-risk-crimson-tint">
            Event declared
          </span>
        )}
      </div>
    </Card>
  );
}

"use client";

import { useEffect, useState } from "react";
import { Eyebrow, Card } from "@sylox/ui/components";
import {
  fetchExplorerData,
  type ExplorerAssetRow,
  type ExplorerAssetError,
} from "@/lib/explorer-data";
import { TestnetBanner } from "@/components/TestnetBanner";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; rows: ExplorerAssetRow[]; errors: ExplorerAssetError[] };

export default function ExplorerPage() {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetchExplorerData()
      .then(({ rows, errors }) => {
        if (!cancelled) setState({ status: "ready", rows, errors });
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

        {/* A failure here means the asset LIST itself couldn't be read
            (RiskOracle.assets() failed) - a page-wide problem, unlike a
            single asset's row failing below, which only takes down that
            one card. */}
        {state.status === "error" && (
          <p className="font-mono text-sm text-risk-crimson" role="alert">
            Could not load assets: {state.message}
          </p>
        )}

        {state.status === "ready" &&
          state.rows.length === 0 &&
          state.errors.length === 0 && (
            <p className="font-mono text-sm text-cyber-tin">
              No assets are tracked yet.
            </p>
          )}

        {state.status === "ready" && (state.rows.length > 0 || state.errors.length > 0) && (
          <div className="grid gap-4 md:grid-cols-2">
            {state.rows.map((row) => (
              <AssetCard key={row.asset} row={row} />
            ))}
            {state.errors.map((error) => (
              <AssetErrorCard key={error.asset} error={error} />
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
        <div className="min-w-0">
          <p className="truncate font-display text-xl text-silo-oatmeal">{row.code}</p>
          <p
            className="truncate font-mono text-[10px] text-cyber-tin/70"
            title={row.asset}
          >
            {row.homeDomain ?? `${row.asset.slice(0, 4)}…${row.asset.slice(-4)}`}
          </p>
        </div>
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

      <div className="flex flex-wrap items-baseline gap-x-8 gap-y-3">
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-4xl font-bold text-silo-oatmeal" data-numeric>
            {row.score === null ? "—" : String(row.score).padStart(2, "0")}
          </span>
          <span className="font-mono text-xs uppercase tracking-wide text-cyber-tin">
            risk score
          </span>
        </div>

        <div className="flex items-baseline gap-2">
          <span className="font-mono text-lg text-silo-oatmeal" data-numeric>
            {row.pegRatio === null ? "—" : row.pegRatio.toFixed(4)}
          </span>
          <span className="font-mono text-xs uppercase tracking-wide text-cyber-tin">
            peg
          </span>
        </div>
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

function AssetErrorCard({ error }: { error: ExplorerAssetError }) {
  return (
    <Card className="flex flex-col gap-2 border-risk-crimson/40" role="alert">
      <p
        className="truncate font-mono text-[10px] text-cyber-tin/70"
        title={error.asset}
      >
        {error.asset.slice(0, 4)}…{error.asset.slice(-4)}
      </p>
      <p className="font-mono text-sm text-risk-crimson-tint">
        Couldn&apos;t read this asset
      </p>
      <p className="font-mono text-xs text-cyber-tin">{error.message}</p>
    </Card>
  );
}

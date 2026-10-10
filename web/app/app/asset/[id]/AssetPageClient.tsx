"use client";

import { useEffect, useState } from "react";
import { Eyebrow, Card } from "@sylox/ui/components";
import { TestnetBanner } from "@/components/TestnetBanner";
import { PegHistoryChart } from "@/components/PegHistoryChart";
import { fetchAssetPageData, type AssetPageData } from "@/lib/asset-data";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: AssetPageData };

export function AssetPageClient({ asset }: { asset: string }) {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetchAssetPageData(asset)
      .then((data) => {
        if (!cancelled) setState({ status: "ready", data });
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
  }, [asset]);

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-16 md:px-16 md:py-24">
      <TestnetBanner />

      {state.status === "loading" && (
        <p className="mt-8 font-mono text-sm text-cyber-tin" role="status">
          Loading asset from the oracle…
        </p>
      )}

      {state.status === "error" && (
        <p className="mt-8 font-mono text-sm text-risk-crimson" role="alert">
          Could not load this asset: {state.message}
        </p>
      )}

      {state.status === "ready" && <AssetSections data={state.data} />}
    </main>
  );
}

function SectionError({ message }: { message: string }) {
  return (
    <p className="font-mono text-sm text-risk-crimson" role="alert">
      Couldn&apos;t load this section: {message}
    </p>
  );
}

function AssetSections({ data }: { data: AssetPageData }) {
  return (
    <div className="mt-8 flex flex-col gap-10">
      <HeaderSection data={data} />
      <ConfirmedLiveSection data={data} />
      <PegHistorySection data={data} />
      <FailureDefinitionsSection data={data} />
      <CoverGateSection data={data} />
      <ActiveEventSection data={data} />
    </div>
  );
}

function HeaderSection({ data }: { data: AssetPageData }) {
  if (data.header.status === "error") return <SectionError message={data.header.message} />;
  const header = data.header.value;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl leading-[0.95] tracking-tight text-silo-oatmeal md:text-4xl">
            {header.code}
          </h1>
          <p className="mt-2 font-mono text-xs text-cyber-tin/70">
            {header.homeDomain ?? `${header.asset.slice(0, 4)}…${header.asset.slice(-4)}`}
          </p>
          <p className="mt-1 font-mono text-[10px] text-cyber-tin/70" title={header.asset}>
            {header.asset.slice(0, 4)}…{header.asset.slice(-4)}
          </p>
        </div>
        {header.band === null ? (
          <span className="shrink-0 rounded-full border border-cement-grey/40 px-3 py-1 font-mono text-sm uppercase tracking-wide text-cyber-tin">
            Not scored yet
          </span>
        ) : (
          <span
            className="shrink-0 rounded-full px-3 py-1 font-mono text-sm uppercase tracking-wide"
            style={{
              color: header.band.colorHex,
              backgroundColor: `color-mix(in srgb, ${header.band.colorHex} 16%, transparent)`,
            }}
          >
            {header.band.label}
          </span>
        )}
      </div>

      {header.band === null && (
        <p className="mt-2 font-mono text-xs text-cyber-tin">Not enough confirmed history yet.</p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-4">
        {header.score !== null && (
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-2xl font-bold text-silo-oatmeal" data-numeric>
              {String(header.score).padStart(2, "0")}
            </span>
            <span className="font-mono text-xs uppercase tracking-wide text-cyber-tin">score</span>
          </div>
        )}
        {header.stale && (
          <span className="rounded-full border border-cement-grey/40 px-3 py-1 font-mono text-[10px] uppercase tracking-wide text-cyber-tin">
            Stale
          </span>
        )}
        {header.eventInProgress && (
          <span className="rounded-full border border-risk-crimson/50 px-3 py-1 font-mono text-[10px] uppercase tracking-wide text-risk-crimson-tint">
            Event in progress
          </span>
        )}
        {header.eventDeclared && (
          <span className="rounded-full border border-risk-crimson/50 bg-risk-crimson/10 px-3 py-1 font-mono text-[10px] uppercase tracking-wide text-risk-crimson-tint">
            Event declared
          </span>
        )}
      </div>
    </div>
  );
}

function formatChallengeDeadline(pendingUntil: bigint): string {
  const date = new Date(Number(pendingUntil) * 1000);
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} UTC`;
}

function ConfirmedLiveSection({ data }: { data: AssetPageData }) {
  return (
    <div>
      <Eyebrow>+ PEG PRICE</Eyebrow>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <Card>
          <p className="font-mono text-xs uppercase tracking-wide text-cyber-tin">Confirmed</p>
          <p className="mt-1 text-xs text-cyber-tin/70">The hourly value, settled.</p>
          {data.confirmed.status === "error" ? (
            <div className="mt-3">
              <SectionError message={data.confirmed.message} />
            </div>
          ) : (
            <>
              {data.confirmed.value.confirmed === null ? (
                <p className="mt-3 font-mono text-sm text-cyber-tin">No confirmed value yet.</p>
              ) : (
                <div className="mt-3 flex items-baseline gap-4">
                  <span className="font-mono text-2xl text-silo-oatmeal" data-numeric>
                    {data.confirmed.value.confirmed.pegRatio.toFixed(4)}
                  </span>
                  <span className="font-mono text-xs uppercase tracking-wide text-cyber-tin">peg</span>
                </div>
              )}
              {data.confirmed.value.latestPending !== null && (
                <p className="mt-3 border-t border-cement-grey/30 pt-3 font-mono text-xs text-cyber-tin">
                  Latest hour: {data.confirmed.value.latestPending.pegRatio.toFixed(4)} peg, can
                  still be challenged until{" "}
                  {formatChallengeDeadline(data.confirmed.value.latestPending.pendingUntil)}.
                </p>
              )}
            </>
          )}
        </Card>

        <Card>
          <p className="font-mono text-xs uppercase tracking-wide text-cyber-tin">Live</p>
          <p className="mt-1 text-xs text-cyber-tin/70">
            The newest 5-minute update. Can still be challenged.
          </p>
          {data.live.status === "error" ? (
            <div className="mt-3">
              <SectionError message={data.live.message} />
            </div>
          ) : data.live.value.status === "not-deployed" ? (
            <p className="mt-3 font-mono text-sm text-cyber-tin">Live updates coming soon.</p>
          ) : data.live.value.status === "none" ? (
            <p className="mt-3 font-mono text-sm text-cyber-tin">No live update yet.</p>
          ) : (
            <div className="mt-3 flex items-baseline gap-4">
              <span className="font-mono text-2xl text-silo-oatmeal" data-numeric>
                {data.live.value.pegRatio.toFixed(4)}
              </span>
              <span className="font-mono text-xs uppercase tracking-wide text-cyber-tin">
                peg, can still be challenged
              </span>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function PegHistorySection({ data }: { data: AssetPageData }) {
  const depegDef = data.failureDefinitions.status === "ok"
    ? data.failureDefinitions.value.find((d) => d.kind === "Depeg")
    : undefined;

  return (
    <div>
      <Eyebrow>+ PEG HISTORY</Eyebrow>
      <div className="mt-4">
        {data.pegHistory.status === "error" ? (
          <SectionError message={data.pegHistory.message} />
        ) : (
          <PegHistoryChart
            points={data.pegHistory.value}
            depegThreshold={depegDef ? extractDepegThreshold(depegDef.sentence) : null}
          />
        )}
      </div>
    </div>
  );
}

// The chart needs a plain number; the sentence is the display copy.
// Parsed back out rather than threading a second field through
// FailureDefinition, since the sentence is already built from the
// same contract field (depeg_threshold) and this keeps that single
// source of truth in one place (sentenceFor in lib/asset-data.ts).
function extractDepegThreshold(sentence: string): number | null {
  const match = sentence.match(/below ([\d.]+) of peg/);
  return match ? Number(match[1]) : null;
}

function FailureDefinitionsSection({ data }: { data: AssetPageData }) {
  return (
    <div>
      <Eyebrow>+ FAILURE DEFINITIONS</Eyebrow>
      <div className="mt-4">
        {data.failureDefinitions.status === "error" ? (
          <SectionError message={data.failureDefinitions.message} />
        ) : data.failureDefinitions.value.length === 0 ? (
          <p className="font-mono text-sm text-cyber-tin">
            No failure definitions registered for this asset yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {data.failureDefinitions.value.map((def) => (
              <li
                key={def.kind}
                className="border-l-2 border-cement-grey/40 pl-4 text-sm leading-relaxed text-cyber-tin"
              >
                {def.sentence}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function CoverGateSection({ data }: { data: AssetPageData }) {
  return (
    <div>
      <Eyebrow>+ COVER SALES</Eyebrow>
      <div className="mt-4">
        {data.coverGate.status === "error" ? (
          <SectionError message={data.coverGate.message} />
        ) : (
          <p
            className={`font-mono text-sm ${
              data.coverGate.value.gate === "Clear" ? "text-silo-oatmeal" : "text-risk-crimson-tint"
            }`}
          >
            {data.coverGate.value.label}
          </p>
        )}
      </div>
    </div>
  );
}

function ActiveEventSection({ data }: { data: AssetPageData }) {
  if (data.activeEventCount.status === "error") {
    return (
      <div>
        <Eyebrow>+ ACTIVE EVENT</Eyebrow>
        <div className="mt-4">
          <SectionError message={data.activeEventCount.message} />
        </div>
      </div>
    );
  }

  if (data.activeEventCount.value === 0) return null;

  return (
    <div>
      <Eyebrow>+ ACTIVE EVENT</Eyebrow>
      <Card className="mt-4">
        <p className="font-mono text-sm text-risk-crimson-tint">
          {data.activeEventCount.value} active event
          {data.activeEventCount.value > 1 ? "s" : ""} for this asset.
        </p>
        <p className="mt-1 text-xs text-cyber-tin">
          The Event screen isn&apos;t built yet - it&apos;ll link here once it is.
        </p>
      </Card>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import { Eyebrow, Card } from "@sylox/ui/components";
import { TestnetBanner } from "@/components/TestnetBanner";
import { Countdown } from "@/components/Countdown";
import { WriteActionButton } from "@/components/WriteActionButton";
import { WalletButton } from "@/components/WalletButton";
import { fetchEventPageData, type EventPageData } from "@/lib/event-data";
import { prepareCheckpointCure, confirmCheckpointCure, prepareFinalize, confirmFinalize } from "@/lib/event-actions";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: EventPageData };

const FIXTURE_IDS = new Set(["fixture-proposed", "fixture-challenged", "fixture-cured", "fixture-declared"]);

export async function loadData(eventId: string): Promise<EventPageData> {
  // DEV-ONLY: a fixture route never reaches the live contract fetch,
  // and the whole fixture module (lib/event-fixtures.ts) is pulled in
  // ONLY through this dynamic import, inside this dev-only branch -
  // that's what lets a production build's bundler strip the module
  // out entirely rather than merely hide it behind a runtime check.
  // In a production build (NODE_ENV === "production"), a fixture id
  // falls straight through to the real fetch below, which 404s on it
  // exactly like any other nonexistent numeric event_id would.
  if (process.env.NODE_ENV !== "production" && FIXTURE_IDS.has(eventId)) {
    const { EVENT_FIXTURES } = await import("@/lib/event-fixtures");
    return EVENT_FIXTURES[eventId];
  }

  let parsed: bigint;
  try {
    parsed = BigInt(eventId);
  } catch {
    throw new Error(`"${eventId}" isn't a valid event id.`);
  }
  return fetchEventPageData(parsed);
}

export function EventPageClient({ eventId }: { eventId: string }) {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    loadData(eventId)
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
  }, [eventId]);

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-16 md:px-16 md:py-24">
      <div className="flex items-center justify-between gap-4">
        <TestnetBanner />
        <WalletButton />
      </div>

      {state.status === "loading" && (
        <p className="mt-8 font-mono text-sm text-cyber-tin" role="status">
          Loading event from the registry…
        </p>
      )}

      {state.status === "error" && (
        <p className="mt-8 font-mono text-sm text-risk-crimson" role="alert">
          Could not load this event: {state.message}
        </p>
      )}

      {state.status === "ready" && <EventSections eventId={eventId} data={state.data} />}
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

function EventSections({ eventId, data }: { eventId: string; data: EventPageData }) {
  return (
    <div className="mt-8 flex flex-col gap-10">
      <ProposalSection data={data} />
      <CountdownSection data={data} />
      <CureProgressSection data={data} />
      <ActionsSection eventId={eventId} data={data} />
    </div>
  );
}

const STATE_LABEL: Record<string, string> = {
  Proposed: "Proposed",
  Challenged: "Challenged",
  Escalated: "Challenged", // see event-fixtures.ts: the contract never sets the unused Challenged variant, challenge() goes straight to Escalated.
  Declared: "Declared",
  Rejected: "Rejected",
  Cured: "Cured",
  None: "None",
};

function ProposalSection({ data }: { data: EventPageData }) {
  if (data.proposal.status === "error") return <SectionError message={data.proposal.message} />;
  const { record, assetCode, definitionSentence } = data.proposal.value;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Eyebrow>{record.kind.tag}</Eyebrow>
          <h1 className="mt-2 font-display text-3xl leading-[0.95] tracking-tight text-silo-oatmeal md:text-4xl">
            {assetCode}
          </h1>
          <p className="mt-1 font-mono text-xs text-cyber-tin/70">Event #{record.id.toString()}</p>
        </div>
        <span className="shrink-0 rounded-full border border-risk-crimson/40 bg-risk-crimson/10 px-3 py-1 font-mono text-sm uppercase tracking-wide text-risk-crimson-tint">
          {STATE_LABEL[record.state.tag] ?? record.state.tag}
        </span>
      </div>

      <p className="mt-4 max-w-xl text-sm leading-relaxed text-cyber-tin">{definitionSentence}</p>

      {record.declared_at !== undefined && (
        <p className="mt-2 font-mono text-xs text-cyber-tin">
          Declared at {new Date(Number(record.declared_at) * 1000).toISOString()}.
        </p>
      )}
    </div>
  );
}

function CountdownSection({ data }: { data: EventPageData }) {
  if (data.countdown.status === "error") {
    return (
      <div>
        <Eyebrow>+ CHALLENGE WINDOW</Eyebrow>
        <div className="mt-4">
          <SectionError message={data.countdown.message} />
        </div>
      </div>
    );
  }

  const countdown = data.countdown.value;
  if (countdown.phase === "closed") return null;

  return (
    <div>
      <Eyebrow>+ {countdown.phase === "challenge" ? "CHALLENGE WINDOW" : "COMMITTEE RULING"}</Eyebrow>
      <div className="mt-4">
        <Countdown
          deadline={countdown.deadline}
          label={countdown.phase === "challenge" ? "Time left to challenge" : "Time left for a ruling"}
        />
      </div>
    </div>
  );
}

function CureProgressSection({ data }: { data: EventPageData }) {
  if (data.cureProgress.status === "error") {
    return (
      <div>
        <Eyebrow>+ CURE PROGRESS</Eyebrow>
        <div className="mt-4">
          <SectionError message={data.cureProgress.message} />
        </div>
      </div>
    );
  }

  const progress = data.cureProgress.value;
  if (progress === null) return null;

  return (
    <div>
      <Eyebrow>+ CURE PROGRESS</Eyebrow>
      <Card className="mt-4 flex flex-col gap-2">
        <p className="font-mono text-sm text-silo-oatmeal">{progress.recorded.toString()} hours recorded.</p>
        <p className="font-mono text-xs text-cyber-tin">
          {progress.any_below_threshold ? "At least one hour was below threshold." : "No hour below threshold yet."}
        </p>
        <p className="font-mono text-xs text-cyber-tin">
          {progress.any_missing ? "At least one hour is missing." : "No missing hours."}
        </p>
      </Card>
    </div>
  );
}

function ActionsSection({ eventId, data }: { eventId: string; data: EventPageData }) {
  if (data.proposal.status === "error") return null;
  const { record } = data.proposal.value;

  // Checkpoint only ever applies while a Depeg event is still Proposed
  // (checkpoint_cure's own WrongState check) - every other state would
  // simulate straight to an error, so the button is disabled outright
  // rather than letting a visitor click into a guaranteed failure.
  const checkpointDisabled = !(record.kind.tag === "Depeg" && record.state.tag === "Proposed");
  const finalizeDisabled = record.state.tag !== "Proposed";

  const eventIdBigInt = () => {
    try {
      return BigInt(eventId);
    } catch {
      throw new Error("This is fixture data - there's no real event id to write against.");
    }
  };

  return (
    <div>
      <Eyebrow>+ ACTIONS</Eyebrow>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <WriteActionButton
          label="Checkpoint"
          disabled={checkpointDisabled}
          disabledReason={checkpointDisabled ? "Only applies to a Depeg event that's still Proposed." : undefined}
          prepare={() => prepareCheckpointCure(eventIdBigInt())}
          confirm={(tx, signer) => confirmCheckpointCure(tx, signer)}
        />
        <WriteActionButton
          label="Finalize"
          disabled={finalizeDisabled}
          disabledReason={finalizeDisabled ? "Only applies to an event that's still Proposed." : undefined}
          prepare={() => prepareFinalize(eventIdBigInt())}
          confirm={(tx, signer) => confirmFinalize(tx, signer)}
        />
      </div>
      <p className="mt-4 font-mono text-xs text-cyber-tin">
        Trigger (paying out an affected market) belongs here per series, once feat/markets lands - not as
        one global button.
      </p>
    </div>
  );
}

/**
 * DEV-ONLY FIXTURE DATA. Never real. Never shown in a production build.
 *
 * Loaded exclusively via a dynamic `import()` inside an
 * `if (process.env.NODE_ENV !== "production")` branch in
 * app/event/[id]/EventPageClient.tsx - that's what lets the bundler
 * strip this whole module (and every string in it) out of a
 * production build entirely, not just hide it behind a runtime check.
 * A real numeric event_id never reaches this file in any environment.
 *
 * Covers the four fixture routes (/event/fixture-proposed,
 * -challenged, -cured, -declared), each exercising a different part
 * of the screen: the challenge-window countdown and both write
 * buttons (Proposed), the ruling countdown (Challenged -> this app's
 * Escalated state - see FIXTURE_CHALLENGED's own comment), and each
 * final outcome (Cured, Declared).
 */
import type { EventPageData } from "./event-data";
import type { EventRecord, CureProgress } from "./contracts/event-registry";

const FIXTURE_ASSET = "CDUMMY00000000000000000000000000000000000000000000FIXTUR";

function baseRecord(overrides: Partial<EventRecord>): EventRecord {
  return {
    id: BigInt(999_999),
    asset: FIXTURE_ASSET,
    kind: { tag: "IssuerFreeze", values: undefined },
    def_version: 1,
    tier: 1,
    state: { tag: "Proposed", values: undefined },
    window_start: BigInt(1_790_000_000),
    proposed_at: BigInt(1_790_000_000),
    escalated_at: undefined,
    declared_at: undefined,
    evidence_hash: Buffer.alloc(32),
    proposer: "GDFIXTUREPROPOSERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    bond: BigInt(0),
    ...overrides,
  };
}

const CHALLENGE_SECS = BigInt(86_400); // 24h, matching a typical def.challenge_secs.
const RULING_DEADLINE_SECS = BigInt(1_209_600); // 14 days, Section 23 default.

const NOW_FIXTURE = BigInt(Math.floor(Date.now() / 1000));

const FIXTURE_DEFINITION_SENTENCE =
  "Issuer freeze: clawbacks or authorization revocations above 5% of supply within 7 days, or more than 2 revocations in that window.";

/** Proposed, still inside its challenge window - exercises the countdown-to-challenge-deadline and both the Checkpoint and Finalize buttons (Finalize will itself reject with "challenge window open," shown in plain words, same as the real contract would). */
export const FIXTURE_PROPOSED: EventPageData = {
  proposal: {
    status: "ok",
    value: {
      record: baseRecord({ proposed_at: NOW_FIXTURE - BigInt(3_600) }),
      assetCode: "DEMOUSD",
      definitionSentence: FIXTURE_DEFINITION_SENTENCE,
    },
  },
  countdown: { status: "ok", value: { phase: "challenge", deadline: NOW_FIXTURE - BigInt(3_600) + CHALLENGE_SECS } },
  cureProgress: { status: "ok", value: null },
};

/**
 * This app's EventState::Escalated - the contract never actually sets
 * EventState::Challenged (challenge() transitions straight to
 * Escalated; the Challenged variant exists in the enum but is unused
 * in this build, confirmed by grepping the contract source). Named
 * "fixture-challenged" to match the plain-language action (someone
 * challenged the proposal) rather than the contract's internal state
 * name. Exercises the ruling-deadline countdown.
 */
export const FIXTURE_CHALLENGED: EventPageData = {
  proposal: {
    status: "ok",
    value: {
      record: baseRecord({
        state: { tag: "Escalated", values: undefined },
        proposed_at: NOW_FIXTURE - BigInt(90_000),
        escalated_at: NOW_FIXTURE - BigInt(7_200),
      }),
      assetCode: "DEMOUSD",
      definitionSentence: FIXTURE_DEFINITION_SENTENCE,
    },
  },
  countdown: {
    status: "ok",
    value: { phase: "ruling", deadline: NOW_FIXTURE - BigInt(7_200) + RULING_DEADLINE_SECS },
  },
  cureProgress: { status: "ok", value: null },
};

const CURED_CURE_PROGRESS: CureProgress = {
  recorded: BigInt(72),
  any_below_threshold: false,
  any_missing: false,
};

/** Cured - a Depeg-style final outcome where the price recovered, exercising the "Cured" result display and a populated CureProgress. */
export const FIXTURE_CURED: EventPageData = {
  proposal: {
    status: "ok",
    value: {
      record: baseRecord({
        kind: { tag: "Depeg", values: undefined },
        state: { tag: "Cured", values: undefined },
        proposed_at: NOW_FIXTURE - BigInt(200_000),
      }),
      assetCode: "DEMOUSD",
      definitionSentence:
        "Depeg: below 0.95 of peg for 72 hours, up to 6 missing hours allowed.",
    },
  },
  countdown: { status: "ok", value: { phase: "closed" } },
  cureProgress: { status: "ok", value: CURED_CURE_PROGRESS },
};

/** Declared - the final, payout-triggering outcome, exercising the "Declared" result display with its declared_at timestamp. */
export const FIXTURE_DECLARED: EventPageData = {
  proposal: {
    status: "ok",
    value: {
      record: baseRecord({
        state: { tag: "Declared", values: undefined },
        proposed_at: NOW_FIXTURE - BigInt(200_000),
        declared_at: NOW_FIXTURE - BigInt(100_000),
      }),
      assetCode: "DEMOUSD",
      definitionSentence: FIXTURE_DEFINITION_SENTENCE,
    },
  },
  countdown: { status: "ok", value: { phase: "closed" } },
  cureProgress: { status: "ok", value: null },
};

export const EVENT_FIXTURES: Record<string, EventPageData> = {
  "fixture-proposed": FIXTURE_PROPOSED,
  "fixture-challenged": FIXTURE_CHALLENGED,
  "fixture-cured": FIXTURE_CURED,
  "fixture-declared": FIXTURE_DECLARED,
};

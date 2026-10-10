import { Buffer } from "buffer";
import { Address } from "@stellar/stellar-sdk";
import {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
  Result,
  Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract";
import type {
  u32,
  i32,
  u64,
  i64,
  u128,
  i128,
  u256,
  i256,
  Option,
  Timepoint,
  Duration,
} from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";

if (typeof window !== "undefined") {
  //@ts-ignore Buffer exists
  window.Buffer = window.Buffer || Buffer;
}


export const networks = {
  testnet: {
    networkPassphrase: "Test SDF Network ; September 2015",
    contractId: "CD73S5ZPCPPPI2WSSUMGMEETM7YUSLDNQRHQEZNELB3NBHXJWYAGJEXE",
  }
} as const

export const Errors = {
  1: {message:"AlreadyInitialized"},
  2: {message:"NotInitialized"},
  /**
   * Never actually returned by any call in this contract: every
   * authorization check (`add_asset`, `update_asset`, `set_formula`,
   * `post_signals`, `dispute_signals`, `resolve_signal_dispute`,
   * `set_event_band`, `clear_event_band`, `set_event_in_progress`)
   * goes through Soroban's native `Address::require_auth()`, which
   * traps the host call directly rather than returning a `Result`
   * this contract could wrap in `Error::Unauthorized`. Kept for
   * `technical-doc.md` Section 14 code-number compatibility; see
   * `missing_auth_traps_natively_rather_than_returning_unauthorized`
   * in test.rs and the PR's "Review fixes" section for why this is
   * documented as unreachable rather than tested as reachable.
   */
  3: {message:"Unauthorized"},
  4: {message:"Paused"},
  5: {message:"MathOverflow"},
  100: {message:"UnknownAsset"},
  101: {message:"KeeperNotActive"},
  102: {message:"WrongEpoch"},
  103: {message:"EpochAlreadyPosted"},
  104: {message:"SanityBoundFailed"},
  105: {message:"AmmCrossCheckFailed"},
  106: {message:"DisputeWindowClosed"},
  107: {message:"WeightsInvalid"},
  108: {message:"ReferenceImmutable"},
  109: {message:"ReferenceRateUnavailable"},
  /**
   * Distinct from `SanityBoundFailed` (104), which is about one posted
   * `SignalSet`'s fields; this is about computing the score from the
   * ring (not enough history, or a required window read came back
   * empty), a different failure mode a caller may want to handle
   * differently (for example: retry later vs. a permanently bad
   * posting). Review item "Aggregation failures must not reuse
   * SanityBoundFailed."
   */
  110: {message:"AggregationFailed"},
  /**
   * `add_asset` / `update_asset` reject `Reference::Asset` in v1
   * (review decision D3): no USD rate is defined anywhere in the spec
   * for an asset pegged reference (see the PR's "Spec deviations").
   */
  111: {message:"ReferenceNotSupported"},
  /**
   * ADR-010 (feat/staking, issue #4 fix): `resolve_signal_dispute_timeout`
   * called before `SIGNAL_DISPUTE_RULING_SECS` has passed since the
   * dispute opened. Named to match ADR-002's `RulingDeadlineNotReached`
   * precedent for the analogous event-ruling timeout.
   */
  112: {message:"RulingDeadlineNotReached"},
  /**
   * technical-doc.md Section 5.9 S1: `sub_epoch_secs` set to a value
   * outside the allowed set, or one that does not divide 3,600
   * evenly.
   */
  113: {message:"InvalidSubEpochInterval"},
  /**
   * technical-doc.md Section 5.9 S4: `build_hour` called while at
   * least one of the hour's sub-epochs is still Pending or Disputed,
   * i.e. not yet Final, permanently missing, or rejected.
   */
  114: {message:"SubEpochNotReady"},
  /**
   * technical-doc.md Section 5.9 S2: an hour is posted through
   * exactly one path, sub-epoch or hourly fallback, never both. A
   * sub-epoch post against an hour already posted through the
   * fallback path, or a fallback post against an hour that already
   * has a sub-epoch posted, both return this.
   */
  115: {message:"HourAlreadyPosted"}
}

















export type Band = {tag: "Normal", values: void} | {tag: "Watch", values: void} | {tag: "Warning", values: void} | {tag: "Distress", values: void} | {tag: "Event", values: void};


/**
 * The latest computed risk score for an asset. technical-doc.md Section 4.2.
 */
export interface RiskScore {
  band: Band;
  epoch: u64;
  formula_version: u32;
  /**
 * 0..=100.
 */
score: u32;
  stale: boolean;
}


/**
 * One epoch slot of the per asset ring buffer that Tier 1 checks, the
 * cover gate and the 24 hour and 7 day aggregates read in a single entry,
 * instead of separate `Signals(asset, epoch)` entries.
 * technical-doc.md Section 5.8, ADR-005.
 */
export interface RingSlot {
  auth_revocations: u32;
  clawback_amount: i128;
  endpoint: EndpointStatus;
  epoch: u64;
  liquidity_2pct: i128;
  peg_ratio: i128;
  /**
 * Ledger timestamp after which a `Pending` slot reads as Final.
 */
pending_until: u64;
  /**
 * Section 5.9 S4/S5 (v1.5): how many of this hour's own
 * sub-epochs (0 to 12, never more, `SUB_RING_SLOTS`'s own upper
 * bound on `sub_epochs_per_hour`) currently contribute to this
 * slot's own fields, when this hour is on the sub-epoch posting
 * path. `None` for an hour on the hourly fallback path (whose
 * `peg_ratio` etc. are the real, single posted reading, contested
 * or not, with no sub-epoch coverage concept) and for an hour
 * that has never had a sub-epoch posted at all.
 * 
 * `Some(n)` tells two things apart that `state` alone cannot:
 * which posting path produced a `Disputed` slot (only the
 * sub-epoch path ever sets this to `Some`; an hour disputed
 * through the hourly fallback, whose `peg_ratio` IS the
 * contested value itself, stays `None`), and whether a `Disputed`
 * sub-epoch-path slot still holds usable data from its OTHER,
 * non-disputed sub-epochs (`Some(n > 0)`) or genuinely none at
 * all (`Some(0)`, every posted sub-epoch currently disputed) —
 * deliberately not read off `peg_ratio` or `pending_until`, since
 * both already c
 */
provisional_sub_coverage: Option<u32>;
  redemption_net: i128;
  state: SlotState;
  supply: i128;
  supply_change_bps: i32;
}


/**
 * Identifies one sub-epoch at the posting/dispute API boundary:
 * `hour`, and `sub`, its position within that hour under whichever
 * `sub_epoch_secs` governed it. technical-doc.md Section 5.9 S2.
 * `Sub(asset)`'s own ring stores a different identity internally
 * (`sub_start`, the sub-epoch's absolute start time, Section 5.9 S3),
 * since what `sub` means depends on an interval that can later
 * change; `SubEpoch` is the human-meaningful pair a keeper posts
 * against, converted internally to `sub_start`.
 */
export interface SubEpoch {
  hour: u64;
  sub: u32;
}

export type Reference = {tag: "Usd", values: void} | {tag: "Fiat", values: readonly [string, FxRateSource]} | {tag: "Asset", values: readonly [string]};


/**
 * One epoch's measured signals for one asset. technical-doc.md Section 4.1.
 */
export interface SignalSet {
  /**
 * Sourced only from `Staking::aggregate`. RiskOracle overwrites this
 * field on `post_signals` and `finalize_endpoint`; any keeper supplied
 * value is ignored, so keepers post `Unknown` (ADR-005).
 */
endpoint: EndpointStatus;
  epoch: u64;
  /**
 * Hash of raw inputs, for recomputation.
 */
inputs_hash: Buffer;
  issuer_actions: IssuerActions;
  /**
 * Depth within 2% of peg, USDC units.
 */
liquidity_2pct: i128;
  /**
 * TWAP price / reference, SCALE 1e7.
 */
peg_ratio: i128;
  /**
 * 10th percentile of the volume weighted price series in the window,
 * divided by the reference, SCALE 1e7. A single wick cannot move it
 * (ADR-005).
 */
peg_ratio_p10: i128;
  /**
 * Ledger timestamp.
 */
posted_at: u64;
  poster: string;
  /**
 * Net burned minus issued this epoch, asset units.
 */
redemption_net: i128;
  /**
 * Total circulating supply, asset units. Keeper posted from ledger asset
 * stats; SEP-41 has no `total_supply`, so it cannot be cross checked
 * onchain (ADR-005).
 */
supply: i128;
  /**
 * vs previous epoch.
 */
supply_change_bps: i32;
}

/**
 * Finality of one ring buffer slot. technical-doc.md Section 5.8.
 */
export type SlotState = {tag: "Empty", values: void} | {tag: "Pending", values: void} | {tag: "Disputed", values: void} | {tag: "Final", values: void};


/**
 * Configuration for one issued asset covered by the RiskOracle.
 * technical-doc.md Section 4.1.
 */
export interface AssetConfig {
  /**
 * Optional Soroban AMM price adapters (`PriceAdapter`, Section 3.3).
 */
amm_adapters: Array<string>;
  /**
 * Stellar Asset Contract address of the issued asset.
 */
asset: string;
  enabled: boolean;
  /**
 * FX adapter (`FxAdapter`, Section 3.3). Required when `reference` is
 * `Fiat`, `None` otherwise.
 */
fx_adapter: Option<string>;
  /**
 * For SEP-1 / SEP-24 probing.
 */
home_domain: string;
  /**
 * Classic issuer account (G...).
 */
issuer: string;
  /**
 * Issuer account flags. IssuerFreeze definitions can only be registered
 * when these make a freeze possible (ADR-006).
 */
issuer_flags: IssuerFlags;
  /**
 * In USDC units. A Depeg window counts only if the median
 * `liquidity_2pct` of the 7 days before the window started is at least
 * this value. Never compared against live liquidity (ADR-005).
 */
min_liquidity: i128;
  /**
 * What the asset should be worth. Fixed at `add_asset`: `update_asset`
 * rejects any change, so every event definition that pins it stays
 * valid (ADR-006).
 */
reference: Reference;
}


/**
 * The classic issuer flags that make an issuer freeze possible. An
 * IssuerFreeze definition can be registered only if at least one is set.
 * technical-doc.md Section 4.1, ADR-006.
 */
export interface IssuerFlags {
  /**
 * AUTH_REVOCABLE: the issuer can revoke a holder's authorization.
 */
auth_revocable: boolean;
  /**
 * CLAWBACK_ENABLED: the issuer can claw back balances.
 */
clawback_enabled: boolean;
}

/**
 * Which FX rate a `Reference::Fiat` is priced against. Matters wherever an
 * official rate and a market (parallel) rate diverge, for example ARS.
 * technical-doc.md Section 4.1, ADR-006.
 */
export type FxRateSource = {tag: "Official", values: void} | {tag: "Market", values: void};


export interface IssuerActions {
  auth_revocations: u32;
  clawback_amount: i128;
  clawbacks: u32;
  flag_changes: u32;
}

export type EndpointStatus = {tag: "Unknown", values: void} | {tag: "Up", values: void} | {tag: "Degraded", values: void} | {tag: "Down", values: void};


/**
 * Per asset sub-epoch configuration. technical-doc.md Section 15.1
 * `SubEpochConfig(asset)`, Section 5.9 S1. `sub_epoch_secs` is the
 * value currently in effect; `pending_sub_epoch_secs` and
 * `effective_from_hour` describe a queued change that has not yet
 * taken effect (both `None` when no change is pending). A change
 * never applies before `effective_from_hour`, so no sub-epoch
 * already posted, or postable before that boundary, is ever
 * reinterpreted under a different length.
 */
export interface SubEpochConfig {
  effective_from_hour: Option<u64>;
  pending_sub_epoch_secs: Option<u64>;
  sub_epoch_secs: u64;
}

export interface Client {
  /**
   * Construct and simulate a band transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  band: ({asset}: {asset: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Band>>>

  /**
   * Construct and simulate a live transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * technical-doc.md Section 5.9 S5, 12.1 (v1.5): read-only, no auth.
   * The newest posted sub-epoch and its effective state. Unlike
   * `latest`, which keeps returning the newest HOUR's `SignalSet`
   * (`Series`'s `require_holding` valuation and every existing
   * integration already depend on that exact meaning, Section 5.9
   * S5), `live` surfaces Pending, challengeable sub-epoch data; the
   * app shows it as "Live" next to `latest()`/`score()`'s
   * "Confirmed" values. Never used for `require_holding` or any
   * other payout-adjacent valuation.
   */
  live: ({asset}: {asset: string}, options?: MethodOptions) => Promise<AssembledTransaction<Option<readonly [SubEpoch, SignalSet, SlotState]>>>

  /**
   * Construct and simulate a ring transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * technical-doc.md Section 5.8, 12.1: one storage read, oldest slot
   * first. See `storage::get_ring`'s doc comment for exactly what
   * "oldest first" means once the buffer has wrapped.
   */
  ring: ({asset}: {asset: string}, options?: MethodOptions) => Promise<AssembledTransaction<Array<RingSlot>>>

  /**
   * Construct and simulate a score transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * technical-doc.md Section 12.1, 6. Review item C1: a PURE read.
   * Returns whatever `RiskScore` is currently stored, with `stale`
   * recomputed fresh against the clock (so a score that was fresh
   * when last written but has since gone quiet is reported stale
   * without needing a write to say so). Never calls
   * `storage::set_score` or any other write; the actual computation
   * happens in `recompute_score`, called from `post_signals`, the
   * finality sweep, and `finalize_endpoint` (see those for exactly
   * when).
   * 
   * Review decision D1: the stored `band` is always the plain
   * hysteresis band, computed with no knowledge of the event-in-
   * progress flag (see `recompute_score`), so that flipping the
   * flag off is never confused with a genuine new epoch of evidence
   * for the hysteresis streak. The "forced to at least Distress
   * while in progress" override is applied here instead, on every
   * read, which also makes it take effect immediately on
   * `set_event_in_progress` with no recompute required.
   */
  score: ({asset}: {asset: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<RiskScore>>>

  /**
   * Construct and simulate a assets transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  assets: (options?: MethodOptions) => Promise<AssembledTransaction<Array<string>>>

  /**
   * Construct and simulate a latest transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  latest: ({asset}: {asset: string}, options?: MethodOptions) => Promise<AssembledTransaction<Option<SignalSet>>>

  /**
   * Construct and simulate a signals transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  signals: ({asset, epoch}: {asset: string, epoch: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Option<SignalSet>>>

  /**
   * Construct and simulate a is_final transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Review item C5: whether epoch `epoch` is EFFECTIVELY final right
   * now: its stored state is `Final`, or it is `Pending` and
   * `pending_until` has already passed. `false` for a missing epoch.
   */
  is_final: ({asset, epoch}: {asset: string, epoch: u64}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a is_stale transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  is_stale: ({asset}: {asset: string}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a add_asset transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * technical-doc.md Section 12.1. Rejects an asset that is already
   * registered (`update_asset` is for changing one). Review decision
   * D3: also rejects `Reference::Asset` (no USD rate is defined
   * anywhere in the spec for an asset pegged reference; see the PR's
   * "Spec deviations").
   */
  add_asset: ({cfg}: {cfg: AssetConfig}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a build_hour transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * technical-doc.md Section 5.9 S4 (v1.5): permissionless. Builds
   * `hour` if every one of its sub-epochs is Final, permanently
   * missing, or rejected; `post_sub_signals` already attempts this
   * inline on every post, so this exists for anyone to trigger a
   * build that is ready but that no further posting has happened to
   * trigger automatically (the same role `finalize_endpoint` plays
   * for the hourly backward finality scan). Returns
   * `SubEpochNotReady` if at least one sub-epoch is still Pending
   * or Disputed; a never-posted hour (no sub-epoch at all, not even
   * a missing one within an active interval) is equally not ready,
   * since there is nothing to build from.
   */
  build_hour: ({asset, hour}: {asset: string, hour: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a initialize transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * technical-doc.md Section 12.1.
   */
  initialize: ({governor, registry, staking}: {governor: string, registry: string, staking: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a check_stale transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Re-review item C7 (lead decision): `asset_stale` now means "the
   * asset TRANSITIONED into stale", not "a newly observed epoch
   * happened to already be stale on arrival" (the old design's
   * condition, which never fired at all for the realistic "keepers
   * stopped posting" case, since nothing new ever arrives to
   * trigger it). Permissionless: evaluates staleness against the
   * epoch of the STORED score (never `newest_final`, which can run
   * ahead of the stored score when `recompute_score` short
   * circuits without writing, e.g. a sticky `Event` band or not
   * enough history yet), emits `asset_stale` once if the asset is
   * stale and `stale_announced` is not already set, sets the flag,
   * and returns the current stale state either way. Calling this
   * again while still stale emits nothing. Every state changing
   * call that touches an asset runs the same check internally (see
   * `check_stale_internal`), so a late backfill that is stale on
   * arrival also emits, once, without needing anyone to call this
   * explicitly; this function exists for a monitor tha
   */
  check_stale: ({asset}: {asset: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<boolean>>>

  /**
   * Construct and simulate a first_epoch transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * PR #25 review: read-only, no auth. The first epoch ever
   * successfully posted for this asset. `EventRegistry`'s own
   * Tier 1 Depeg and IssuerFreeze history baselines need this for
   * the same reason `RiskOracle`'s own score and `median_liquidity`
   * do: the newest epoch's own absolute number is always far
   * larger than any window length on a real network, so it alone
   * can never tell a brand-new asset from one with years of
   * history. `None` before the asset's first posting.
   */
  first_epoch: ({asset}: {asset: string}, options?: MethodOptions) => Promise<AssembledTransaction<Option<u64>>>

  /**
   * Construct and simulate a set_formula transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * technical-doc.md Section 12.1, 6.2. `set_formula` rejects any
   * weight set that does not sum to 10,000.
   */
  set_formula: ({version, weights, params}: {version: u32, weights: Array<u32>, params: Map<string, i128>}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a asset_config transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  asset_config: ({asset}: {asset: string}, options?: MethodOptions) => Promise<AssembledTransaction<Option<AssetConfig>>>

  /**
   * Construct and simulate a newest_epoch transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * PR #15 review, finding F4: read-only, no auth. Wraps the
   * existing `storage::get_newest_epoch_pub`, which reads the
   * dedicated `RingNewest` key directly rather than the newest
   * ring POSITION's own stored epoch. The two disagree exactly
   * when the newest position is `Empty` (its epoch was overturned
   * and not yet reposted): the position's slot reports epoch `0`
   * (`empty_slot()`'s default), while `RingNewest` still correctly
   * reports the real newest epoch ever written. `EventRegistry`
   * needs the latter for its own `slot_for_epoch` arithmetic
   * (`ring()`'s layout is "oldest first, ending at RingNewest");
   * reading the former made every subsequent `slot_for_epoch` call
   * miss, misclassifying every cure-window epoch as permanently
   * missing.
   */
  newest_epoch: ({asset}: {asset: string}, options?: MethodOptions) => Promise<AssembledTransaction<Option<u64>>>

  /**
   * Construct and simulate a post_signals transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * technical-doc.md Section 12.1, 5.2, 5.3, 11.3.
   * 
   * Checks keeper eligibility against `Staking`, applies the full
   * Section 11.3 sanity bounds, cross checks configured `PriceAdapter`s,
   * and sources `endpoint` only from `Staking.aggregate` (never the
   * keeper's payload). `s.endpoint` is only ever a placeholder on input.
   */
  post_signals: ({keeper, asset, s}: {keeper: string, asset: string, s: SignalSet}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a update_asset transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * technical-doc.md Section 12.1: "rejects a change to cfg.reference".
   * Review decision D3: also rejects `Reference::Asset`, same as
   * `add_asset` (an existing asset can never have had this reference
   * in the first place, since `add_asset` rejects it, but the check
   * is repeated here rather than relying on that invariant holding
   * forever).
   */
  update_asset: ({asset, cfg}: {asset: string, cfg: AssetConfig}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a disable_asset transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * technical-doc.md Section 12.1.
   */
  disable_asset: ({asset}: {asset: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a reference_rate transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * technical-doc.md Section 12.1: reference to USD, SCALE 1e7. `Usd`
   * is always `SCALE`; `Fiat` reads the asset's `FxAdapter` on the
   * reference's recorded basis and fails closed on a stale or missing
   * rate; `Asset` has no USD rate defined anywhere in the spec, so this
   * fails rather than guessing one (see the PR's "Spec deviations").
   */
  reference_rate: ({asset}: {asset: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>

  /**
   * Construct and simulate a set_event_band transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * technical-doc.md Section 12.1, 8.5, 8.8. Auth: the registry
   * contract itself (the `registry` address `RiskOracle` was
   * initialized with), per Section 16.1's contract-to-contract auth
   * pattern.
   */
  set_event_band: ({asset}: {asset: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a sub_peg_ratios transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * technical-doc.md Section 5.9 S5 (v1.5): read-only, no auth. Each
   * of `hour`'s sub-epochs' own `peg_ratio`, in `sub` order, `None`
   * for a sub-epoch that is not posted or not yet effectively Final
   * or Pending (the same "Pending or Final" convention
   * `EventRegistry.cover_gate`'s existing `RecentDepeg` check
   * already reads from `Ring(asset)`, extended to `Sub(asset)` for
   * an hour that has not built yet). `EventRegistry`'s own
   * `cover_gate` calls this only for the current, not-yet-built
   * hour (or hours, in the up-to-2h window an hour can stay
   * waiting): every already-built hour inside its own trailing
   * window is still read through `ring()` exactly as before this
   * revision.
   */
  sub_peg_ratios: ({asset, hour}: {asset: string, hour: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Array<Option<i128>>>>

  /**
   * Construct and simulate a dispute_signals transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * technical-doc.md Section 12.1, 5.4, 7.8.
   * 
   * Records the dispute and locks the disputer's bond in `Staking`.
   * Only the signal dispute STATE lives here; the bond itself is held
   * and later split by `Staking` on instruction from
   * `resolve_signal_dispute`.
   */
  dispute_signals: ({disputer, asset, epoch, alt_hash}: {disputer: string, asset: string, epoch: u64, alt_hash: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a clear_event_band transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * technical-doc.md Section 12.1, 8.8.
   */
  clear_event_band: ({asset}: {asset: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a effective_window transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Review item C5: a window read of effective state per epoch, for
   * `EventRegistry`'s Tier 1 checks (Section 8.2), so it can learn
   * which epochs in a window are final without one call per epoch.
   * Missing epochs read `None`, the same convention as `ring`'s
   * underlying storage.
   */
  effective_window: ({asset, start_epoch, count}: {asset: string, start_epoch: u64, count: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Array<Option<SlotState>>>>

  /**
   * Construct and simulate a median_liquidity transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * technical-doc.md Section 11.1: median of the newest 168 slots'
   * `liquidity_2pct`, for the asset wide cover cap. Missing slots in
   * the window are excluded, not treated as zero liquidity, so a short
   * run of missing epochs does not crater the cap the way real zero
   * liquidity would.
   */
  median_liquidity: ({asset}: {asset: string}, options?: MethodOptions) => Promise<AssembledTransaction<i128>>

  /**
   * Construct and simulate a post_sub_signals transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * technical-doc.md Section 5.9 S2 (v1.5). Posts a sub-epoch,
   * keyed by `(hour, sub)` instead of a single `epoch`. Mirrors
   * `post_signals`'s own checks (keeper eligibility, sanity bounds,
   * AMM cross check), disputable for `signal_dispute_secs` exactly
   * as the hourly path already specifies. Recomputes the hour's own
   * provisional roll-up on every call, and attempts the hour's
   * build inline, the same way `post_signals` already
   * inline-triggers the hourly finality scan.
   */
  post_sub_signals: ({keeper, asset, hour, sub, s}: {keeper: string, asset: string, hour: u64, sub: u32, s: SignalSet}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a sub_epoch_config transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * technical-doc.md Section 5.9 S1 (v1.5): read-only, no auth. The
   * asset's sub-epoch configuration, including a pending change not
   * yet in effect.
   */
  sub_epoch_config: ({asset}: {asset: string}, options?: MethodOptions) => Promise<AssembledTransaction<Option<SubEpochConfig>>>

  /**
   * Construct and simulate a event_in_progress transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * technical-doc.md Section 12.1 (feat/event-registry design note,
   * review item D6): read-only, no auth. Lets `EventRegistry` assert
   * invariant E4 (its own active-event count agrees with this flag)
   * directly, rather than inferring the flag only through its one
   * visible effect on `band()`'s own Distress floor.
   */
  event_in_progress: ({asset}: {asset: string}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a finalize_endpoint transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * technical-doc.md Section 12.1, 7.4. Reads `Staking.aggregate` and
   * books it into the epoch's ring slot and `Signals` entry if
   * `post_signals` had not already resolved one by the time it closed;
   * then calls `Staking.settle_probes` exactly once regardless, per
   * Section 7.4's "booked exactly once" requirement.
   */
  finalize_endpoint: ({asset, epoch}: {asset: string, epoch: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a overturned_signals transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Review item C4: the `SignalSet` an overturned epoch's posting had
   * before `resolve_signal_dispute` moved it out of `signals`'s live
   * key, kept for audit. `None` if `epoch` was never overturned (or
   * was overturned, reposted, and overturned again, which keeps only
   * the most recent overturn, not a full history of every attempt).
   */
  overturned_signals: ({asset, epoch}: {asset: string, epoch: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Option<SignalSet>>>

  /**
   * Construct and simulate a set_sub_epoch_secs transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * technical-doc.md Section 5.9 S1, 16, 17.4 (v1.5). Auth: governor,
   * the same `SetParam`-style path every other parameter in Section
   * 23 already uses; no new role or action type is needed. Takes
   * effect from the NEXT hour boundary only (never the current,
   * possibly-in-progress hour), so no sub-epoch already posted, or
   * postable before that boundary, is ever reinterpreted under a
   * different length.
   */
  set_sub_epoch_secs: ({asset, value}: {asset: string, value: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a dispute_sub_signals transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * technical-doc.md Section 5.9 S2, S3 (v1.5). Mirrors
   * `dispute_signals` exactly, against `Sub(asset)`'s own ring: on
   * dispute, the sub-epoch's record is copied out to
   * `SubDispute(asset, hour, sub)` (so `Sub(asset)`'s fixed 60 slot
   * ring can keep rotating underneath a ruling that takes up to
   * `SIGNAL_DISPUTE_RULING_SECS`), and the HOUR's own `Ring(asset)`
   * slot moves to `Disputed` via `refresh_waiting_hour`.
   */
  dispute_sub_signals: ({disputer, asset, hour, sub, alt_hash}: {disputer: string, asset: string, hour: u64, sub: u32, alt_hash: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_event_in_progress transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Review decision D1, not in the original Section 12.1 list. Auth:
   * the registry contract, same pattern as `set_event_band` /
   * `clear_event_band` (Section 16.1). While `true`, `score()` floors
   * the band at `Distress` on every read (Section 6.3's "forced to
   * Distress if a credit event... is Proposed, Challenged or
   * Escalated"), independent of the hysteresis-protected band
   * actually stored; `RiskOracle` never calls into `EventRegistry` to
   * check this itself, matching the instruction that "the oracle
   * never calls the registry" — this is pushed in, the same
   * direction `set_event_band` already works.
   */
  set_event_in_progress: ({asset, in_progress}: {asset: string, in_progress: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a resolve_signal_dispute transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * technical-doc.md Section 12.1, 5.4, 7.8. Auth: the committee
   * address, read fresh from `Governor.committee()` on every call (the
   * committee can rotate; `RiskOracle` never caches it).
   */
  resolve_signal_dispute: ({asset, epoch, keeper_wins, reason}: {asset: string, epoch: u64, keeper_wins: boolean, reason: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a resolve_sub_signal_dispute transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * technical-doc.md Section 5.9 S2, S4 (v1.5). Mirrors
   * `resolve_signal_dispute` exactly, against `Sub(asset)`. On
   * `keeper_wins`, the sub-epoch's slot becomes Final; on the
   * disputer winning, it clears back to Empty (the overturned
   * sub-epoch's own `SubSignals` entry is left in place for audit,
   * the same way `Signals(asset, epoch)` is kept but no longer
   * live after an hourly overturn) and can be reposted. Either way,
   * `refresh_waiting_hour` re-derives the HOUR's own `Ring(asset)`
   * state from every sub-epoch's current disposition, which may
   * move the hour out of `Disputed` (if no other sub-epoch in it is
   * still disputed) and, if this was the last undecided sub-epoch,
   * trigger the hour's build.
   */
  resolve_sub_signal_dispute: ({asset, hour, sub, keeper_wins, reason}: {asset: string, hour: u64, sub: u32, keeper_wins: boolean, reason: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a resolve_sub_dispute_timeout transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * technical-doc.md Section 5.9 S2 (v1.5). Mirrors
   * `resolve_signal_dispute_timeout` exactly, against
   * `SubDispute(asset, hour, sub)`: the committee's silence is read
   * the same way for a sub-epoch dispute as for an hourly one, the
   * keeper's posting stands.
   */
  resolve_sub_dispute_timeout: ({asset, hour, sub}: {asset: string, hour: u64, sub: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a sub_peg_ratios_in_span_batch transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Section 5.9 S5 (v1.5, footprint-fix revision): `EventRegistry.
   * cover_gate`'s own `RecentDepeg` check, for unbuilt hours still
   * INSIDE `Sub(asset)`'s own 5-hour span (`SUB_RING_SLOTS *
   * SUB_EPOCH_GRID_SECS`), never calling this for an hour outside
   * it (the caller's own job to tell apart, using `newest_epoch`
   * and those same constants: this function trusts its caller
   * completely and does not re-check). Unlike `sub_peg_ratios` /
   * the since-removed `sub_peg_ratios_batch`, this NEVER reads
   * `HeldHour`: every hour it is asked about is assumed still
   * physically present in `Sub(asset)`'s own ring, so `HeldHour` (a
   * write-path, build/dispute-only concern, never a gate concern,
   * per the Section 5.9 S5 footprint-fix review) plays no part
   * here. One cross-contract call for every hour the gate needs,
   * touching exactly ONE key (`Sub(asset)`, read once regardless of
   * how many hours or sub-epochs are requested) rather than one key
   * per hour: this is what makes the gate's own footprint constant
   * regardless of how many hours are unbuilt (R10
   */
  sub_peg_ratios_in_span_batch: ({asset, hours}: {asset: string, hours: Array<u64>}, options?: MethodOptions) => Promise<AssembledTransaction<Array<Array<Option<i128>>>>>

  /**
   * Construct and simulate a resolve_signal_dispute_timeout transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * ADR-010 (issue #4 fix). Permissionless, callable once
   * `SIGNAL_DISPUTE_RULING_SECS` has passed since `dispute_signals`
   * opened this dispute, if the committee still has not ruled via
   * `resolve_signal_dispute`. Default outcome mirrors ADR-002's
   * rule for data backed claims: the keeper's posting stands (slot
   * `Final`, same as a `keeper_wins: true` committee ruling). "Both
   * bonds released in full, nobody slashed" (the task's own
   * wording): there is only one actual `BondKey::SignalDispute`
   * lock to release, the disputer's (technical-doc.md Section 24.2
   * notes a keeper has no symmetric per-signal bond in v1; only
   * `slash`, by address, ever touches a keeper's stake), so in
   * practice this means the disputer's bond is refunded
   * (`release_bond`, not `forfeit_bond`) AND the keeper's stake is
   * left untouched (no `slash` call either) — both parties come
   * out exactly as they would from a `keeper_wins: true` ruling,
   * which is the committee's silence being read as "no evidence
   * the posting was wrong", not as a loss for either side.
   */
  resolve_signal_dispute_timeout: ({asset, epoch}: {asset: string, epoch: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options: MethodOptions &
      Omit<ContractClientOptions, "contractId"> & {
        /** The hash of the Wasm blob, which must already be installed on-chain. */
        wasmHash: Buffer | string;
        /** Salt used to generate the contract's ID. Passed through to {@link Operation.createCustomContract}. Default: random. */
        salt?: Buffer | Uint8Array;
        /** The format used to decode `wasmHash`, if it's provided as a string. */
        format?: "hex" | "base64";
      }
  ): Promise<AssembledTransaction<T>> {
    return ContractClient.deploy(null, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAAAAAAAAAAAAAEYmFuZAAAAAEAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAEAAAPpAAAH0AAAAARCYW5kAAAAAw==",
        "AAAAAAAAAgd0ZWNobmljYWwtZG9jLm1kIFNlY3Rpb24gNS45IFM1LCAxMi4xICh2MS41KTogcmVhZC1vbmx5LCBubyBhdXRoLgpUaGUgbmV3ZXN0IHBvc3RlZCBzdWItZXBvY2ggYW5kIGl0cyBlZmZlY3RpdmUgc3RhdGUuIFVubGlrZQpgbGF0ZXN0YCwgd2hpY2gga2VlcHMgcmV0dXJuaW5nIHRoZSBuZXdlc3QgSE9VUidzIGBTaWduYWxTZXRgCihgU2VyaWVzYCdzIGByZXF1aXJlX2hvbGRpbmdgIHZhbHVhdGlvbiBhbmQgZXZlcnkgZXhpc3RpbmcKaW50ZWdyYXRpb24gYWxyZWFkeSBkZXBlbmQgb24gdGhhdCBleGFjdCBtZWFuaW5nLCBTZWN0aW9uIDUuOQpTNSksIGBsaXZlYCBzdXJmYWNlcyBQZW5kaW5nLCBjaGFsbGVuZ2VhYmxlIHN1Yi1lcG9jaCBkYXRhOyB0aGUKYXBwIHNob3dzIGl0IGFzICJMaXZlIiBuZXh0IHRvIGBsYXRlc3QoKWAvYHNjb3JlKClgJ3MKIkNvbmZpcm1lZCIgdmFsdWVzLiBOZXZlciB1c2VkIGZvciBgcmVxdWlyZV9ob2xkaW5nYCBvciBhbnkKb3RoZXIgcGF5b3V0LWFkamFjZW50IHZhbHVhdGlvbi4AAAAABGxpdmUAAAABAAAAAAAAAAVhc3NldAAAAAAAABMAAAABAAAD6AAAA+0AAAADAAAH0AAAAAhTdWJFcG9jaAAAB9AAAAAJU2lnbmFsU2V0AAAAAAAH0AAAAAlTbG90U3RhdGUAAAA=",
        "AAAAAAAAALF0ZWNobmljYWwtZG9jLm1kIFNlY3Rpb24gNS44LCAxMi4xOiBvbmUgc3RvcmFnZSByZWFkLCBvbGRlc3Qgc2xvdApmaXJzdC4gU2VlIGBzdG9yYWdlOjpnZXRfcmluZ2AncyBkb2MgY29tbWVudCBmb3IgZXhhY3RseSB3aGF0CiJvbGRlc3QgZmlyc3QiIG1lYW5zIG9uY2UgdGhlIGJ1ZmZlciBoYXMgd3JhcHBlZC4AAAAAAAAEcmluZwAAAAEAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAEAAAPqAAAH0AAAAAhSaW5nU2xvdA==",
        "AAAAAAAAA8N0ZWNobmljYWwtZG9jLm1kIFNlY3Rpb24gMTIuMSwgNi4gUmV2aWV3IGl0ZW0gQzE6IGEgUFVSRSByZWFkLgpSZXR1cm5zIHdoYXRldmVyIGBSaXNrU2NvcmVgIGlzIGN1cnJlbnRseSBzdG9yZWQsIHdpdGggYHN0YWxlYApyZWNvbXB1dGVkIGZyZXNoIGFnYWluc3QgdGhlIGNsb2NrIChzbyBhIHNjb3JlIHRoYXQgd2FzIGZyZXNoCndoZW4gbGFzdCB3cml0dGVuIGJ1dCBoYXMgc2luY2UgZ29uZSBxdWlldCBpcyByZXBvcnRlZCBzdGFsZQp3aXRob3V0IG5lZWRpbmcgYSB3cml0ZSB0byBzYXkgc28pLiBOZXZlciBjYWxscwpgc3RvcmFnZTo6c2V0X3Njb3JlYCBvciBhbnkgb3RoZXIgd3JpdGU7IHRoZSBhY3R1YWwgY29tcHV0YXRpb24KaGFwcGVucyBpbiBgcmVjb21wdXRlX3Njb3JlYCwgY2FsbGVkIGZyb20gYHBvc3Rfc2lnbmFsc2AsIHRoZQpmaW5hbGl0eSBzd2VlcCwgYW5kIGBmaW5hbGl6ZV9lbmRwb2ludGAgKHNlZSB0aG9zZSBmb3IgZXhhY3RseQp3aGVuKS4KClJldmlldyBkZWNpc2lvbiBEMTogdGhlIHN0b3JlZCBgYmFuZGAgaXMgYWx3YXlzIHRoZSBwbGFpbgpoeXN0ZXJlc2lzIGJhbmQsIGNvbXB1dGVkIHdpdGggbm8ga25vd2xlZGdlIG9mIHRoZSBldmVudC1pbi0KcHJvZ3Jlc3MgZmxhZyAoc2VlIGByZWNvbXB1dGVfc2NvcmVgKSwgc28gdGhhdCBmbGlwcGluZyB0aGUKZmxhZyBvZmYgaXMgbmV2ZXIgY29uZnVzZWQgd2l0aCBhIGdlbnVpbmUgbmV3IGVwb2NoIG9mIGV2aWRlbmNlCmZvciB0aGUgaHlzdGVyZXNpcyBzdHJlYWsuIFRoZSAiZm9yY2VkIHRvIGF0IGxlYXN0IERpc3RyZXNzCndoaWxlIGluIHByb2dyZXNzIiBvdmVycmlkZSBpcyBhcHBsaWVkIGhlcmUgaW5zdGVhZCwgb24gZXZlcnkKcmVhZCwgd2hpY2ggYWxzbyBtYWtlcyBpdCB0YWtlIGVmZmVjdCBpbW1lZGlhdGVseSBvbgpgc2V0X2V2ZW50X2luX3Byb2dyZXNzYCB3aXRoIG5vIHJlY29tcHV0ZSByZXF1aXJlZC4AAAAABXNjb3JlAAAAAAAAAQAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAQAAA+kAAAfQAAAACVJpc2tTY29yZQAAAAAAAAM=",
        "AAAAAAAAAAAAAAAGYXNzZXRzAAAAAAAAAAAAAQAAA+oAAAAT",
        "AAAAAAAAAAAAAAAGbGF0ZXN0AAAAAAABAAAAAAAAAAVhc3NldAAAAAAAABMAAAABAAAD6AAAB9AAAAAJU2lnbmFsU2V0AAAA",
        "AAAAAAAAAAAAAAAHc2lnbmFscwAAAAACAAAAAAAAAAVhc3NldAAAAAAAABMAAAAAAAAABWVwb2NoAAAAAAAABgAAAAEAAAPoAAAH0AAAAAlTaWduYWxTZXQAAAA=",
        "AAAAAAAAALpSZXZpZXcgaXRlbSBDNTogd2hldGhlciBlcG9jaCBgZXBvY2hgIGlzIEVGRkVDVElWRUxZIGZpbmFsIHJpZ2h0Cm5vdzogaXRzIHN0b3JlZCBzdGF0ZSBpcyBgRmluYWxgLCBvciBpdCBpcyBgUGVuZGluZ2AgYW5kCmBwZW5kaW5nX3VudGlsYCBoYXMgYWxyZWFkeSBwYXNzZWQuIGBmYWxzZWAgZm9yIGEgbWlzc2luZyBlcG9jaC4AAAAAAAhpc19maW5hbAAAAAIAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAAAAAAFZXBvY2gAAAAAAAAGAAAAAQAAAAE=",
        "AAAAAAAAAAAAAAAIaXNfc3RhbGUAAAABAAAAAAAAAAVhc3NldAAAAAAAABMAAAABAAAAAQ==",
        "AAAAAAAAARF0ZWNobmljYWwtZG9jLm1kIFNlY3Rpb24gMTIuMS4gUmVqZWN0cyBhbiBhc3NldCB0aGF0IGlzIGFscmVhZHkKcmVnaXN0ZXJlZCAoYHVwZGF0ZV9hc3NldGAgaXMgZm9yIGNoYW5naW5nIG9uZSkuIFJldmlldyBkZWNpc2lvbgpEMzogYWxzbyByZWplY3RzIGBSZWZlcmVuY2U6OkFzc2V0YCAobm8gVVNEIHJhdGUgaXMgZGVmaW5lZAphbnl3aGVyZSBpbiB0aGUgc3BlYyBmb3IgYW4gYXNzZXQgcGVnZ2VkIHJlZmVyZW5jZTsgc2VlIHRoZSBQUidzCiJTcGVjIGRldmlhdGlvbnMiKS4AAAAAAAAJYWRkX2Fzc2V0AAAAAAAAAQAAAAAAAAADY2ZnAAAAB9AAAAALQXNzZXRDb25maWcAAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAoh0ZWNobmljYWwtZG9jLm1kIFNlY3Rpb24gNS45IFM0ICh2MS41KTogcGVybWlzc2lvbmxlc3MuIEJ1aWxkcwpgaG91cmAgaWYgZXZlcnkgb25lIG9mIGl0cyBzdWItZXBvY2hzIGlzIEZpbmFsLCBwZXJtYW5lbnRseQptaXNzaW5nLCBvciByZWplY3RlZDsgYHBvc3Rfc3ViX3NpZ25hbHNgIGFscmVhZHkgYXR0ZW1wdHMgdGhpcwppbmxpbmUgb24gZXZlcnkgcG9zdCwgc28gdGhpcyBleGlzdHMgZm9yIGFueW9uZSB0byB0cmlnZ2VyIGEKYnVpbGQgdGhhdCBpcyByZWFkeSBidXQgdGhhdCBubyBmdXJ0aGVyIHBvc3RpbmcgaGFzIGhhcHBlbmVkIHRvCnRyaWdnZXIgYXV0b21hdGljYWxseSAodGhlIHNhbWUgcm9sZSBgZmluYWxpemVfZW5kcG9pbnRgIHBsYXlzCmZvciB0aGUgaG91cmx5IGJhY2t3YXJkIGZpbmFsaXR5IHNjYW4pLiBSZXR1cm5zCmBTdWJFcG9jaE5vdFJlYWR5YCBpZiBhdCBsZWFzdCBvbmUgc3ViLWVwb2NoIGlzIHN0aWxsIFBlbmRpbmcKb3IgRGlzcHV0ZWQ7IGEgbmV2ZXItcG9zdGVkIGhvdXIgKG5vIHN1Yi1lcG9jaCBhdCBhbGwsIG5vdCBldmVuCmEgbWlzc2luZyBvbmUgd2l0aGluIGFuIGFjdGl2ZSBpbnRlcnZhbCkgaXMgZXF1YWxseSBub3QgcmVhZHksCnNpbmNlIHRoZXJlIGlzIG5vdGhpbmcgdG8gYnVpbGQgZnJvbS4AAAAKYnVpbGRfaG91cgAAAAAAAgAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAAAAAARob3VyAAAABgAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAB50ZWNobmljYWwtZG9jLm1kIFNlY3Rpb24gMTIuMS4AAAAAAAppbml0aWFsaXplAAAAAAADAAAAAAAAAAhnb3Zlcm5vcgAAABMAAAAAAAAACHJlZ2lzdHJ5AAAAEwAAAAAAAAAHc3Rha2luZwAAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAABABSZS1yZXZpZXcgaXRlbSBDNyAobGVhZCBkZWNpc2lvbik6IGBhc3NldF9zdGFsZWAgbm93IG1lYW5zICJ0aGUKYXNzZXQgVFJBTlNJVElPTkVEIGludG8gc3RhbGUiLCBub3QgImEgbmV3bHkgb2JzZXJ2ZWQgZXBvY2gKaGFwcGVuZWQgdG8gYWxyZWFkeSBiZSBzdGFsZSBvbiBhcnJpdmFsIiAodGhlIG9sZCBkZXNpZ24ncwpjb25kaXRpb24sIHdoaWNoIG5ldmVyIGZpcmVkIGF0IGFsbCBmb3IgdGhlIHJlYWxpc3RpYyAia2VlcGVycwpzdG9wcGVkIHBvc3RpbmciIGNhc2UsIHNpbmNlIG5vdGhpbmcgbmV3IGV2ZXIgYXJyaXZlcyB0bwp0cmlnZ2VyIGl0KS4gUGVybWlzc2lvbmxlc3M6IGV2YWx1YXRlcyBzdGFsZW5lc3MgYWdhaW5zdCB0aGUKZXBvY2ggb2YgdGhlIFNUT1JFRCBzY29yZSAobmV2ZXIgYG5ld2VzdF9maW5hbGAsIHdoaWNoIGNhbiBydW4KYWhlYWQgb2YgdGhlIHN0b3JlZCBzY29yZSB3aGVuIGByZWNvbXB1dGVfc2NvcmVgIHNob3J0CmNpcmN1aXRzIHdpdGhvdXQgd3JpdGluZywgZS5nLiBhIHN0aWNreSBgRXZlbnRgIGJhbmQgb3Igbm90CmVub3VnaCBoaXN0b3J5IHlldCksIGVtaXRzIGBhc3NldF9zdGFsZWAgb25jZSBpZiB0aGUgYXNzZXQgaXMKc3RhbGUgYW5kIGBzdGFsZV9hbm5vdW5jZWRgIGlzIG5vdCBhbHJlYWR5IHNldCwgc2V0cyB0aGUgZmxhZywKYW5kIHJldHVybnMgdGhlIGN1cnJlbnQgc3RhbGUgc3RhdGUgZWl0aGVyIHdheS4gQ2FsbGluZyB0aGlzCmFnYWluIHdoaWxlIHN0aWxsIHN0YWxlIGVtaXRzIG5vdGhpbmcuIEV2ZXJ5IHN0YXRlIGNoYW5naW5nCmNhbGwgdGhhdCB0b3VjaGVzIGFuIGFzc2V0IHJ1bnMgdGhlIHNhbWUgY2hlY2sgaW50ZXJuYWxseSAoc2VlCmBjaGVja19zdGFsZV9pbnRlcm5hbGApLCBzbyBhIGxhdGUgYmFja2ZpbGwgdGhhdCBpcyBzdGFsZSBvbgphcnJpdmFsIGFsc28gZW1pdHMsIG9uY2UsIHdpdGhvdXQgbmVlZGluZyBhbnlvbmUgdG8gY2FsbCB0aGlzCmV4cGxpY2l0bHk7IHRoaXMgZnVuY3Rpb24gZXhpc3RzIGZvciBhIG1vbml0b3IgdGhhAAAAC2NoZWNrX3N0YWxlAAAAAAEAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAEAAAPpAAAAAQAAAAM=",
        "AAAAAAAAAc9QUiAjMjUgcmV2aWV3OiByZWFkLW9ubHksIG5vIGF1dGguIFRoZSBmaXJzdCBlcG9jaCBldmVyCnN1Y2Nlc3NmdWxseSBwb3N0ZWQgZm9yIHRoaXMgYXNzZXQuIGBFdmVudFJlZ2lzdHJ5YCdzIG93bgpUaWVyIDEgRGVwZWcgYW5kIElzc3VlckZyZWV6ZSBoaXN0b3J5IGJhc2VsaW5lcyBuZWVkIHRoaXMgZm9yCnRoZSBzYW1lIHJlYXNvbiBgUmlza09yYWNsZWAncyBvd24gc2NvcmUgYW5kIGBtZWRpYW5fbGlxdWlkaXR5YApkbzogdGhlIG5ld2VzdCBlcG9jaCdzIG93biBhYnNvbHV0ZSBudW1iZXIgaXMgYWx3YXlzIGZhcgpsYXJnZXIgdGhhbiBhbnkgd2luZG93IGxlbmd0aCBvbiBhIHJlYWwgbmV0d29yaywgc28gaXQgYWxvbmUKY2FuIG5ldmVyIHRlbGwgYSBicmFuZC1uZXcgYXNzZXQgZnJvbSBvbmUgd2l0aCB5ZWFycyBvZgpoaXN0b3J5LiBgTm9uZWAgYmVmb3JlIHRoZSBhc3NldCdzIGZpcnN0IHBvc3RpbmcuAAAAAAtmaXJzdF9lcG9jaAAAAAABAAAAAAAAAAVhc3NldAAAAAAAABMAAAABAAAD6AAAAAY=",
        "AAAAAAAAAGV0ZWNobmljYWwtZG9jLm1kIFNlY3Rpb24gMTIuMSwgNi4yLiBgc2V0X2Zvcm11bGFgIHJlamVjdHMgYW55CndlaWdodCBzZXQgdGhhdCBkb2VzIG5vdCBzdW0gdG8gMTAsMDAwLgAAAAAAAAtzZXRfZm9ybXVsYQAAAAADAAAAAAAAAAd2ZXJzaW9uAAAAAAQAAAAAAAAAB3dlaWdodHMAAAAD6gAAAAQAAAAAAAAABnBhcmFtcwAAAAAD7AAAABEAAAALAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAMYXNzZXRfY29uZmlnAAAAAQAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAQAAA+gAAAfQAAAAC0Fzc2V0Q29uZmlnAA==",
        "AAAAAAAAAthQUiAjMTUgcmV2aWV3LCBmaW5kaW5nIEY0OiByZWFkLW9ubHksIG5vIGF1dGguIFdyYXBzIHRoZQpleGlzdGluZyBgc3RvcmFnZTo6Z2V0X25ld2VzdF9lcG9jaF9wdWJgLCB3aGljaCByZWFkcyB0aGUKZGVkaWNhdGVkIGBSaW5nTmV3ZXN0YCBrZXkgZGlyZWN0bHkgcmF0aGVyIHRoYW4gdGhlIG5ld2VzdApyaW5nIFBPU0lUSU9OJ3Mgb3duIHN0b3JlZCBlcG9jaC4gVGhlIHR3byBkaXNhZ3JlZSBleGFjdGx5CndoZW4gdGhlIG5ld2VzdCBwb3NpdGlvbiBpcyBgRW1wdHlgIChpdHMgZXBvY2ggd2FzIG92ZXJ0dXJuZWQKYW5kIG5vdCB5ZXQgcmVwb3N0ZWQpOiB0aGUgcG9zaXRpb24ncyBzbG90IHJlcG9ydHMgZXBvY2ggYDBgCihgZW1wdHlfc2xvdCgpYCdzIGRlZmF1bHQpLCB3aGlsZSBgUmluZ05ld2VzdGAgc3RpbGwgY29ycmVjdGx5CnJlcG9ydHMgdGhlIHJlYWwgbmV3ZXN0IGVwb2NoIGV2ZXIgd3JpdHRlbi4gYEV2ZW50UmVnaXN0cnlgCm5lZWRzIHRoZSBsYXR0ZXIgZm9yIGl0cyBvd24gYHNsb3RfZm9yX2Vwb2NoYCBhcml0aG1ldGljCihgcmluZygpYCdzIGxheW91dCBpcyAib2xkZXN0IGZpcnN0LCBlbmRpbmcgYXQgUmluZ05ld2VzdCIpOwpyZWFkaW5nIHRoZSBmb3JtZXIgbWFkZSBldmVyeSBzdWJzZXF1ZW50IGBzbG90X2Zvcl9lcG9jaGAgY2FsbAptaXNzLCBtaXNjbGFzc2lmeWluZyBldmVyeSBjdXJlLXdpbmRvdyBlcG9jaCBhcyBwZXJtYW5lbnRseQptaXNzaW5nLgAAAAxuZXdlc3RfZXBvY2gAAAABAAAAAAAAAAVhc3NldAAAAAAAABMAAAABAAAD6AAAAAY=",
        "AAAAAAAAATd0ZWNobmljYWwtZG9jLm1kIFNlY3Rpb24gMTIuMSwgNS4yLCA1LjMsIDExLjMuCgpDaGVja3Mga2VlcGVyIGVsaWdpYmlsaXR5IGFnYWluc3QgYFN0YWtpbmdgLCBhcHBsaWVzIHRoZSBmdWxsClNlY3Rpb24gMTEuMyBzYW5pdHkgYm91bmRzLCBjcm9zcyBjaGVja3MgY29uZmlndXJlZCBgUHJpY2VBZGFwdGVyYHMsCmFuZCBzb3VyY2VzIGBlbmRwb2ludGAgb25seSBmcm9tIGBTdGFraW5nLmFnZ3JlZ2F0ZWAgKG5ldmVyIHRoZQprZWVwZXIncyBwYXlsb2FkKS4gYHMuZW5kcG9pbnRgIGlzIG9ubHkgZXZlciBhIHBsYWNlaG9sZGVyIG9uIGlucHV0LgAAAAAMcG9zdF9zaWduYWxzAAAAAwAAAAAAAAAGa2VlcGVyAAAAAAATAAAAAAAAAAVhc3NldAAAAAAAABMAAAAAAAAAAXMAAAAAAAfQAAAACVNpZ25hbFNldAAAAAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAUp0ZWNobmljYWwtZG9jLm1kIFNlY3Rpb24gMTIuMTogInJlamVjdHMgYSBjaGFuZ2UgdG8gY2ZnLnJlZmVyZW5jZSIuClJldmlldyBkZWNpc2lvbiBEMzogYWxzbyByZWplY3RzIGBSZWZlcmVuY2U6OkFzc2V0YCwgc2FtZSBhcwpgYWRkX2Fzc2V0YCAoYW4gZXhpc3RpbmcgYXNzZXQgY2FuIG5ldmVyIGhhdmUgaGFkIHRoaXMgcmVmZXJlbmNlCmluIHRoZSBmaXJzdCBwbGFjZSwgc2luY2UgYGFkZF9hc3NldGAgcmVqZWN0cyBpdCwgYnV0IHRoZSBjaGVjawppcyByZXBlYXRlZCBoZXJlIHJhdGhlciB0aGFuIHJlbHlpbmcgb24gdGhhdCBpbnZhcmlhbnQgaG9sZGluZwpmb3JldmVyKS4AAAAAAAx1cGRhdGVfYXNzZXQAAAACAAAAAAAAAAVhc3NldAAAAAAAABMAAAAAAAAAA2NmZwAAAAfQAAAAC0Fzc2V0Q29uZmlnAAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAB50ZWNobmljYWwtZG9jLm1kIFNlY3Rpb24gMTIuMS4AAAAAAA1kaXNhYmxlX2Fzc2V0AAAAAAAAAQAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAUd0ZWNobmljYWwtZG9jLm1kIFNlY3Rpb24gMTIuMTogcmVmZXJlbmNlIHRvIFVTRCwgU0NBTEUgMWU3LiBgVXNkYAppcyBhbHdheXMgYFNDQUxFYDsgYEZpYXRgIHJlYWRzIHRoZSBhc3NldCdzIGBGeEFkYXB0ZXJgIG9uIHRoZQpyZWZlcmVuY2UncyByZWNvcmRlZCBiYXNpcyBhbmQgZmFpbHMgY2xvc2VkIG9uIGEgc3RhbGUgb3IgbWlzc2luZwpyYXRlOyBgQXNzZXRgIGhhcyBubyBVU0QgcmF0ZSBkZWZpbmVkIGFueXdoZXJlIGluIHRoZSBzcGVjLCBzbyB0aGlzCmZhaWxzIHJhdGhlciB0aGFuIGd1ZXNzaW5nIG9uZSAoc2VlIHRoZSBQUidzICJTcGVjIGRldmlhdGlvbnMiKS4AAAAADnJlZmVyZW5jZV9yYXRlAAAAAAABAAAAAAAAAAVhc3NldAAAAAAAABMAAAABAAAD6QAAAAsAAAAD",
        "AAAAAAAAAL10ZWNobmljYWwtZG9jLm1kIFNlY3Rpb24gMTIuMSwgOC41LCA4LjguIEF1dGg6IHRoZSByZWdpc3RyeQpjb250cmFjdCBpdHNlbGYgKHRoZSBgcmVnaXN0cnlgIGFkZHJlc3MgYFJpc2tPcmFjbGVgIHdhcwppbml0aWFsaXplZCB3aXRoKSwgcGVyIFNlY3Rpb24gMTYuMSdzIGNvbnRyYWN0LXRvLWNvbnRyYWN0IGF1dGgKcGF0dGVybi4AAAAAAAAOc2V0X2V2ZW50X2JhbmQAAAAAAAEAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAApl0ZWNobmljYWwtZG9jLm1kIFNlY3Rpb24gNS45IFM1ICh2MS41KTogcmVhZC1vbmx5LCBubyBhdXRoLiBFYWNoCm9mIGBob3VyYCdzIHN1Yi1lcG9jaHMnIG93biBgcGVnX3JhdGlvYCwgaW4gYHN1YmAgb3JkZXIsIGBOb25lYApmb3IgYSBzdWItZXBvY2ggdGhhdCBpcyBub3QgcG9zdGVkIG9yIG5vdCB5ZXQgZWZmZWN0aXZlbHkgRmluYWwKb3IgUGVuZGluZyAodGhlIHNhbWUgIlBlbmRpbmcgb3IgRmluYWwiIGNvbnZlbnRpb24KYEV2ZW50UmVnaXN0cnkuY292ZXJfZ2F0ZWAncyBleGlzdGluZyBgUmVjZW50RGVwZWdgIGNoZWNrCmFscmVhZHkgcmVhZHMgZnJvbSBgUmluZyhhc3NldClgLCBleHRlbmRlZCB0byBgU3ViKGFzc2V0KWAgZm9yCmFuIGhvdXIgdGhhdCBoYXMgbm90IGJ1aWx0IHlldCkuIGBFdmVudFJlZ2lzdHJ5YCdzIG93bgpgY292ZXJfZ2F0ZWAgY2FsbHMgdGhpcyBvbmx5IGZvciB0aGUgY3VycmVudCwgbm90LXlldC1idWlsdApob3VyIChvciBob3VycywgaW4gdGhlIHVwLXRvLTJoIHdpbmRvdyBhbiBob3VyIGNhbiBzdGF5CndhaXRpbmcpOiBldmVyeSBhbHJlYWR5LWJ1aWx0IGhvdXIgaW5zaWRlIGl0cyBvd24gdHJhaWxpbmcKd2luZG93IGlzIHN0aWxsIHJlYWQgdGhyb3VnaCBgcmluZygpYCBleGFjdGx5IGFzIGJlZm9yZSB0aGlzCnJldmlzaW9uLgAAAAAAAA5zdWJfcGVnX3JhdGlvcwAAAAAAAgAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAAAAAARob3VyAAAABgAAAAEAAAPqAAAD6AAAAAs=",
        "AAAAAAAAAPZ0ZWNobmljYWwtZG9jLm1kIFNlY3Rpb24gMTIuMSwgNS40LCA3LjguCgpSZWNvcmRzIHRoZSBkaXNwdXRlIGFuZCBsb2NrcyB0aGUgZGlzcHV0ZXIncyBib25kIGluIGBTdGFraW5nYC4KT25seSB0aGUgc2lnbmFsIGRpc3B1dGUgU1RBVEUgbGl2ZXMgaGVyZTsgdGhlIGJvbmQgaXRzZWxmIGlzIGhlbGQKYW5kIGxhdGVyIHNwbGl0IGJ5IGBTdGFraW5nYCBvbiBpbnN0cnVjdGlvbiBmcm9tCmByZXNvbHZlX3NpZ25hbF9kaXNwdXRlYC4AAAAAAA9kaXNwdXRlX3NpZ25hbHMAAAAABAAAAAAAAAAIZGlzcHV0ZXIAAAATAAAAAAAAAAVhc3NldAAAAAAAABMAAAAAAAAABWVwb2NoAAAAAAAABgAAAAAAAAAIYWx0X2hhc2gAAAPuAAAAIAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAACN0ZWNobmljYWwtZG9jLm1kIFNlY3Rpb24gMTIuMSwgOC44LgAAAAAQY2xlYXJfZXZlbnRfYmFuZAAAAAEAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAQ1SZXZpZXcgaXRlbSBDNTogYSB3aW5kb3cgcmVhZCBvZiBlZmZlY3RpdmUgc3RhdGUgcGVyIGVwb2NoLCBmb3IKYEV2ZW50UmVnaXN0cnlgJ3MgVGllciAxIGNoZWNrcyAoU2VjdGlvbiA4LjIpLCBzbyBpdCBjYW4gbGVhcm4Kd2hpY2ggZXBvY2hzIGluIGEgd2luZG93IGFyZSBmaW5hbCB3aXRob3V0IG9uZSBjYWxsIHBlciBlcG9jaC4KTWlzc2luZyBlcG9jaHMgcmVhZCBgTm9uZWAsIHRoZSBzYW1lIGNvbnZlbnRpb24gYXMgYHJpbmdgJ3MKdW5kZXJseWluZyBzdG9yYWdlLgAAAAAAABBlZmZlY3RpdmVfd2luZG93AAAAAwAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAAAAAAtzdGFydF9lcG9jaAAAAAAGAAAAAAAAAAVjb3VudAAAAAAAAAQAAAABAAAD6gAAA+gAAAfQAAAACVNsb3RTdGF0ZQAAAA==",
        "AAAAAAAAARN0ZWNobmljYWwtZG9jLm1kIFNlY3Rpb24gMTEuMTogbWVkaWFuIG9mIHRoZSBuZXdlc3QgMTY4IHNsb3RzJwpgbGlxdWlkaXR5XzJwY3RgLCBmb3IgdGhlIGFzc2V0IHdpZGUgY292ZXIgY2FwLiBNaXNzaW5nIHNsb3RzIGluCnRoZSB3aW5kb3cgYXJlIGV4Y2x1ZGVkLCBub3QgdHJlYXRlZCBhcyB6ZXJvIGxpcXVpZGl0eSwgc28gYSBzaG9ydApydW4gb2YgbWlzc2luZyBlcG9jaHMgZG9lcyBub3QgY3JhdGVyIHRoZSBjYXAgdGhlIHdheSByZWFsIHplcm8KbGlxdWlkaXR5IHdvdWxkLgAAAAAQbWVkaWFuX2xpcXVpZGl0eQAAAAEAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAEAAAAL",
        "AAAAAAAAAcx0ZWNobmljYWwtZG9jLm1kIFNlY3Rpb24gNS45IFMyICh2MS41KS4gUG9zdHMgYSBzdWItZXBvY2gsCmtleWVkIGJ5IGAoaG91ciwgc3ViKWAgaW5zdGVhZCBvZiBhIHNpbmdsZSBgZXBvY2hgLiBNaXJyb3JzCmBwb3N0X3NpZ25hbHNgJ3Mgb3duIGNoZWNrcyAoa2VlcGVyIGVsaWdpYmlsaXR5LCBzYW5pdHkgYm91bmRzLApBTU0gY3Jvc3MgY2hlY2spLCBkaXNwdXRhYmxlIGZvciBgc2lnbmFsX2Rpc3B1dGVfc2Vjc2AgZXhhY3RseQphcyB0aGUgaG91cmx5IHBhdGggYWxyZWFkeSBzcGVjaWZpZXMuIFJlY29tcHV0ZXMgdGhlIGhvdXIncyBvd24KcHJvdmlzaW9uYWwgcm9sbC11cCBvbiBldmVyeSBjYWxsLCBhbmQgYXR0ZW1wdHMgdGhlIGhvdXIncwpidWlsZCBpbmxpbmUsIHRoZSBzYW1lIHdheSBgcG9zdF9zaWduYWxzYCBhbHJlYWR5CmlubGluZS10cmlnZ2VycyB0aGUgaG91cmx5IGZpbmFsaXR5IHNjYW4uAAAAEHBvc3Rfc3ViX3NpZ25hbHMAAAAFAAAAAAAAAAZrZWVwZXIAAAAAABMAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAAAAAAEaG91cgAAAAYAAAAAAAAAA3N1YgAAAAAEAAAAAAAAAAFzAAAAAAAH0AAAAAlTaWduYWxTZXQAAAAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAI50ZWNobmljYWwtZG9jLm1kIFNlY3Rpb24gNS45IFMxICh2MS41KTogcmVhZC1vbmx5LCBubyBhdXRoLiBUaGUKYXNzZXQncyBzdWItZXBvY2ggY29uZmlndXJhdGlvbiwgaW5jbHVkaW5nIGEgcGVuZGluZyBjaGFuZ2Ugbm90CnlldCBpbiBlZmZlY3QuAAAAAAAQc3ViX2Vwb2NoX2NvbmZpZwAAAAEAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAEAAAPoAAAH0AAAAA5TdWJFcG9jaENvbmZpZwAA",
        "AAAAAAAAAS90ZWNobmljYWwtZG9jLm1kIFNlY3Rpb24gMTIuMSAoZmVhdC9ldmVudC1yZWdpc3RyeSBkZXNpZ24gbm90ZSwKcmV2aWV3IGl0ZW0gRDYpOiByZWFkLW9ubHksIG5vIGF1dGguIExldHMgYEV2ZW50UmVnaXN0cnlgIGFzc2VydAppbnZhcmlhbnQgRTQgKGl0cyBvd24gYWN0aXZlLWV2ZW50IGNvdW50IGFncmVlcyB3aXRoIHRoaXMgZmxhZykKZGlyZWN0bHksIHJhdGhlciB0aGFuIGluZmVycmluZyB0aGUgZmxhZyBvbmx5IHRocm91Z2ggaXRzIG9uZQp2aXNpYmxlIGVmZmVjdCBvbiBgYmFuZCgpYCdzIG93biBEaXN0cmVzcyBmbG9vci4AAAAAEWV2ZW50X2luX3Byb2dyZXNzAAAAAAAAAQAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAQAAAAE=",
        "AAAAAAAAATB0ZWNobmljYWwtZG9jLm1kIFNlY3Rpb24gMTIuMSwgNy40LiBSZWFkcyBgU3Rha2luZy5hZ2dyZWdhdGVgIGFuZApib29rcyBpdCBpbnRvIHRoZSBlcG9jaCdzIHJpbmcgc2xvdCBhbmQgYFNpZ25hbHNgIGVudHJ5IGlmCmBwb3N0X3NpZ25hbHNgIGhhZCBub3QgYWxyZWFkeSByZXNvbHZlZCBvbmUgYnkgdGhlIHRpbWUgaXQgY2xvc2VkOwp0aGVuIGNhbGxzIGBTdGFraW5nLnNldHRsZV9wcm9iZXNgIGV4YWN0bHkgb25jZSByZWdhcmRsZXNzLCBwZXIKU2VjdGlvbiA3LjQncyAiYm9va2VkIGV4YWN0bHkgb25jZSIgcmVxdWlyZW1lbnQuAAAAEWZpbmFsaXplX2VuZHBvaW50AAAAAAAAAgAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAAAAAAVlcG9jaAAAAAAAAAYAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAUNSZXZpZXcgaXRlbSBDNDogdGhlIGBTaWduYWxTZXRgIGFuIG92ZXJ0dXJuZWQgZXBvY2gncyBwb3N0aW5nIGhhZApiZWZvcmUgYHJlc29sdmVfc2lnbmFsX2Rpc3B1dGVgIG1vdmVkIGl0IG91dCBvZiBgc2lnbmFsc2AncyBsaXZlCmtleSwga2VwdCBmb3IgYXVkaXQuIGBOb25lYCBpZiBgZXBvY2hgIHdhcyBuZXZlciBvdmVydHVybmVkIChvcgp3YXMgb3ZlcnR1cm5lZCwgcmVwb3N0ZWQsIGFuZCBvdmVydHVybmVkIGFnYWluLCB3aGljaCBrZWVwcyBvbmx5CnRoZSBtb3N0IHJlY2VudCBvdmVydHVybiwgbm90IGEgZnVsbCBoaXN0b3J5IG9mIGV2ZXJ5IGF0dGVtcHQpLgAAAAASb3ZlcnR1cm5lZF9zaWduYWxzAAAAAAACAAAAAAAAAAVhc3NldAAAAAAAABMAAAAAAAAABWVwb2NoAAAAAAAABgAAAAEAAAPoAAAH0AAAAAlTaWduYWxTZXQAAAA=",
        "AAAAAAAAAYh0ZWNobmljYWwtZG9jLm1kIFNlY3Rpb24gNS45IFMxLCAxNiwgMTcuNCAodjEuNSkuIEF1dGg6IGdvdmVybm9yLAp0aGUgc2FtZSBgU2V0UGFyYW1gLXN0eWxlIHBhdGggZXZlcnkgb3RoZXIgcGFyYW1ldGVyIGluIFNlY3Rpb24KMjMgYWxyZWFkeSB1c2VzOyBubyBuZXcgcm9sZSBvciBhY3Rpb24gdHlwZSBpcyBuZWVkZWQuIFRha2VzCmVmZmVjdCBmcm9tIHRoZSBORVhUIGhvdXIgYm91bmRhcnkgb25seSAobmV2ZXIgdGhlIGN1cnJlbnQsCnBvc3NpYmx5LWluLXByb2dyZXNzIGhvdXIpLCBzbyBubyBzdWItZXBvY2ggYWxyZWFkeSBwb3N0ZWQsIG9yCnBvc3RhYmxlIGJlZm9yZSB0aGF0IGJvdW5kYXJ5LCBpcyBldmVyIHJlaW50ZXJwcmV0ZWQgdW5kZXIgYQpkaWZmZXJlbnQgbGVuZ3RoLgAAABJzZXRfc3ViX2Vwb2NoX3NlY3MAAAAAAAIAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAAAAAAFdmFsdWUAAAAAAAAGAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAZR0ZWNobmljYWwtZG9jLm1kIFNlY3Rpb24gNS45IFMyLCBTMyAodjEuNSkuIE1pcnJvcnMKYGRpc3B1dGVfc2lnbmFsc2AgZXhhY3RseSwgYWdhaW5zdCBgU3ViKGFzc2V0KWAncyBvd24gcmluZzogb24KZGlzcHV0ZSwgdGhlIHN1Yi1lcG9jaCdzIHJlY29yZCBpcyBjb3BpZWQgb3V0IHRvCmBTdWJEaXNwdXRlKGFzc2V0LCBob3VyLCBzdWIpYCAoc28gYFN1Yihhc3NldClgJ3MgZml4ZWQgNjAgc2xvdApyaW5nIGNhbiBrZWVwIHJvdGF0aW5nIHVuZGVybmVhdGggYSBydWxpbmcgdGhhdCB0YWtlcyB1cCB0bwpgU0lHTkFMX0RJU1BVVEVfUlVMSU5HX1NFQ1NgKSwgYW5kIHRoZSBIT1VSJ3Mgb3duIGBSaW5nKGFzc2V0KWAKc2xvdCBtb3ZlcyB0byBgRGlzcHV0ZWRgIHZpYSBgcmVmcmVzaF93YWl0aW5nX2hvdXJgLgAAABNkaXNwdXRlX3N1Yl9zaWduYWxzAAAAAAUAAAAAAAAACGRpc3B1dGVyAAAAEwAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAAAAAARob3VyAAAABgAAAAAAAAADc3ViAAAAAAQAAAAAAAAACGFsdF9oYXNoAAAD7gAAACAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAlFSZXZpZXcgZGVjaXNpb24gRDEsIG5vdCBpbiB0aGUgb3JpZ2luYWwgU2VjdGlvbiAxMi4xIGxpc3QuIEF1dGg6CnRoZSByZWdpc3RyeSBjb250cmFjdCwgc2FtZSBwYXR0ZXJuIGFzIGBzZXRfZXZlbnRfYmFuZGAgLwpgY2xlYXJfZXZlbnRfYmFuZGAgKFNlY3Rpb24gMTYuMSkuIFdoaWxlIGB0cnVlYCwgYHNjb3JlKClgIGZsb29ycwp0aGUgYmFuZCBhdCBgRGlzdHJlc3NgIG9uIGV2ZXJ5IHJlYWQgKFNlY3Rpb24gNi4zJ3MgImZvcmNlZCB0bwpEaXN0cmVzcyBpZiBhIGNyZWRpdCBldmVudC4uLiBpcyBQcm9wb3NlZCwgQ2hhbGxlbmdlZCBvcgpFc2NhbGF0ZWQiKSwgaW5kZXBlbmRlbnQgb2YgdGhlIGh5c3RlcmVzaXMtcHJvdGVjdGVkIGJhbmQKYWN0dWFsbHkgc3RvcmVkOyBgUmlza09yYWNsZWAgbmV2ZXIgY2FsbHMgaW50byBgRXZlbnRSZWdpc3RyeWAgdG8KY2hlY2sgdGhpcyBpdHNlbGYsIG1hdGNoaW5nIHRoZSBpbnN0cnVjdGlvbiB0aGF0ICJ0aGUgb3JhY2xlCm5ldmVyIGNhbGxzIHRoZSByZWdpc3RyeSIg4oCUIHRoaXMgaXMgcHVzaGVkIGluLCB0aGUgc2FtZQpkaXJlY3Rpb24gYHNldF9ldmVudF9iYW5kYCBhbHJlYWR5IHdvcmtzLgAAAAAAABVzZXRfZXZlbnRfaW5fcHJvZ3Jlc3MAAAAAAAACAAAAAAAAAAVhc3NldAAAAAAAABMAAAAAAAAAC2luX3Byb2dyZXNzAAAAAAEAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAALR0ZWNobmljYWwtZG9jLm1kIFNlY3Rpb24gMTIuMSwgNS40LCA3LjguIEF1dGg6IHRoZSBjb21taXR0ZWUKYWRkcmVzcywgcmVhZCBmcmVzaCBmcm9tIGBHb3Zlcm5vci5jb21taXR0ZWUoKWAgb24gZXZlcnkgY2FsbCAodGhlCmNvbW1pdHRlZSBjYW4gcm90YXRlOyBgUmlza09yYWNsZWAgbmV2ZXIgY2FjaGVzIGl0KS4AAAAWcmVzb2x2ZV9zaWduYWxfZGlzcHV0ZQAAAAAABAAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAAAAAAVlcG9jaAAAAAAAAAYAAAAAAAAAC2tlZXBlcl93aW5zAAAAAAEAAAAAAAAABnJlYXNvbgAAAAAD7gAAACAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAArB0ZWNobmljYWwtZG9jLm1kIFNlY3Rpb24gNS45IFMyLCBTNCAodjEuNSkuIE1pcnJvcnMKYHJlc29sdmVfc2lnbmFsX2Rpc3B1dGVgIGV4YWN0bHksIGFnYWluc3QgYFN1Yihhc3NldClgLiBPbgpga2VlcGVyX3dpbnNgLCB0aGUgc3ViLWVwb2NoJ3Mgc2xvdCBiZWNvbWVzIEZpbmFsOyBvbiB0aGUKZGlzcHV0ZXIgd2lubmluZywgaXQgY2xlYXJzIGJhY2sgdG8gRW1wdHkgKHRoZSBvdmVydHVybmVkCnN1Yi1lcG9jaCdzIG93biBgU3ViU2lnbmFsc2AgZW50cnkgaXMgbGVmdCBpbiBwbGFjZSBmb3IgYXVkaXQsCnRoZSBzYW1lIHdheSBgU2lnbmFscyhhc3NldCwgZXBvY2gpYCBpcyBrZXB0IGJ1dCBubyBsb25nZXIKbGl2ZSBhZnRlciBhbiBob3VybHkgb3ZlcnR1cm4pIGFuZCBjYW4gYmUgcmVwb3N0ZWQuIEVpdGhlciB3YXksCmByZWZyZXNoX3dhaXRpbmdfaG91cmAgcmUtZGVyaXZlcyB0aGUgSE9VUidzIG93biBgUmluZyhhc3NldClgCnN0YXRlIGZyb20gZXZlcnkgc3ViLWVwb2NoJ3MgY3VycmVudCBkaXNwb3NpdGlvbiwgd2hpY2ggbWF5Cm1vdmUgdGhlIGhvdXIgb3V0IG9mIGBEaXNwdXRlZGAgKGlmIG5vIG90aGVyIHN1Yi1lcG9jaCBpbiBpdCBpcwpzdGlsbCBkaXNwdXRlZCkgYW5kLCBpZiB0aGlzIHdhcyB0aGUgbGFzdCB1bmRlY2lkZWQgc3ViLWVwb2NoLAp0cmlnZ2VyIHRoZSBob3VyJ3MgYnVpbGQuAAAAGnJlc29sdmVfc3ViX3NpZ25hbF9kaXNwdXRlAAAAAAAFAAAAAAAAAAVhc3NldAAAAAAAABMAAAAAAAAABGhvdXIAAAAGAAAAAAAAAANzdWIAAAAABAAAAAAAAAALa2VlcGVyX3dpbnMAAAAAAQAAAAAAAAAGcmVhc29uAAAAAAPuAAAAIAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAPl0ZWNobmljYWwtZG9jLm1kIFNlY3Rpb24gNS45IFMyICh2MS41KS4gTWlycm9ycwpgcmVzb2x2ZV9zaWduYWxfZGlzcHV0ZV90aW1lb3V0YCBleGFjdGx5LCBhZ2FpbnN0CmBTdWJEaXNwdXRlKGFzc2V0LCBob3VyLCBzdWIpYDogdGhlIGNvbW1pdHRlZSdzIHNpbGVuY2UgaXMgcmVhZAp0aGUgc2FtZSB3YXkgZm9yIGEgc3ViLWVwb2NoIGRpc3B1dGUgYXMgZm9yIGFuIGhvdXJseSBvbmUsIHRoZQprZWVwZXIncyBwb3N0aW5nIHN0YW5kcy4AAAAAAAAbcmVzb2x2ZV9zdWJfZGlzcHV0ZV90aW1lb3V0AAAAAAMAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAAAAAAEaG91cgAAAAYAAAAAAAAAA3N1YgAAAAAEAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAABABTZWN0aW9uIDUuOSBTNSAodjEuNSwgZm9vdHByaW50LWZpeCByZXZpc2lvbik6IGBFdmVudFJlZ2lzdHJ5Lgpjb3Zlcl9nYXRlYCdzIG93biBgUmVjZW50RGVwZWdgIGNoZWNrLCBmb3IgdW5idWlsdCBob3VycyBzdGlsbApJTlNJREUgYFN1Yihhc3NldClgJ3Mgb3duIDUtaG91ciBzcGFuIChgU1VCX1JJTkdfU0xPVFMgKgpTVUJfRVBPQ0hfR1JJRF9TRUNTYCksIG5ldmVyIGNhbGxpbmcgdGhpcyBmb3IgYW4gaG91ciBvdXRzaWRlCml0ICh0aGUgY2FsbGVyJ3Mgb3duIGpvYiB0byB0ZWxsIGFwYXJ0LCB1c2luZyBgbmV3ZXN0X2Vwb2NoYAphbmQgdGhvc2Ugc2FtZSBjb25zdGFudHM6IHRoaXMgZnVuY3Rpb24gdHJ1c3RzIGl0cyBjYWxsZXIKY29tcGxldGVseSBhbmQgZG9lcyBub3QgcmUtY2hlY2spLiBVbmxpa2UgYHN1Yl9wZWdfcmF0aW9zYCAvCnRoZSBzaW5jZS1yZW1vdmVkIGBzdWJfcGVnX3JhdGlvc19iYXRjaGAsIHRoaXMgTkVWRVIgcmVhZHMKYEhlbGRIb3VyYDogZXZlcnkgaG91ciBpdCBpcyBhc2tlZCBhYm91dCBpcyBhc3N1bWVkIHN0aWxsCnBoeXNpY2FsbHkgcHJlc2VudCBpbiBgU3ViKGFzc2V0KWAncyBvd24gcmluZywgc28gYEhlbGRIb3VyYCAoYQp3cml0ZS1wYXRoLCBidWlsZC9kaXNwdXRlLW9ubHkgY29uY2VybiwgbmV2ZXIgYSBnYXRlIGNvbmNlcm4sCnBlciB0aGUgU2VjdGlvbiA1LjkgUzUgZm9vdHByaW50LWZpeCByZXZpZXcpIHBsYXlzIG5vIHBhcnQKaGVyZS4gT25lIGNyb3NzLWNvbnRyYWN0IGNhbGwgZm9yIGV2ZXJ5IGhvdXIgdGhlIGdhdGUgbmVlZHMsCnRvdWNoaW5nIGV4YWN0bHkgT05FIGtleSAoYFN1Yihhc3NldClgLCByZWFkIG9uY2UgcmVnYXJkbGVzcyBvZgpob3cgbWFueSBob3VycyBvciBzdWItZXBvY2hzIGFyZSByZXF1ZXN0ZWQpIHJhdGhlciB0aGFuIG9uZSBrZXkKcGVyIGhvdXI6IHRoaXMgaXMgd2hhdCBtYWtlcyB0aGUgZ2F0ZSdzIG93biBmb290cHJpbnQgY29uc3RhbnQKcmVnYXJkbGVzcyBvZiBob3cgbWFueSBob3VycyBhcmUgdW5idWlsdCAoUjEwAAAAHHN1Yl9wZWdfcmF0aW9zX2luX3NwYW5fYmF0Y2gAAAACAAAAAAAAAAVhc3NldAAAAAAAABMAAAAAAAAABWhvdXJzAAAAAAAD6gAAAAYAAAABAAAD6gAAA+oAAAPoAAAACw==",
        "AAAAAAAAA/lBRFItMDEwIChpc3N1ZSAjNCBmaXgpLiBQZXJtaXNzaW9ubGVzcywgY2FsbGFibGUgb25jZQpgU0lHTkFMX0RJU1BVVEVfUlVMSU5HX1NFQ1NgIGhhcyBwYXNzZWQgc2luY2UgYGRpc3B1dGVfc2lnbmFsc2AKb3BlbmVkIHRoaXMgZGlzcHV0ZSwgaWYgdGhlIGNvbW1pdHRlZSBzdGlsbCBoYXMgbm90IHJ1bGVkIHZpYQpgcmVzb2x2ZV9zaWduYWxfZGlzcHV0ZWAuIERlZmF1bHQgb3V0Y29tZSBtaXJyb3JzIEFEUi0wMDIncwpydWxlIGZvciBkYXRhIGJhY2tlZCBjbGFpbXM6IHRoZSBrZWVwZXIncyBwb3N0aW5nIHN0YW5kcyAoc2xvdApgRmluYWxgLCBzYW1lIGFzIGEgYGtlZXBlcl93aW5zOiB0cnVlYCBjb21taXR0ZWUgcnVsaW5nKS4gIkJvdGgKYm9uZHMgcmVsZWFzZWQgaW4gZnVsbCwgbm9ib2R5IHNsYXNoZWQiICh0aGUgdGFzaydzIG93bgp3b3JkaW5nKTogdGhlcmUgaXMgb25seSBvbmUgYWN0dWFsIGBCb25kS2V5OjpTaWduYWxEaXNwdXRlYApsb2NrIHRvIHJlbGVhc2UsIHRoZSBkaXNwdXRlcidzICh0ZWNobmljYWwtZG9jLm1kIFNlY3Rpb24gMjQuMgpub3RlcyBhIGtlZXBlciBoYXMgbm8gc3ltbWV0cmljIHBlci1zaWduYWwgYm9uZCBpbiB2MTsgb25seQpgc2xhc2hgLCBieSBhZGRyZXNzLCBldmVyIHRvdWNoZXMgYSBrZWVwZXIncyBzdGFrZSksIHNvIGluCnByYWN0aWNlIHRoaXMgbWVhbnMgdGhlIGRpc3B1dGVyJ3MgYm9uZCBpcyByZWZ1bmRlZAooYHJlbGVhc2VfYm9uZGAsIG5vdCBgZm9yZmVpdF9ib25kYCkgQU5EIHRoZSBrZWVwZXIncyBzdGFrZSBpcwpsZWZ0IHVudG91Y2hlZCAobm8gYHNsYXNoYCBjYWxsIGVpdGhlcikg4oCUIGJvdGggcGFydGllcyBjb21lCm91dCBleGFjdGx5IGFzIHRoZXkgd291bGQgZnJvbSBhIGBrZWVwZXJfd2luczogdHJ1ZWAgcnVsaW5nLAp3aGljaCBpcyB0aGUgY29tbWl0dGVlJ3Mgc2lsZW5jZSBiZWluZyByZWFkIGFzICJubyBldmlkZW5jZQp0aGUgcG9zdGluZyB3YXMgd3JvbmciLCBub3QgYXMgYSBsb3NzIGZvciBlaXRoZXIgc2lkZS4AAAAAAAAecmVzb2x2ZV9zaWduYWxfZGlzcHV0ZV90aW1lb3V0AAAAAAACAAAAAAAAAAVhc3NldAAAAAAAABMAAAAAAAAABWVwb2NoAAAAAAAABgAAAAEAAAPpAAAAAgAAAAM=",
        "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAAFQAAAAAAAAASQWxyZWFkeUluaXRpYWxpemVkAAAAAAABAAAAAAAAAA5Ob3RJbml0aWFsaXplZAAAAAAAAgAAAqlOZXZlciBhY3R1YWxseSByZXR1cm5lZCBieSBhbnkgY2FsbCBpbiB0aGlzIGNvbnRyYWN0OiBldmVyeQphdXRob3JpemF0aW9uIGNoZWNrIChgYWRkX2Fzc2V0YCwgYHVwZGF0ZV9hc3NldGAsIGBzZXRfZm9ybXVsYWAsCmBwb3N0X3NpZ25hbHNgLCBgZGlzcHV0ZV9zaWduYWxzYCwgYHJlc29sdmVfc2lnbmFsX2Rpc3B1dGVgLApgc2V0X2V2ZW50X2JhbmRgLCBgY2xlYXJfZXZlbnRfYmFuZGAsIGBzZXRfZXZlbnRfaW5fcHJvZ3Jlc3NgKQpnb2VzIHRocm91Z2ggU29yb2JhbidzIG5hdGl2ZSBgQWRkcmVzczo6cmVxdWlyZV9hdXRoKClgLCB3aGljaAp0cmFwcyB0aGUgaG9zdCBjYWxsIGRpcmVjdGx5IHJhdGhlciB0aGFuIHJldHVybmluZyBhIGBSZXN1bHRgCnRoaXMgY29udHJhY3QgY291bGQgd3JhcCBpbiBgRXJyb3I6OlVuYXV0aG9yaXplZGAuIEtlcHQgZm9yCmB0ZWNobmljYWwtZG9jLm1kYCBTZWN0aW9uIDE0IGNvZGUtbnVtYmVyIGNvbXBhdGliaWxpdHk7IHNlZQpgbWlzc2luZ19hdXRoX3RyYXBzX25hdGl2ZWx5X3JhdGhlcl90aGFuX3JldHVybmluZ191bmF1dGhvcml6ZWRgCmluIHRlc3QucnMgYW5kIHRoZSBQUidzICJSZXZpZXcgZml4ZXMiIHNlY3Rpb24gZm9yIHdoeSB0aGlzIGlzCmRvY3VtZW50ZWQgYXMgdW5yZWFjaGFibGUgcmF0aGVyIHRoYW4gdGVzdGVkIGFzIHJlYWNoYWJsZS4AAAAAAAAMVW5hdXRob3JpemVkAAAAAwAAAAAAAAAGUGF1c2VkAAAAAAAEAAAAAAAAAAxNYXRoT3ZlcmZsb3cAAAAFAAAAAAAAAAxVbmtub3duQXNzZXQAAABkAAAAAAAAAA9LZWVwZXJOb3RBY3RpdmUAAAAAZQAAAAAAAAAKV3JvbmdFcG9jaAAAAAAAZgAAAAAAAAASRXBvY2hBbHJlYWR5UG9zdGVkAAAAAABnAAAAAAAAABFTYW5pdHlCb3VuZEZhaWxlZAAAAAAAAGgAAAAAAAAAE0FtbUNyb3NzQ2hlY2tGYWlsZWQAAAAAaQAAAAAAAAATRGlzcHV0ZVdpbmRvd0Nsb3NlZAAAAABqAAAAAAAAAA5XZWlnaHRzSW52YWxpZAAAAAAAawAAAAAAAAASUmVmZXJlbmNlSW1tdXRhYmxlAAAAAABsAAAAAAAAABhSZWZlcmVuY2VSYXRlVW5hdmFpbGFibGUAAABtAAABiURpc3RpbmN0IGZyb20gYFNhbml0eUJvdW5kRmFpbGVkYCAoMTA0KSwgd2hpY2ggaXMgYWJvdXQgb25lIHBvc3RlZApgU2lnbmFsU2V0YCdzIGZpZWxkczsgdGhpcyBpcyBhYm91dCBjb21wdXRpbmcgdGhlIHNjb3JlIGZyb20gdGhlCnJpbmcgKG5vdCBlbm91Z2ggaGlzdG9yeSwgb3IgYSByZXF1aXJlZCB3aW5kb3cgcmVhZCBjYW1lIGJhY2sKZW1wdHkpLCBhIGRpZmZlcmVudCBmYWlsdXJlIG1vZGUgYSBjYWxsZXIgbWF5IHdhbnQgdG8gaGFuZGxlCmRpZmZlcmVudGx5IChmb3IgZXhhbXBsZTogcmV0cnkgbGF0ZXIgdnMuIGEgcGVybWFuZW50bHkgYmFkCnBvc3RpbmcpLiBSZXZpZXcgaXRlbSAiQWdncmVnYXRpb24gZmFpbHVyZXMgbXVzdCBub3QgcmV1c2UKU2FuaXR5Qm91bmRGYWlsZWQuIgAAAAAAABFBZ2dyZWdhdGlvbkZhaWxlZAAAAAAAAG4AAAC+YGFkZF9hc3NldGAgLyBgdXBkYXRlX2Fzc2V0YCByZWplY3QgYFJlZmVyZW5jZTo6QXNzZXRgIGluIHYxCihyZXZpZXcgZGVjaXNpb24gRDMpOiBubyBVU0QgcmF0ZSBpcyBkZWZpbmVkIGFueXdoZXJlIGluIHRoZSBzcGVjCmZvciBhbiBhc3NldCBwZWdnZWQgcmVmZXJlbmNlIChzZWUgdGhlIFBSJ3MgIlNwZWMgZGV2aWF0aW9ucyIpLgAAAAAAFVJlZmVyZW5jZU5vdFN1cHBvcnRlZAAAAAAAAG8AAAD8QURSLTAxMCAoZmVhdC9zdGFraW5nLCBpc3N1ZSAjNCBmaXgpOiBgcmVzb2x2ZV9zaWduYWxfZGlzcHV0ZV90aW1lb3V0YApjYWxsZWQgYmVmb3JlIGBTSUdOQUxfRElTUFVURV9SVUxJTkdfU0VDU2AgaGFzIHBhc3NlZCBzaW5jZSB0aGUKZGlzcHV0ZSBvcGVuZWQuIE5hbWVkIHRvIG1hdGNoIEFEUi0wMDIncyBgUnVsaW5nRGVhZGxpbmVOb3RSZWFjaGVkYApwcmVjZWRlbnQgZm9yIHRoZSBhbmFsb2dvdXMgZXZlbnQtcnVsaW5nIHRpbWVvdXQuAAAAGFJ1bGluZ0RlYWRsaW5lTm90UmVhY2hlZAAAAHAAAACDdGVjaG5pY2FsLWRvYy5tZCBTZWN0aW9uIDUuOSBTMTogYHN1Yl9lcG9jaF9zZWNzYCBzZXQgdG8gYSB2YWx1ZQpvdXRzaWRlIHRoZSBhbGxvd2VkIHNldCwgb3Igb25lIHRoYXQgZG9lcyBub3QgZGl2aWRlIDMsNjAwCmV2ZW5seS4AAAAAF0ludmFsaWRTdWJFcG9jaEludGVydmFsAAAAAHEAAAC0dGVjaG5pY2FsLWRvYy5tZCBTZWN0aW9uIDUuOSBTNDogYGJ1aWxkX2hvdXJgIGNhbGxlZCB3aGlsZSBhdApsZWFzdCBvbmUgb2YgdGhlIGhvdXIncyBzdWItZXBvY2hzIGlzIHN0aWxsIFBlbmRpbmcgb3IgRGlzcHV0ZWQsCmkuZS4gbm90IHlldCBGaW5hbCwgcGVybWFuZW50bHkgbWlzc2luZywgb3IgcmVqZWN0ZWQuAAAAEFN1YkVwb2NoTm90UmVhZHkAAAByAAABG3RlY2huaWNhbC1kb2MubWQgU2VjdGlvbiA1LjkgUzI6IGFuIGhvdXIgaXMgcG9zdGVkIHRocm91Z2gKZXhhY3RseSBvbmUgcGF0aCwgc3ViLWVwb2NoIG9yIGhvdXJseSBmYWxsYmFjaywgbmV2ZXIgYm90aC4gQQpzdWItZXBvY2ggcG9zdCBhZ2FpbnN0IGFuIGhvdXIgYWxyZWFkeSBwb3N0ZWQgdGhyb3VnaCB0aGUKZmFsbGJhY2sgcGF0aCwgb3IgYSBmYWxsYmFjayBwb3N0IGFnYWluc3QgYW4gaG91ciB0aGF0IGFscmVhZHkKaGFzIGEgc3ViLWVwb2NoIHBvc3RlZCwgYm90aCByZXR1cm4gdGhpcy4AAAAAEUhvdXJBbHJlYWR5UG9zdGVkAAAAAAAAcw==",
        "AAAABQAAACx0ZWNobmljYWwtZG9jLm1kIFNlY3Rpb24gNS45IFM0LCBTZWN0aW9uIDEzLgAAAAAAAAAJSG91ckJ1aWx0AAAAAAAAAgAAAAVzeWxveAAAAAAAAApob3VyX2J1aWx0AAAAAAAEAAAAAAAAAAVhc3NldAAAAAAAABMAAAABAAAAAAAAAARob3VyAAAABgAAAAAAAAAAAAAAD3N1Yl9jb3VudF9maW5hbAAAAAAEAAAAAAAAAAAAAAAMY292ZXJhZ2VfYnBzAAAABAAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAACkFzc2V0U3RhbGUAAAAAAAIAAAAFc3lsb3gAAAAAAAALYXNzZXRfc3RhbGUAAAAAAgAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAQAAAAAAAAAKbGFzdF9lcG9jaAAAAAAABgAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAC0JhbmRDaGFuZ2VkAAAAAAIAAAAFc3lsb3gAAAAAAAAMYmFuZF9jaGFuZ2VkAAAABAAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAQAAAAAAAAAEZnJvbQAAB9AAAAAEQmFuZAAAAAAAAAAAAAAAAnRvAAAAAAfQAAAABEJhbmQAAAAAAAAAAAAAAAVlcG9jaAAAAAAAAAYAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAADFNjb3JlVXBkYXRlZAAAAAIAAAAFc3lsb3gAAAAAAAANc2NvcmVfdXBkYXRlZAAAAAAAAAQAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAEAAAAAAAAABWVwb2NoAAAAAAAABgAAAAAAAAAAAAAABXNjb3JlAAAAAAAABAAAAAAAAAAAAAAAD2Zvcm11bGFfdmVyc2lvbgAAAAAEAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAADFNpZ25hbHNGaW5hbAAAAAIAAAAFc3lsb3gAAAAAAAANc2lnbmFsc19maW5hbAAAAAAAAAIAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAEAAAAAAAAABWVwb2NoAAAAAAAABgAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAADVNpZ25hbHNQb3N0ZWQAAAAAAAACAAAABXN5bG94AAAAAAAADnNpZ25hbHNfcG9zdGVkAAAAAAAFAAAAAAAAAAVhc3NldAAAAAAAABMAAAABAAAAAAAAAAVlcG9jaAAAAAAAAAYAAAAAAAAAAAAAAAZrZWVwZXIAAAAAABMAAAAAAAAAAAAAAAtpbnB1dHNfaGFzaAAAAAPuAAAAIAAAAAAAAAAAAAAADXBlbmRpbmdfdW50aWwAAAAAAAAGAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAD1NpZ25hbHNEaXNwdXRlZAAAAAACAAAABXN5bG94AAAAAAAAEHNpZ25hbHNfZGlzcHV0ZWQAAAAEAAAAAAAAAAVhc3NldAAAAAAAABMAAAABAAAAAAAAAAVlcG9jaAAAAAAAAAYAAAAAAAAAAAAAAAhkaXNwdXRlcgAAABMAAAAAAAAAAAAAAAhhbHRfaGFzaAAAA+4AAAAgAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAD1NpZ25hbHNSZXNvbHZlZAAAAAACAAAABXN5bG94AAAAAAAAEHNpZ25hbHNfcmVzb2x2ZWQAAAAEAAAAAAAAAAVhc3NldAAAAAAAABMAAAABAAAAAAAAAAVlcG9jaAAAAAAAAAYAAAAAAAAAAAAAAAtrZWVwZXJfd2lucwAAAAABAAAAAAAAAAAAAAAGcmVhc29uAAAAAAPuAAAAIAAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAD1N1YlNpZ25hbHNGaW5hbAAAAAACAAAABXN5bG94AAAAAAAAEXN1Yl9zaWduYWxzX2ZpbmFsAAAAAAAAAwAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAQAAAAAAAAAEaG91cgAAAAYAAAAAAAAAAAAAAANzdWIAAAAABAAAAAAAAAAC",
        "AAAABQAAADB0ZWNobmljYWwtZG9jLm1kIFNlY3Rpb24gNS45ICh2MS41KSwgU2VjdGlvbiAxMy4AAAAAAAAAEFN1YlNpZ25hbHNQb3N0ZWQAAAACAAAABXN5bG94AAAAAAAAEnN1Yl9zaWduYWxzX3Bvc3RlZAAAAAAABgAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAQAAAAAAAAAEaG91cgAAAAYAAAAAAAAAAAAAAANzdWIAAAAABAAAAAAAAAAAAAAABmtlZXBlcgAAAAAAEwAAAAAAAAAAAAAAC2lucHV0c19oYXNoAAAAA+4AAAAgAAAAAAAAAAAAAAANcGVuZGluZ191bnRpbAAAAAAAAAYAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAAEUVuZHBvaW50RmluYWxpemVkAAAAAAAAAgAAAAVzeWxveAAAAAAAABJlbmRwb2ludF9maW5hbGl6ZWQAAAAAAAMAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAEAAAAAAAAABWVwb2NoAAAAAAAABgAAAAAAAAAAAAAABnN0YXR1cwAAAAAH0AAAAA5FbmRwb2ludFN0YXR1cwAAAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAElN1YlNpZ25hbHNEaXNwdXRlZAAAAAAAAgAAAAVzeWxveAAAAAAAABRzdWJfc2lnbmFsc19kaXNwdXRlZAAAAAUAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAEAAAAAAAAABGhvdXIAAAAGAAAAAAAAAAAAAAADc3ViAAAAAAQAAAAAAAAAAAAAAAhkaXNwdXRlcgAAABMAAAAAAAAAAAAAAAhhbHRfaGFzaAAAA+4AAAAgAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAElN1YlNpZ25hbHNSZXNvbHZlZAAAAAAAAgAAAAVzeWxveAAAAAAAABRzdWJfc2lnbmFsc19yZXNvbHZlZAAAAAQAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAEAAAAAAAAABGhvdXIAAAAGAAAAAAAAAAAAAAADc3ViAAAAAAQAAAAAAAAAAAAAAAtrZWVwZXJfd2lucwAAAAABAAAAAAAAAAI=",
        "AAAABQAAACx0ZWNobmljYWwtZG9jLm1kIFNlY3Rpb24gNS45IFMxLCBTZWN0aW9uIDEzLgAAAAAAAAATU3ViRXBvY2hTZWNzQ2hhbmdlZAAAAAACAAAABXN5bG94AAAAAAAAFnN1Yl9lcG9jaF9zZWNzX2NoYW5nZWQAAAAAAAMAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAEAAAAAAAAADnN1Yl9lcG9jaF9zZWNzAAAAAAAGAAAAAAAAAAAAAAATZWZmZWN0aXZlX2Zyb21faG91cgAAAAAGAAAAAAAAAAI=",
        "AAAABQAAACVBRFItMDEwIChmZWF0L3N0YWtpbmcsIGlzc3VlICM0IGZpeCkuAAAAAAAAAAAAABVTaWduYWxEaXNwdXRlVGltZWRPdXQAAAAAAAACAAAABXN5bG94AAAAAAAAGHNpZ25hbF9kaXNwdXRlX3RpbWVkX291dAAAAAQAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAEAAAAAAAAABWVwb2NoAAAAAAAABgAAAAAAAAAAAAAACGRpc3B1dGVyAAAAEwAAAAAAAAAAAAAACWNvbW1pdHRlZQAAAAAAABMAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAAGFN1YlNpZ25hbERpc3B1dGVUaW1lZE91dAAAAAIAAAAFc3lsb3gAAAAAAAAcc3ViX3NpZ25hbF9kaXNwdXRlX3RpbWVkX291dAAAAAUAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAEAAAAAAAAABGhvdXIAAAAGAAAAAAAAAAAAAAADc3ViAAAAAAQAAAAAAAAAAAAAAAhkaXNwdXRlcgAAABMAAAAAAAAAAAAAAAljb21taXR0ZWUAAAAAAAATAAAAAAAAAAI=",
        "AAAAAgAAAAAAAAAAAAAABEJhbmQAAAAFAAAAAAAAAAAAAAAGTm9ybWFsAAAAAAAAAAAAAAAAAAVXYXRjaAAAAAAAAAAAAAAAAAAAB1dhcm5pbmcAAAAAAAAAAAAAAAAIRGlzdHJlc3MAAAAAAAAAUlNldCB3aGVuIGEgY3JlZGl0IGV2ZW50IGlzIERlY2xhcmVkOyBzdGlja3kgdW50aWwgZ292ZXJuYW5jZQpyZS1lbmFibGVzIHRoZSBhc3NldC4AAAAAAAVFdmVudAAAAA==",
        "AAAAAQAAAEpUaGUgbGF0ZXN0IGNvbXB1dGVkIHJpc2sgc2NvcmUgZm9yIGFuIGFzc2V0LiB0ZWNobmljYWwtZG9jLm1kIFNlY3Rpb24gNC4yLgAAAAAAAAAAAAlSaXNrU2NvcmUAAAAAAAAFAAAAAAAAAARiYW5kAAAH0AAAAARCYW5kAAAAAAAAAAVlcG9jaAAAAAAAAAYAAAAAAAAAD2Zvcm11bGFfdmVyc2lvbgAAAAAEAAAACDAuLj0xMDAuAAAABXNjb3JlAAAAAAAABAAAAAAAAAAFc3RhbGUAAAAAAAAB",
        "AAAAAQAAAOdPbmUgZXBvY2ggc2xvdCBvZiB0aGUgcGVyIGFzc2V0IHJpbmcgYnVmZmVyIHRoYXQgVGllciAxIGNoZWNrcywgdGhlCmNvdmVyIGdhdGUgYW5kIHRoZSAyNCBob3VyIGFuZCA3IGRheSBhZ2dyZWdhdGVzIHJlYWQgaW4gYSBzaW5nbGUgZW50cnksCmluc3RlYWQgb2Ygc2VwYXJhdGUgYFNpZ25hbHMoYXNzZXQsIGVwb2NoKWAgZW50cmllcy4KdGVjaG5pY2FsLWRvYy5tZCBTZWN0aW9uIDUuOCwgQURSLTAwNS4AAAAAAAAAAAhSaW5nU2xvdAAAAAwAAAAAAAAAEGF1dGhfcmV2b2NhdGlvbnMAAAAEAAAAAAAAAA9jbGF3YmFja19hbW91bnQAAAAACwAAAAAAAAAIZW5kcG9pbnQAAAfQAAAADkVuZHBvaW50U3RhdHVzAAAAAAAAAAAABWVwb2NoAAAAAAAABgAAAAAAAAAObGlxdWlkaXR5XzJwY3QAAAAAAAsAAAAAAAAACXBlZ19yYXRpbwAAAAAAAAsAAAA9TGVkZ2VyIHRpbWVzdGFtcCBhZnRlciB3aGljaCBhIGBQZW5kaW5nYCBzbG90IHJlYWRzIGFzIEZpbmFsLgAAAAAAAA1wZW5kaW5nX3VudGlsAAAAAAAABgAABABTZWN0aW9uIDUuOSBTNC9TNSAodjEuNSk6IGhvdyBtYW55IG9mIHRoaXMgaG91cidzIG93bgpzdWItZXBvY2hzICgwIHRvIDEyLCBuZXZlciBtb3JlLCBgU1VCX1JJTkdfU0xPVFNgJ3Mgb3duIHVwcGVyCmJvdW5kIG9uIGBzdWJfZXBvY2hzX3Blcl9ob3VyYCkgY3VycmVudGx5IGNvbnRyaWJ1dGUgdG8gdGhpcwpzbG90J3Mgb3duIGZpZWxkcywgd2hlbiB0aGlzIGhvdXIgaXMgb24gdGhlIHN1Yi1lcG9jaCBwb3N0aW5nCnBhdGguIGBOb25lYCBmb3IgYW4gaG91ciBvbiB0aGUgaG91cmx5IGZhbGxiYWNrIHBhdGggKHdob3NlCmBwZWdfcmF0aW9gIGV0Yy4gYXJlIHRoZSByZWFsLCBzaW5nbGUgcG9zdGVkIHJlYWRpbmcsIGNvbnRlc3RlZApvciBub3QsIHdpdGggbm8gc3ViLWVwb2NoIGNvdmVyYWdlIGNvbmNlcHQpIGFuZCBmb3IgYW4gaG91cgp0aGF0IGhhcyBuZXZlciBoYWQgYSBzdWItZXBvY2ggcG9zdGVkIGF0IGFsbC4KCmBTb21lKG4pYCB0ZWxscyB0d28gdGhpbmdzIGFwYXJ0IHRoYXQgYHN0YXRlYCBhbG9uZSBjYW5ub3Q6CndoaWNoIHBvc3RpbmcgcGF0aCBwcm9kdWNlZCBhIGBEaXNwdXRlZGAgc2xvdCAob25seSB0aGUKc3ViLWVwb2NoIHBhdGggZXZlciBzZXRzIHRoaXMgdG8gYFNvbWVgOyBhbiBob3VyIGRpc3B1dGVkCnRocm91Z2ggdGhlIGhvdXJseSBmYWxsYmFjaywgd2hvc2UgYHBlZ19yYXRpb2AgSVMgdGhlCmNvbnRlc3RlZCB2YWx1ZSBpdHNlbGYsIHN0YXlzIGBOb25lYCksIGFuZCB3aGV0aGVyIGEgYERpc3B1dGVkYApzdWItZXBvY2gtcGF0aCBzbG90IHN0aWxsIGhvbGRzIHVzYWJsZSBkYXRhIGZyb20gaXRzIE9USEVSLApub24tZGlzcHV0ZWQgc3ViLWVwb2NocyAoYFNvbWUobiA+IDApYCkgb3IgZ2VudWluZWx5IG5vbmUgYXQKYWxsIChgU29tZSgwKWAsIGV2ZXJ5IHBvc3RlZCBzdWItZXBvY2ggY3VycmVudGx5IGRpc3B1dGVkKSDigJQKZGVsaWJlcmF0ZWx5IG5vdCByZWFkIG9mZiBgcGVnX3JhdGlvYCBvciBgcGVuZGluZ191bnRpbGAsIHNpbmNlCmJvdGggYWxyZWFkeSBjAAAAGHByb3Zpc2lvbmFsX3N1Yl9jb3ZlcmFnZQAAA+gAAAAEAAAAAAAAAA5yZWRlbXB0aW9uX25ldAAAAAAACwAAAAAAAAAFc3RhdGUAAAAAAAfQAAAACVNsb3RTdGF0ZQAAAAAAAAAAAAAGc3VwcGx5AAAAAAALAAAAAAAAABFzdXBwbHlfY2hhbmdlX2JwcwAAAAAAAAU=",
        "AAAAAQAAAepJZGVudGlmaWVzIG9uZSBzdWItZXBvY2ggYXQgdGhlIHBvc3RpbmcvZGlzcHV0ZSBBUEkgYm91bmRhcnk6CmBob3VyYCwgYW5kIGBzdWJgLCBpdHMgcG9zaXRpb24gd2l0aGluIHRoYXQgaG91ciB1bmRlciB3aGljaGV2ZXIKYHN1Yl9lcG9jaF9zZWNzYCBnb3Zlcm5lZCBpdC4gdGVjaG5pY2FsLWRvYy5tZCBTZWN0aW9uIDUuOSBTMi4KYFN1Yihhc3NldClgJ3Mgb3duIHJpbmcgc3RvcmVzIGEgZGlmZmVyZW50IGlkZW50aXR5IGludGVybmFsbHkKKGBzdWJfc3RhcnRgLCB0aGUgc3ViLWVwb2NoJ3MgYWJzb2x1dGUgc3RhcnQgdGltZSwgU2VjdGlvbiA1LjkgUzMpLApzaW5jZSB3aGF0IGBzdWJgIG1lYW5zIGRlcGVuZHMgb24gYW4gaW50ZXJ2YWwgdGhhdCBjYW4gbGF0ZXIKY2hhbmdlOyBgU3ViRXBvY2hgIGlzIHRoZSBodW1hbi1tZWFuaW5nZnVsIHBhaXIgYSBrZWVwZXIgcG9zdHMKYWdhaW5zdCwgY29udmVydGVkIGludGVybmFsbHkgdG8gYHN1Yl9zdGFydGAuAAAAAAAAAAAACFN1YkVwb2NoAAAAAgAAAAAAAAAEaG91cgAAAAYAAAAAAAAAA3N1YgAAAAAE",
        "AAAAAgAAAAAAAAAAAAAACVJlZmVyZW5jZQAAAAAAAAMAAAAAAAAADzEgdW5pdCA9IDEgVVNELgAAAAADVXNkAAAAAAEAAABXSVNPIDQyMTcgY29kZSBhbmQgdGhlIEZYIHJhdGUgYmFzaXMgaXQgaXMgcHJpY2VkIGFnYWluc3QsIHZpYSB0aGUKRlggYWRhcHRlciAoQURSLTAwNikuAAAAAARGaWF0AAAAAgAAABEAAAfQAAAADEZ4UmF0ZVNvdXJjZQAAAAEAAAAgUGVnZ2VkIHRvIGFub3RoZXIgb25jaGFpbiBhc3NldC4AAAAFQXNzZXQAAAAAAAABAAAAEw==",
        "AAAAAQAAAElPbmUgZXBvY2gncyBtZWFzdXJlZCBzaWduYWxzIGZvciBvbmUgYXNzZXQuIHRlY2huaWNhbC1kb2MubWQgU2VjdGlvbiA0LjEuAAAAAAAAAAAAAAlTaWduYWxTZXQAAAAAAAAMAAAAvlNvdXJjZWQgb25seSBmcm9tIGBTdGFraW5nOjphZ2dyZWdhdGVgLiBSaXNrT3JhY2xlIG92ZXJ3cml0ZXMgdGhpcwpmaWVsZCBvbiBgcG9zdF9zaWduYWxzYCBhbmQgYGZpbmFsaXplX2VuZHBvaW50YDsgYW55IGtlZXBlciBzdXBwbGllZAp2YWx1ZSBpcyBpZ25vcmVkLCBzbyBrZWVwZXJzIHBvc3QgYFVua25vd25gIChBRFItMDA1KS4AAAAAAAhlbmRwb2ludAAAB9AAAAAORW5kcG9pbnRTdGF0dXMAAAAAAAAAAAAFZXBvY2gAAAAAAAAGAAAAJkhhc2ggb2YgcmF3IGlucHV0cywgZm9yIHJlY29tcHV0YXRpb24uAAAAAAALaW5wdXRzX2hhc2gAAAAD7gAAACAAAAAAAAAADmlzc3Vlcl9hY3Rpb25zAAAAAAfQAAAADUlzc3VlckFjdGlvbnMAAAAAAAAjRGVwdGggd2l0aGluIDIlIG9mIHBlZywgVVNEQyB1bml0cy4AAAAADmxpcXVpZGl0eV8ycGN0AAAAAAALAAAAIlRXQVAgcHJpY2UgLyByZWZlcmVuY2UsIFNDQUxFIDFlNy4AAAAAAAlwZWdfcmF0aW8AAAAAAAALAAAAjzEwdGggcGVyY2VudGlsZSBvZiB0aGUgdm9sdW1lIHdlaWdodGVkIHByaWNlIHNlcmllcyBpbiB0aGUgd2luZG93LApkaXZpZGVkIGJ5IHRoZSByZWZlcmVuY2UsIFNDQUxFIDFlNy4gQSBzaW5nbGUgd2ljayBjYW5ub3QgbW92ZSBpdAooQURSLTAwNSkuAAAAAA1wZWdfcmF0aW9fcDEwAAAAAAAACwAAABFMZWRnZXIgdGltZXN0YW1wLgAAAAAAAAlwb3N0ZWRfYXQAAAAAAAAGAAAAAAAAAAZwb3N0ZXIAAAAAABMAAAAwTmV0IGJ1cm5lZCBtaW51cyBpc3N1ZWQgdGhpcyBlcG9jaCwgYXNzZXQgdW5pdHMuAAAADnJlZGVtcHRpb25fbmV0AAAAAAALAAAAnFRvdGFsIGNpcmN1bGF0aW5nIHN1cHBseSwgYXNzZXQgdW5pdHMuIEtlZXBlciBwb3N0ZWQgZnJvbSBsZWRnZXIgYXNzZXQKc3RhdHM7IFNFUC00MSBoYXMgbm8gYHRvdGFsX3N1cHBseWAsIHNvIGl0IGNhbm5vdCBiZSBjcm9zcyBjaGVja2VkCm9uY2hhaW4gKEFEUi0wMDUpLgAAAAZzdXBwbHkAAAAAAAsAAAASdnMgcHJldmlvdXMgZXBvY2guAAAAAAARc3VwcGx5X2NoYW5nZV9icHMAAAAAAAAF",
        "AAAAAgAAAD9GaW5hbGl0eSBvZiBvbmUgcmluZyBidWZmZXIgc2xvdC4gdGVjaG5pY2FsLWRvYy5tZCBTZWN0aW9uIDUuOC4AAAAAAAAAAAlTbG90U3RhdGUAAAAAAAAEAAAAAAAAAEROZXZlciBwb3N0ZWQsIG9yIG92ZXJ0dXJuZWQgYW5kIG5vdCB5ZXQgcmVwb3N0ZWQuIENvdW50cyBhcyBtaXNzaW5nLgAAAAVFbXB0eQAAAAAAAAAAAABSUG9zdGVkLCBpbnNpZGUgaXRzIGRpc3B1dGUgd2luZG93LiBSZWFkcyBhcyBGaW5hbCBvbmNlCmBwZW5kaW5nX3VudGlsYCBoYXMgcGFzc2VkLgAAAAAAB1BlbmRpbmcAAAAAAAAAAHdQb3N0ZWQgYW5kIGRpc3B1dGVkLiBOb3QgZmluYWwgdW50aWwgdGhlIGRpc3B1dGUgcmVzb2x2ZXM7IGFuCm92ZXJ0dXJuZWQgc2xvdCByZXR1cm5zIHRvIEVtcHR5IGZvciByZXBvc3RpbmcgKEFEUi0wMDUpLgAAAAAIRGlzcHV0ZWQAAAAAAAAAAAAAAAVGaW5hbAAAAA==",
        "AAAAAQAAAFtDb25maWd1cmF0aW9uIGZvciBvbmUgaXNzdWVkIGFzc2V0IGNvdmVyZWQgYnkgdGhlIFJpc2tPcmFjbGUuCnRlY2huaWNhbC1kb2MubWQgU2VjdGlvbiA0LjEuAAAAAAAAAAALQXNzZXRDb25maWcAAAAACQAAAEJPcHRpb25hbCBTb3JvYmFuIEFNTSBwcmljZSBhZGFwdGVycyAoYFByaWNlQWRhcHRlcmAsIFNlY3Rpb24gMy4zKS4AAAAAAAxhbW1fYWRhcHRlcnMAAAPqAAAAEwAAADNTdGVsbGFyIEFzc2V0IENvbnRyYWN0IGFkZHJlc3Mgb2YgdGhlIGlzc3VlZCBhc3NldC4AAAAABWFzc2V0AAAAAAAAEwAAAAAAAAAHZW5hYmxlZAAAAAABAAAAXUZYIGFkYXB0ZXIgKGBGeEFkYXB0ZXJgLCBTZWN0aW9uIDMuMykuIFJlcXVpcmVkIHdoZW4gYHJlZmVyZW5jZWAgaXMKYEZpYXRgLCBgTm9uZWAgb3RoZXJ3aXNlLgAAAAAAAApmeF9hZGFwdGVyAAAAAAPoAAAAEwAAABtGb3IgU0VQLTEgLyBTRVAtMjQgcHJvYmluZy4AAAAAC2hvbWVfZG9tYWluAAAAABAAAAAeQ2xhc3NpYyBpc3N1ZXIgYWNjb3VudCAoRy4uLikuAAAAAAAGaXNzdWVyAAAAAAATAAAAcklzc3VlciBhY2NvdW50IGZsYWdzLiBJc3N1ZXJGcmVlemUgZGVmaW5pdGlvbnMgY2FuIG9ubHkgYmUgcmVnaXN0ZXJlZAp3aGVuIHRoZXNlIG1ha2UgYSBmcmVlemUgcG9zc2libGUgKEFEUi0wMDYpLgAAAAAADGlzc3Vlcl9mbGFncwAAB9AAAAALSXNzdWVyRmxhZ3MAAAAAuUluIFVTREMgdW5pdHMuIEEgRGVwZWcgd2luZG93IGNvdW50cyBvbmx5IGlmIHRoZSBtZWRpYW4KYGxpcXVpZGl0eV8ycGN0YCBvZiB0aGUgNyBkYXlzIGJlZm9yZSB0aGUgd2luZG93IHN0YXJ0ZWQgaXMgYXQgbGVhc3QKdGhpcyB2YWx1ZS4gTmV2ZXIgY29tcGFyZWQgYWdhaW5zdCBsaXZlIGxpcXVpZGl0eSAoQURSLTAwNSkuAAAAAAAADW1pbl9saXF1aWRpdHkAAAAAAAALAAAAlldoYXQgdGhlIGFzc2V0IHNob3VsZCBiZSB3b3J0aC4gRml4ZWQgYXQgYGFkZF9hc3NldGA6IGB1cGRhdGVfYXNzZXRgCnJlamVjdHMgYW55IGNoYW5nZSwgc28gZXZlcnkgZXZlbnQgZGVmaW5pdGlvbiB0aGF0IHBpbnMgaXQgc3RheXMKdmFsaWQgKEFEUi0wMDYpLgAAAAAACXJlZmVyZW5jZQAAAAAAB9AAAAAJUmVmZXJlbmNlAAAA",
        "AAAAAQAAAK5UaGUgY2xhc3NpYyBpc3N1ZXIgZmxhZ3MgdGhhdCBtYWtlIGFuIGlzc3VlciBmcmVlemUgcG9zc2libGUuIEFuCklzc3VlckZyZWV6ZSBkZWZpbml0aW9uIGNhbiBiZSByZWdpc3RlcmVkIG9ubHkgaWYgYXQgbGVhc3Qgb25lIGlzIHNldC4KdGVjaG5pY2FsLWRvYy5tZCBTZWN0aW9uIDQuMSwgQURSLTAwNi4AAAAAAAAAAAALSXNzdWVyRmxhZ3MAAAAAAgAAAD9BVVRIX1JFVk9DQUJMRTogdGhlIGlzc3VlciBjYW4gcmV2b2tlIGEgaG9sZGVyJ3MgYXV0aG9yaXphdGlvbi4AAAAADmF1dGhfcmV2b2NhYmxlAAAAAAABAAAANENMQVdCQUNLX0VOQUJMRUQ6IHRoZSBpc3N1ZXIgY2FuIGNsYXcgYmFjayBiYWxhbmNlcy4AAAAQY2xhd2JhY2tfZW5hYmxlZAAAAAE=",
        "AAAAAgAAALRXaGljaCBGWCByYXRlIGEgYFJlZmVyZW5jZTo6RmlhdGAgaXMgcHJpY2VkIGFnYWluc3QuIE1hdHRlcnMgd2hlcmV2ZXIgYW4Kb2ZmaWNpYWwgcmF0ZSBhbmQgYSBtYXJrZXQgKHBhcmFsbGVsKSByYXRlIGRpdmVyZ2UsIGZvciBleGFtcGxlIEFSUy4KdGVjaG5pY2FsLWRvYy5tZCBTZWN0aW9uIDQuMSwgQURSLTAwNi4AAAAAAAAADEZ4UmF0ZVNvdXJjZQAAAAIAAAAAAAAAOlRoZSByYXRlIHB1Ymxpc2hlZCBieSB0aGUgY2VudHJhbCBiYW5rIG9yIG9mZmljaWFsIGZpeGluZy4AAAAAAAhPZmZpY2lhbAAAAAAAAAAvVGhlIHJhdGUgYXQgd2hpY2ggdGhlIGN1cnJlbmN5IGFjdHVhbGx5IHRyYWRlcy4AAAAABk1hcmtldAAA",
        "AAAAAQAAAAAAAAAAAAAADUlzc3VlckFjdGlvbnMAAAAAAAAEAAAAAAAAABBhdXRoX3Jldm9jYXRpb25zAAAABAAAAAAAAAAPY2xhd2JhY2tfYW1vdW50AAAAAAsAAAAAAAAACWNsYXdiYWNrcwAAAAAAAAQAAAAAAAAADGZsYWdfY2hhbmdlcwAAAAQ=",
        "AAAAAgAAAAAAAAAAAAAADkVuZHBvaW50U3RhdHVzAAAAAAAEAAAAAAAAAAAAAAAHVW5rbm93bgAAAAAAAAAAAAAAAAJVcAAAAAAAAAAAAAAAAAAIRGVncmFkZWQAAAAAAAAAAAAAAAREb3du",
        "AAAAAQAAAdZQZXIgYXNzZXQgc3ViLWVwb2NoIGNvbmZpZ3VyYXRpb24uIHRlY2huaWNhbC1kb2MubWQgU2VjdGlvbiAxNS4xCmBTdWJFcG9jaENvbmZpZyhhc3NldClgLCBTZWN0aW9uIDUuOSBTMS4gYHN1Yl9lcG9jaF9zZWNzYCBpcyB0aGUKdmFsdWUgY3VycmVudGx5IGluIGVmZmVjdDsgYHBlbmRpbmdfc3ViX2Vwb2NoX3NlY3NgIGFuZApgZWZmZWN0aXZlX2Zyb21faG91cmAgZGVzY3JpYmUgYSBxdWV1ZWQgY2hhbmdlIHRoYXQgaGFzIG5vdCB5ZXQKdGFrZW4gZWZmZWN0IChib3RoIGBOb25lYCB3aGVuIG5vIGNoYW5nZSBpcyBwZW5kaW5nKS4gQSBjaGFuZ2UKbmV2ZXIgYXBwbGllcyBiZWZvcmUgYGVmZmVjdGl2ZV9mcm9tX2hvdXJgLCBzbyBubyBzdWItZXBvY2gKYWxyZWFkeSBwb3N0ZWQsIG9yIHBvc3RhYmxlIGJlZm9yZSB0aGF0IGJvdW5kYXJ5LCBpcyBldmVyCnJlaW50ZXJwcmV0ZWQgdW5kZXIgYSBkaWZmZXJlbnQgbGVuZ3RoLgAAAAAAAAAAAA5TdWJFcG9jaENvbmZpZwAAAAAAAwAAAAAAAAATZWZmZWN0aXZlX2Zyb21faG91cgAAAAPoAAAABgAAAAAAAAAWcGVuZGluZ19zdWJfZXBvY2hfc2VjcwAAAAAD6AAAAAYAAAAAAAAADnN1Yl9lcG9jaF9zZWNzAAAAAAAG" ]),
      options
    )
  }
  public readonly fromJSON = {
    band: this.txFromJSON<Result<Band>>,
        live: this.txFromJSON<Option<readonly [SubEpoch, SignalSet, SlotState]>>,
        ring: this.txFromJSON<Array<RingSlot>>,
        score: this.txFromJSON<Result<RiskScore>>,
        assets: this.txFromJSON<Array<string>>,
        latest: this.txFromJSON<Option<SignalSet>>,
        signals: this.txFromJSON<Option<SignalSet>>,
        is_final: this.txFromJSON<boolean>,
        is_stale: this.txFromJSON<boolean>,
        add_asset: this.txFromJSON<Result<void>>,
        build_hour: this.txFromJSON<Result<void>>,
        initialize: this.txFromJSON<Result<void>>,
        check_stale: this.txFromJSON<Result<boolean>>,
        first_epoch: this.txFromJSON<Option<u64>>,
        set_formula: this.txFromJSON<Result<void>>,
        asset_config: this.txFromJSON<Option<AssetConfig>>,
        newest_epoch: this.txFromJSON<Option<u64>>,
        post_signals: this.txFromJSON<Result<void>>,
        update_asset: this.txFromJSON<Result<void>>,
        disable_asset: this.txFromJSON<Result<void>>,
        reference_rate: this.txFromJSON<Result<i128>>,
        set_event_band: this.txFromJSON<Result<void>>,
        sub_peg_ratios: this.txFromJSON<Array<Option<i128>>>,
        dispute_signals: this.txFromJSON<Result<void>>,
        clear_event_band: this.txFromJSON<Result<void>>,
        effective_window: this.txFromJSON<Array<Option<SlotState>>>,
        median_liquidity: this.txFromJSON<i128>,
        post_sub_signals: this.txFromJSON<Result<void>>,
        sub_epoch_config: this.txFromJSON<Option<SubEpochConfig>>,
        event_in_progress: this.txFromJSON<boolean>,
        finalize_endpoint: this.txFromJSON<Result<void>>,
        overturned_signals: this.txFromJSON<Option<SignalSet>>,
        set_sub_epoch_secs: this.txFromJSON<Result<void>>,
        dispute_sub_signals: this.txFromJSON<Result<void>>,
        set_event_in_progress: this.txFromJSON<Result<void>>,
        resolve_signal_dispute: this.txFromJSON<Result<void>>,
        resolve_sub_signal_dispute: this.txFromJSON<Result<void>>,
        resolve_sub_dispute_timeout: this.txFromJSON<Result<void>>,
        sub_peg_ratios_in_span_batch: this.txFromJSON<Array<Array<Option<i128>>>>,
        resolve_signal_dispute_timeout: this.txFromJSON<Result<void>>
  }
}
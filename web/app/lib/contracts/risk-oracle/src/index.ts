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
    contractId: "CC6NJT4ZCIHZGVWFNV4XSKAQ3NHAUVPJLSXTXMKLRIUL5GZWXAEWE4PX",
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
  112: {message:"RulingDeadlineNotReached"}
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
  redemption_net: i128;
  state: SlotState;
  supply: i128;
  supply_change_bps: i32;
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

export interface Client {
  /**
   * Construct and simulate a band transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  band: ({asset}: {asset: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<Band>>>

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
        "AAAAAAAAALF0ZWNobmljYWwtZG9jLm1kIFNlY3Rpb24gNS44LCAxMi4xOiBvbmUgc3RvcmFnZSByZWFkLCBvbGRlc3Qgc2xvdApmaXJzdC4gU2VlIGBzdG9yYWdlOjpnZXRfcmluZ2AncyBkb2MgY29tbWVudCBmb3IgZXhhY3RseSB3aGF0CiJvbGRlc3QgZmlyc3QiIG1lYW5zIG9uY2UgdGhlIGJ1ZmZlciBoYXMgd3JhcHBlZC4AAAAAAAAEcmluZwAAAAEAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAEAAAPqAAAH0AAAAAhSaW5nU2xvdA==",
        "AAAAAAAAA8N0ZWNobmljYWwtZG9jLm1kIFNlY3Rpb24gMTIuMSwgNi4gUmV2aWV3IGl0ZW0gQzE6IGEgUFVSRSByZWFkLgpSZXR1cm5zIHdoYXRldmVyIGBSaXNrU2NvcmVgIGlzIGN1cnJlbnRseSBzdG9yZWQsIHdpdGggYHN0YWxlYApyZWNvbXB1dGVkIGZyZXNoIGFnYWluc3QgdGhlIGNsb2NrIChzbyBhIHNjb3JlIHRoYXQgd2FzIGZyZXNoCndoZW4gbGFzdCB3cml0dGVuIGJ1dCBoYXMgc2luY2UgZ29uZSBxdWlldCBpcyByZXBvcnRlZCBzdGFsZQp3aXRob3V0IG5lZWRpbmcgYSB3cml0ZSB0byBzYXkgc28pLiBOZXZlciBjYWxscwpgc3RvcmFnZTo6c2V0X3Njb3JlYCBvciBhbnkgb3RoZXIgd3JpdGU7IHRoZSBhY3R1YWwgY29tcHV0YXRpb24KaGFwcGVucyBpbiBgcmVjb21wdXRlX3Njb3JlYCwgY2FsbGVkIGZyb20gYHBvc3Rfc2lnbmFsc2AsIHRoZQpmaW5hbGl0eSBzd2VlcCwgYW5kIGBmaW5hbGl6ZV9lbmRwb2ludGAgKHNlZSB0aG9zZSBmb3IgZXhhY3RseQp3aGVuKS4KClJldmlldyBkZWNpc2lvbiBEMTogdGhlIHN0b3JlZCBgYmFuZGAgaXMgYWx3YXlzIHRoZSBwbGFpbgpoeXN0ZXJlc2lzIGJhbmQsIGNvbXB1dGVkIHdpdGggbm8ga25vd2xlZGdlIG9mIHRoZSBldmVudC1pbi0KcHJvZ3Jlc3MgZmxhZyAoc2VlIGByZWNvbXB1dGVfc2NvcmVgKSwgc28gdGhhdCBmbGlwcGluZyB0aGUKZmxhZyBvZmYgaXMgbmV2ZXIgY29uZnVzZWQgd2l0aCBhIGdlbnVpbmUgbmV3IGVwb2NoIG9mIGV2aWRlbmNlCmZvciB0aGUgaHlzdGVyZXNpcyBzdHJlYWsuIFRoZSAiZm9yY2VkIHRvIGF0IGxlYXN0IERpc3RyZXNzCndoaWxlIGluIHByb2dyZXNzIiBvdmVycmlkZSBpcyBhcHBsaWVkIGhlcmUgaW5zdGVhZCwgb24gZXZlcnkKcmVhZCwgd2hpY2ggYWxzbyBtYWtlcyBpdCB0YWtlIGVmZmVjdCBpbW1lZGlhdGVseSBvbgpgc2V0X2V2ZW50X2luX3Byb2dyZXNzYCB3aXRoIG5vIHJlY29tcHV0ZSByZXF1aXJlZC4AAAAABXNjb3JlAAAAAAAAAQAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAQAAA+kAAAfQAAAACVJpc2tTY29yZQAAAAAAAAM=",
        "AAAAAAAAAAAAAAAGYXNzZXRzAAAAAAAAAAAAAQAAA+oAAAAT",
        "AAAAAAAAAAAAAAAGbGF0ZXN0AAAAAAABAAAAAAAAAAVhc3NldAAAAAAAABMAAAABAAAD6AAAB9AAAAAJU2lnbmFsU2V0AAAA",
        "AAAAAAAAAAAAAAAHc2lnbmFscwAAAAACAAAAAAAAAAVhc3NldAAAAAAAABMAAAAAAAAABWVwb2NoAAAAAAAABgAAAAEAAAPoAAAH0AAAAAlTaWduYWxTZXQAAAA=",
        "AAAAAAAAALpSZXZpZXcgaXRlbSBDNTogd2hldGhlciBlcG9jaCBgZXBvY2hgIGlzIEVGRkVDVElWRUxZIGZpbmFsIHJpZ2h0Cm5vdzogaXRzIHN0b3JlZCBzdGF0ZSBpcyBgRmluYWxgLCBvciBpdCBpcyBgUGVuZGluZ2AgYW5kCmBwZW5kaW5nX3VudGlsYCBoYXMgYWxyZWFkeSBwYXNzZWQuIGBmYWxzZWAgZm9yIGEgbWlzc2luZyBlcG9jaC4AAAAAAAhpc19maW5hbAAAAAIAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAAAAAAFZXBvY2gAAAAAAAAGAAAAAQAAAAE=",
        "AAAAAAAAAAAAAAAIaXNfc3RhbGUAAAABAAAAAAAAAAVhc3NldAAAAAAAABMAAAABAAAAAQ==",
        "AAAAAAAAARF0ZWNobmljYWwtZG9jLm1kIFNlY3Rpb24gMTIuMS4gUmVqZWN0cyBhbiBhc3NldCB0aGF0IGlzIGFscmVhZHkKcmVnaXN0ZXJlZCAoYHVwZGF0ZV9hc3NldGAgaXMgZm9yIGNoYW5naW5nIG9uZSkuIFJldmlldyBkZWNpc2lvbgpEMzogYWxzbyByZWplY3RzIGBSZWZlcmVuY2U6OkFzc2V0YCAobm8gVVNEIHJhdGUgaXMgZGVmaW5lZAphbnl3aGVyZSBpbiB0aGUgc3BlYyBmb3IgYW4gYXNzZXQgcGVnZ2VkIHJlZmVyZW5jZTsgc2VlIHRoZSBQUidzCiJTcGVjIGRldmlhdGlvbnMiKS4AAAAAAAAJYWRkX2Fzc2V0AAAAAAAAAQAAAAAAAAADY2ZnAAAAB9AAAAALQXNzZXRDb25maWcAAAAAAQAAA+kAAAACAAAAAw==",
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
        "AAAAAAAAAPZ0ZWNobmljYWwtZG9jLm1kIFNlY3Rpb24gMTIuMSwgNS40LCA3LjguCgpSZWNvcmRzIHRoZSBkaXNwdXRlIGFuZCBsb2NrcyB0aGUgZGlzcHV0ZXIncyBib25kIGluIGBTdGFraW5nYC4KT25seSB0aGUgc2lnbmFsIGRpc3B1dGUgU1RBVEUgbGl2ZXMgaGVyZTsgdGhlIGJvbmQgaXRzZWxmIGlzIGhlbGQKYW5kIGxhdGVyIHNwbGl0IGJ5IGBTdGFraW5nYCBvbiBpbnN0cnVjdGlvbiBmcm9tCmByZXNvbHZlX3NpZ25hbF9kaXNwdXRlYC4AAAAAAA9kaXNwdXRlX3NpZ25hbHMAAAAABAAAAAAAAAAIZGlzcHV0ZXIAAAATAAAAAAAAAAVhc3NldAAAAAAAABMAAAAAAAAABWVwb2NoAAAAAAAABgAAAAAAAAAIYWx0X2hhc2gAAAPuAAAAIAAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAACN0ZWNobmljYWwtZG9jLm1kIFNlY3Rpb24gMTIuMSwgOC44LgAAAAAQY2xlYXJfZXZlbnRfYmFuZAAAAAEAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAQ1SZXZpZXcgaXRlbSBDNTogYSB3aW5kb3cgcmVhZCBvZiBlZmZlY3RpdmUgc3RhdGUgcGVyIGVwb2NoLCBmb3IKYEV2ZW50UmVnaXN0cnlgJ3MgVGllciAxIGNoZWNrcyAoU2VjdGlvbiA4LjIpLCBzbyBpdCBjYW4gbGVhcm4Kd2hpY2ggZXBvY2hzIGluIGEgd2luZG93IGFyZSBmaW5hbCB3aXRob3V0IG9uZSBjYWxsIHBlciBlcG9jaC4KTWlzc2luZyBlcG9jaHMgcmVhZCBgTm9uZWAsIHRoZSBzYW1lIGNvbnZlbnRpb24gYXMgYHJpbmdgJ3MKdW5kZXJseWluZyBzdG9yYWdlLgAAAAAAABBlZmZlY3RpdmVfd2luZG93AAAAAwAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAAAAAAtzdGFydF9lcG9jaAAAAAAGAAAAAAAAAAVjb3VudAAAAAAAAAQAAAABAAAD6gAAA+gAAAfQAAAACVNsb3RTdGF0ZQAAAA==",
        "AAAAAAAAARN0ZWNobmljYWwtZG9jLm1kIFNlY3Rpb24gMTEuMTogbWVkaWFuIG9mIHRoZSBuZXdlc3QgMTY4IHNsb3RzJwpgbGlxdWlkaXR5XzJwY3RgLCBmb3IgdGhlIGFzc2V0IHdpZGUgY292ZXIgY2FwLiBNaXNzaW5nIHNsb3RzIGluCnRoZSB3aW5kb3cgYXJlIGV4Y2x1ZGVkLCBub3QgdHJlYXRlZCBhcyB6ZXJvIGxpcXVpZGl0eSwgc28gYSBzaG9ydApydW4gb2YgbWlzc2luZyBlcG9jaHMgZG9lcyBub3QgY3JhdGVyIHRoZSBjYXAgdGhlIHdheSByZWFsIHplcm8KbGlxdWlkaXR5IHdvdWxkLgAAAAAQbWVkaWFuX2xpcXVpZGl0eQAAAAEAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAEAAAAL",
        "AAAAAAAAAS90ZWNobmljYWwtZG9jLm1kIFNlY3Rpb24gMTIuMSAoZmVhdC9ldmVudC1yZWdpc3RyeSBkZXNpZ24gbm90ZSwKcmV2aWV3IGl0ZW0gRDYpOiByZWFkLW9ubHksIG5vIGF1dGguIExldHMgYEV2ZW50UmVnaXN0cnlgIGFzc2VydAppbnZhcmlhbnQgRTQgKGl0cyBvd24gYWN0aXZlLWV2ZW50IGNvdW50IGFncmVlcyB3aXRoIHRoaXMgZmxhZykKZGlyZWN0bHksIHJhdGhlciB0aGFuIGluZmVycmluZyB0aGUgZmxhZyBvbmx5IHRocm91Z2ggaXRzIG9uZQp2aXNpYmxlIGVmZmVjdCBvbiBgYmFuZCgpYCdzIG93biBEaXN0cmVzcyBmbG9vci4AAAAAEWV2ZW50X2luX3Byb2dyZXNzAAAAAAAAAQAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAQAAAAE=",
        "AAAAAAAAATB0ZWNobmljYWwtZG9jLm1kIFNlY3Rpb24gMTIuMSwgNy40LiBSZWFkcyBgU3Rha2luZy5hZ2dyZWdhdGVgIGFuZApib29rcyBpdCBpbnRvIHRoZSBlcG9jaCdzIHJpbmcgc2xvdCBhbmQgYFNpZ25hbHNgIGVudHJ5IGlmCmBwb3N0X3NpZ25hbHNgIGhhZCBub3QgYWxyZWFkeSByZXNvbHZlZCBvbmUgYnkgdGhlIHRpbWUgaXQgY2xvc2VkOwp0aGVuIGNhbGxzIGBTdGFraW5nLnNldHRsZV9wcm9iZXNgIGV4YWN0bHkgb25jZSByZWdhcmRsZXNzLCBwZXIKU2VjdGlvbiA3LjQncyAiYm9va2VkIGV4YWN0bHkgb25jZSIgcmVxdWlyZW1lbnQuAAAAEWZpbmFsaXplX2VuZHBvaW50AAAAAAAAAgAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAAAAAAVlcG9jaAAAAAAAAAYAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAUNSZXZpZXcgaXRlbSBDNDogdGhlIGBTaWduYWxTZXRgIGFuIG92ZXJ0dXJuZWQgZXBvY2gncyBwb3N0aW5nIGhhZApiZWZvcmUgYHJlc29sdmVfc2lnbmFsX2Rpc3B1dGVgIG1vdmVkIGl0IG91dCBvZiBgc2lnbmFsc2AncyBsaXZlCmtleSwga2VwdCBmb3IgYXVkaXQuIGBOb25lYCBpZiBgZXBvY2hgIHdhcyBuZXZlciBvdmVydHVybmVkIChvcgp3YXMgb3ZlcnR1cm5lZCwgcmVwb3N0ZWQsIGFuZCBvdmVydHVybmVkIGFnYWluLCB3aGljaCBrZWVwcyBvbmx5CnRoZSBtb3N0IHJlY2VudCBvdmVydHVybiwgbm90IGEgZnVsbCBoaXN0b3J5IG9mIGV2ZXJ5IGF0dGVtcHQpLgAAAAASb3ZlcnR1cm5lZF9zaWduYWxzAAAAAAACAAAAAAAAAAVhc3NldAAAAAAAABMAAAAAAAAABWVwb2NoAAAAAAAABgAAAAEAAAPoAAAH0AAAAAlTaWduYWxTZXQAAAA=",
        "AAAAAAAAAlFSZXZpZXcgZGVjaXNpb24gRDEsIG5vdCBpbiB0aGUgb3JpZ2luYWwgU2VjdGlvbiAxMi4xIGxpc3QuIEF1dGg6CnRoZSByZWdpc3RyeSBjb250cmFjdCwgc2FtZSBwYXR0ZXJuIGFzIGBzZXRfZXZlbnRfYmFuZGAgLwpgY2xlYXJfZXZlbnRfYmFuZGAgKFNlY3Rpb24gMTYuMSkuIFdoaWxlIGB0cnVlYCwgYHNjb3JlKClgIGZsb29ycwp0aGUgYmFuZCBhdCBgRGlzdHJlc3NgIG9uIGV2ZXJ5IHJlYWQgKFNlY3Rpb24gNi4zJ3MgImZvcmNlZCB0bwpEaXN0cmVzcyBpZiBhIGNyZWRpdCBldmVudC4uLiBpcyBQcm9wb3NlZCwgQ2hhbGxlbmdlZCBvcgpFc2NhbGF0ZWQiKSwgaW5kZXBlbmRlbnQgb2YgdGhlIGh5c3RlcmVzaXMtcHJvdGVjdGVkIGJhbmQKYWN0dWFsbHkgc3RvcmVkOyBgUmlza09yYWNsZWAgbmV2ZXIgY2FsbHMgaW50byBgRXZlbnRSZWdpc3RyeWAgdG8KY2hlY2sgdGhpcyBpdHNlbGYsIG1hdGNoaW5nIHRoZSBpbnN0cnVjdGlvbiB0aGF0ICJ0aGUgb3JhY2xlCm5ldmVyIGNhbGxzIHRoZSByZWdpc3RyeSIg4oCUIHRoaXMgaXMgcHVzaGVkIGluLCB0aGUgc2FtZQpkaXJlY3Rpb24gYHNldF9ldmVudF9iYW5kYCBhbHJlYWR5IHdvcmtzLgAAAAAAABVzZXRfZXZlbnRfaW5fcHJvZ3Jlc3MAAAAAAAACAAAAAAAAAAVhc3NldAAAAAAAABMAAAAAAAAAC2luX3Byb2dyZXNzAAAAAAEAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAALR0ZWNobmljYWwtZG9jLm1kIFNlY3Rpb24gMTIuMSwgNS40LCA3LjguIEF1dGg6IHRoZSBjb21taXR0ZWUKYWRkcmVzcywgcmVhZCBmcmVzaCBmcm9tIGBHb3Zlcm5vci5jb21taXR0ZWUoKWAgb24gZXZlcnkgY2FsbCAodGhlCmNvbW1pdHRlZSBjYW4gcm90YXRlOyBgUmlza09yYWNsZWAgbmV2ZXIgY2FjaGVzIGl0KS4AAAAWcmVzb2x2ZV9zaWduYWxfZGlzcHV0ZQAAAAAABAAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAAAAAAVlcG9jaAAAAAAAAAYAAAAAAAAAC2tlZXBlcl93aW5zAAAAAAEAAAAAAAAABnJlYXNvbgAAAAAD7gAAACAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAA/lBRFItMDEwIChpc3N1ZSAjNCBmaXgpLiBQZXJtaXNzaW9ubGVzcywgY2FsbGFibGUgb25jZQpgU0lHTkFMX0RJU1BVVEVfUlVMSU5HX1NFQ1NgIGhhcyBwYXNzZWQgc2luY2UgYGRpc3B1dGVfc2lnbmFsc2AKb3BlbmVkIHRoaXMgZGlzcHV0ZSwgaWYgdGhlIGNvbW1pdHRlZSBzdGlsbCBoYXMgbm90IHJ1bGVkIHZpYQpgcmVzb2x2ZV9zaWduYWxfZGlzcHV0ZWAuIERlZmF1bHQgb3V0Y29tZSBtaXJyb3JzIEFEUi0wMDIncwpydWxlIGZvciBkYXRhIGJhY2tlZCBjbGFpbXM6IHRoZSBrZWVwZXIncyBwb3N0aW5nIHN0YW5kcyAoc2xvdApgRmluYWxgLCBzYW1lIGFzIGEgYGtlZXBlcl93aW5zOiB0cnVlYCBjb21taXR0ZWUgcnVsaW5nKS4gIkJvdGgKYm9uZHMgcmVsZWFzZWQgaW4gZnVsbCwgbm9ib2R5IHNsYXNoZWQiICh0aGUgdGFzaydzIG93bgp3b3JkaW5nKTogdGhlcmUgaXMgb25seSBvbmUgYWN0dWFsIGBCb25kS2V5OjpTaWduYWxEaXNwdXRlYApsb2NrIHRvIHJlbGVhc2UsIHRoZSBkaXNwdXRlcidzICh0ZWNobmljYWwtZG9jLm1kIFNlY3Rpb24gMjQuMgpub3RlcyBhIGtlZXBlciBoYXMgbm8gc3ltbWV0cmljIHBlci1zaWduYWwgYm9uZCBpbiB2MTsgb25seQpgc2xhc2hgLCBieSBhZGRyZXNzLCBldmVyIHRvdWNoZXMgYSBrZWVwZXIncyBzdGFrZSksIHNvIGluCnByYWN0aWNlIHRoaXMgbWVhbnMgdGhlIGRpc3B1dGVyJ3MgYm9uZCBpcyByZWZ1bmRlZAooYHJlbGVhc2VfYm9uZGAsIG5vdCBgZm9yZmVpdF9ib25kYCkgQU5EIHRoZSBrZWVwZXIncyBzdGFrZSBpcwpsZWZ0IHVudG91Y2hlZCAobm8gYHNsYXNoYCBjYWxsIGVpdGhlcikg4oCUIGJvdGggcGFydGllcyBjb21lCm91dCBleGFjdGx5IGFzIHRoZXkgd291bGQgZnJvbSBhIGBrZWVwZXJfd2luczogdHJ1ZWAgcnVsaW5nLAp3aGljaCBpcyB0aGUgY29tbWl0dGVlJ3Mgc2lsZW5jZSBiZWluZyByZWFkIGFzICJubyBldmlkZW5jZQp0aGUgcG9zdGluZyB3YXMgd3JvbmciLCBub3QgYXMgYSBsb3NzIGZvciBlaXRoZXIgc2lkZS4AAAAAAAAecmVzb2x2ZV9zaWduYWxfZGlzcHV0ZV90aW1lb3V0AAAAAAACAAAAAAAAAAVhc3NldAAAAAAAABMAAAAAAAAABWVwb2NoAAAAAAAABgAAAAEAAAPpAAAAAgAAAAM=",
        "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAAEgAAAAAAAAASQWxyZWFkeUluaXRpYWxpemVkAAAAAAABAAAAAAAAAA5Ob3RJbml0aWFsaXplZAAAAAAAAgAAAqlOZXZlciBhY3R1YWxseSByZXR1cm5lZCBieSBhbnkgY2FsbCBpbiB0aGlzIGNvbnRyYWN0OiBldmVyeQphdXRob3JpemF0aW9uIGNoZWNrIChgYWRkX2Fzc2V0YCwgYHVwZGF0ZV9hc3NldGAsIGBzZXRfZm9ybXVsYWAsCmBwb3N0X3NpZ25hbHNgLCBgZGlzcHV0ZV9zaWduYWxzYCwgYHJlc29sdmVfc2lnbmFsX2Rpc3B1dGVgLApgc2V0X2V2ZW50X2JhbmRgLCBgY2xlYXJfZXZlbnRfYmFuZGAsIGBzZXRfZXZlbnRfaW5fcHJvZ3Jlc3NgKQpnb2VzIHRocm91Z2ggU29yb2JhbidzIG5hdGl2ZSBgQWRkcmVzczo6cmVxdWlyZV9hdXRoKClgLCB3aGljaAp0cmFwcyB0aGUgaG9zdCBjYWxsIGRpcmVjdGx5IHJhdGhlciB0aGFuIHJldHVybmluZyBhIGBSZXN1bHRgCnRoaXMgY29udHJhY3QgY291bGQgd3JhcCBpbiBgRXJyb3I6OlVuYXV0aG9yaXplZGAuIEtlcHQgZm9yCmB0ZWNobmljYWwtZG9jLm1kYCBTZWN0aW9uIDE0IGNvZGUtbnVtYmVyIGNvbXBhdGliaWxpdHk7IHNlZQpgbWlzc2luZ19hdXRoX3RyYXBzX25hdGl2ZWx5X3JhdGhlcl90aGFuX3JldHVybmluZ191bmF1dGhvcml6ZWRgCmluIHRlc3QucnMgYW5kIHRoZSBQUidzICJSZXZpZXcgZml4ZXMiIHNlY3Rpb24gZm9yIHdoeSB0aGlzIGlzCmRvY3VtZW50ZWQgYXMgdW5yZWFjaGFibGUgcmF0aGVyIHRoYW4gdGVzdGVkIGFzIHJlYWNoYWJsZS4AAAAAAAAMVW5hdXRob3JpemVkAAAAAwAAAAAAAAAGUGF1c2VkAAAAAAAEAAAAAAAAAAxNYXRoT3ZlcmZsb3cAAAAFAAAAAAAAAAxVbmtub3duQXNzZXQAAABkAAAAAAAAAA9LZWVwZXJOb3RBY3RpdmUAAAAAZQAAAAAAAAAKV3JvbmdFcG9jaAAAAAAAZgAAAAAAAAASRXBvY2hBbHJlYWR5UG9zdGVkAAAAAABnAAAAAAAAABFTYW5pdHlCb3VuZEZhaWxlZAAAAAAAAGgAAAAAAAAAE0FtbUNyb3NzQ2hlY2tGYWlsZWQAAAAAaQAAAAAAAAATRGlzcHV0ZVdpbmRvd0Nsb3NlZAAAAABqAAAAAAAAAA5XZWlnaHRzSW52YWxpZAAAAAAAawAAAAAAAAASUmVmZXJlbmNlSW1tdXRhYmxlAAAAAABsAAAAAAAAABhSZWZlcmVuY2VSYXRlVW5hdmFpbGFibGUAAABtAAABiURpc3RpbmN0IGZyb20gYFNhbml0eUJvdW5kRmFpbGVkYCAoMTA0KSwgd2hpY2ggaXMgYWJvdXQgb25lIHBvc3RlZApgU2lnbmFsU2V0YCdzIGZpZWxkczsgdGhpcyBpcyBhYm91dCBjb21wdXRpbmcgdGhlIHNjb3JlIGZyb20gdGhlCnJpbmcgKG5vdCBlbm91Z2ggaGlzdG9yeSwgb3IgYSByZXF1aXJlZCB3aW5kb3cgcmVhZCBjYW1lIGJhY2sKZW1wdHkpLCBhIGRpZmZlcmVudCBmYWlsdXJlIG1vZGUgYSBjYWxsZXIgbWF5IHdhbnQgdG8gaGFuZGxlCmRpZmZlcmVudGx5IChmb3IgZXhhbXBsZTogcmV0cnkgbGF0ZXIgdnMuIGEgcGVybWFuZW50bHkgYmFkCnBvc3RpbmcpLiBSZXZpZXcgaXRlbSAiQWdncmVnYXRpb24gZmFpbHVyZXMgbXVzdCBub3QgcmV1c2UKU2FuaXR5Qm91bmRGYWlsZWQuIgAAAAAAABFBZ2dyZWdhdGlvbkZhaWxlZAAAAAAAAG4AAAC+YGFkZF9hc3NldGAgLyBgdXBkYXRlX2Fzc2V0YCByZWplY3QgYFJlZmVyZW5jZTo6QXNzZXRgIGluIHYxCihyZXZpZXcgZGVjaXNpb24gRDMpOiBubyBVU0QgcmF0ZSBpcyBkZWZpbmVkIGFueXdoZXJlIGluIHRoZSBzcGVjCmZvciBhbiBhc3NldCBwZWdnZWQgcmVmZXJlbmNlIChzZWUgdGhlIFBSJ3MgIlNwZWMgZGV2aWF0aW9ucyIpLgAAAAAAFVJlZmVyZW5jZU5vdFN1cHBvcnRlZAAAAAAAAG8AAAD8QURSLTAxMCAoZmVhdC9zdGFraW5nLCBpc3N1ZSAjNCBmaXgpOiBgcmVzb2x2ZV9zaWduYWxfZGlzcHV0ZV90aW1lb3V0YApjYWxsZWQgYmVmb3JlIGBTSUdOQUxfRElTUFVURV9SVUxJTkdfU0VDU2AgaGFzIHBhc3NlZCBzaW5jZSB0aGUKZGlzcHV0ZSBvcGVuZWQuIE5hbWVkIHRvIG1hdGNoIEFEUi0wMDIncyBgUnVsaW5nRGVhZGxpbmVOb3RSZWFjaGVkYApwcmVjZWRlbnQgZm9yIHRoZSBhbmFsb2dvdXMgZXZlbnQtcnVsaW5nIHRpbWVvdXQuAAAAGFJ1bGluZ0RlYWRsaW5lTm90UmVhY2hlZAAAAHA=",
        "AAAABQAAAAAAAAAAAAAACkFzc2V0U3RhbGUAAAAAAAIAAAAFc3lsb3gAAAAAAAALYXNzZXRfc3RhbGUAAAAAAgAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAQAAAAAAAAAKbGFzdF9lcG9jaAAAAAAABgAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAC0JhbmRDaGFuZ2VkAAAAAAIAAAAFc3lsb3gAAAAAAAAMYmFuZF9jaGFuZ2VkAAAABAAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAQAAAAAAAAAEZnJvbQAAB9AAAAAEQmFuZAAAAAAAAAAAAAAAAnRvAAAAAAfQAAAABEJhbmQAAAAAAAAAAAAAAAVlcG9jaAAAAAAAAAYAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAADFNjb3JlVXBkYXRlZAAAAAIAAAAFc3lsb3gAAAAAAAANc2NvcmVfdXBkYXRlZAAAAAAAAAQAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAEAAAAAAAAABWVwb2NoAAAAAAAABgAAAAAAAAAAAAAABXNjb3JlAAAAAAAABAAAAAAAAAAAAAAAD2Zvcm11bGFfdmVyc2lvbgAAAAAEAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAADFNpZ25hbHNGaW5hbAAAAAIAAAAFc3lsb3gAAAAAAAANc2lnbmFsc19maW5hbAAAAAAAAAIAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAEAAAAAAAAABWVwb2NoAAAAAAAABgAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAADVNpZ25hbHNQb3N0ZWQAAAAAAAACAAAABXN5bG94AAAAAAAADnNpZ25hbHNfcG9zdGVkAAAAAAAFAAAAAAAAAAVhc3NldAAAAAAAABMAAAABAAAAAAAAAAVlcG9jaAAAAAAAAAYAAAAAAAAAAAAAAAZrZWVwZXIAAAAAABMAAAAAAAAAAAAAAAtpbnB1dHNfaGFzaAAAAAPuAAAAIAAAAAAAAAAAAAAADXBlbmRpbmdfdW50aWwAAAAAAAAGAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAD1NpZ25hbHNEaXNwdXRlZAAAAAACAAAABXN5bG94AAAAAAAAEHNpZ25hbHNfZGlzcHV0ZWQAAAAEAAAAAAAAAAVhc3NldAAAAAAAABMAAAABAAAAAAAAAAVlcG9jaAAAAAAAAAYAAAAAAAAAAAAAAAhkaXNwdXRlcgAAABMAAAAAAAAAAAAAAAhhbHRfaGFzaAAAA+4AAAAgAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAAD1NpZ25hbHNSZXNvbHZlZAAAAAACAAAABXN5bG94AAAAAAAAEHNpZ25hbHNfcmVzb2x2ZWQAAAAEAAAAAAAAAAVhc3NldAAAAAAAABMAAAABAAAAAAAAAAVlcG9jaAAAAAAAAAYAAAAAAAAAAAAAAAtrZWVwZXJfd2lucwAAAAABAAAAAAAAAAAAAAAGcmVhc29uAAAAAAPuAAAAIAAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAEUVuZHBvaW50RmluYWxpemVkAAAAAAAAAgAAAAVzeWxveAAAAAAAABJlbmRwb2ludF9maW5hbGl6ZWQAAAAAAAMAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAEAAAAAAAAABWVwb2NoAAAAAAAABgAAAAAAAAAAAAAABnN0YXR1cwAAAAAH0AAAAA5FbmRwb2ludFN0YXR1cwAAAAAAAAAAAAI=",
        "AAAABQAAACVBRFItMDEwIChmZWF0L3N0YWtpbmcsIGlzc3VlICM0IGZpeCkuAAAAAAAAAAAAABVTaWduYWxEaXNwdXRlVGltZWRPdXQAAAAAAAACAAAABXN5bG94AAAAAAAAGHNpZ25hbF9kaXNwdXRlX3RpbWVkX291dAAAAAQAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAEAAAAAAAAABWVwb2NoAAAAAAAABgAAAAAAAAAAAAAACGRpc3B1dGVyAAAAEwAAAAAAAAAAAAAACWNvbW1pdHRlZQAAAAAAABMAAAAAAAAAAg==",
        "AAAAAgAAAAAAAAAAAAAABEJhbmQAAAAFAAAAAAAAAAAAAAAGTm9ybWFsAAAAAAAAAAAAAAAAAAVXYXRjaAAAAAAAAAAAAAAAAAAAB1dhcm5pbmcAAAAAAAAAAAAAAAAIRGlzdHJlc3MAAAAAAAAAUlNldCB3aGVuIGEgY3JlZGl0IGV2ZW50IGlzIERlY2xhcmVkOyBzdGlja3kgdW50aWwgZ292ZXJuYW5jZQpyZS1lbmFibGVzIHRoZSBhc3NldC4AAAAAAAVFdmVudAAAAA==",
        "AAAAAQAAAEpUaGUgbGF0ZXN0IGNvbXB1dGVkIHJpc2sgc2NvcmUgZm9yIGFuIGFzc2V0LiB0ZWNobmljYWwtZG9jLm1kIFNlY3Rpb24gNC4yLgAAAAAAAAAAAAlSaXNrU2NvcmUAAAAAAAAFAAAAAAAAAARiYW5kAAAH0AAAAARCYW5kAAAAAAAAAAVlcG9jaAAAAAAAAAYAAAAAAAAAD2Zvcm11bGFfdmVyc2lvbgAAAAAEAAAACDAuLj0xMDAuAAAABXNjb3JlAAAAAAAABAAAAAAAAAAFc3RhbGUAAAAAAAAB",
        "AAAAAQAAAOdPbmUgZXBvY2ggc2xvdCBvZiB0aGUgcGVyIGFzc2V0IHJpbmcgYnVmZmVyIHRoYXQgVGllciAxIGNoZWNrcywgdGhlCmNvdmVyIGdhdGUgYW5kIHRoZSAyNCBob3VyIGFuZCA3IGRheSBhZ2dyZWdhdGVzIHJlYWQgaW4gYSBzaW5nbGUgZW50cnksCmluc3RlYWQgb2Ygc2VwYXJhdGUgYFNpZ25hbHMoYXNzZXQsIGVwb2NoKWAgZW50cmllcy4KdGVjaG5pY2FsLWRvYy5tZCBTZWN0aW9uIDUuOCwgQURSLTAwNS4AAAAAAAAAAAhSaW5nU2xvdAAAAAsAAAAAAAAAEGF1dGhfcmV2b2NhdGlvbnMAAAAEAAAAAAAAAA9jbGF3YmFja19hbW91bnQAAAAACwAAAAAAAAAIZW5kcG9pbnQAAAfQAAAADkVuZHBvaW50U3RhdHVzAAAAAAAAAAAABWVwb2NoAAAAAAAABgAAAAAAAAAObGlxdWlkaXR5XzJwY3QAAAAAAAsAAAAAAAAACXBlZ19yYXRpbwAAAAAAAAsAAAA9TGVkZ2VyIHRpbWVzdGFtcCBhZnRlciB3aGljaCBhIGBQZW5kaW5nYCBzbG90IHJlYWRzIGFzIEZpbmFsLgAAAAAAAA1wZW5kaW5nX3VudGlsAAAAAAAABgAAAAAAAAAOcmVkZW1wdGlvbl9uZXQAAAAAAAsAAAAAAAAABXN0YXRlAAAAAAAH0AAAAAlTbG90U3RhdGUAAAAAAAAAAAAABnN1cHBseQAAAAAACwAAAAAAAAARc3VwcGx5X2NoYW5nZV9icHMAAAAAAAAF",
        "AAAAAgAAAAAAAAAAAAAACVJlZmVyZW5jZQAAAAAAAAMAAAAAAAAADzEgdW5pdCA9IDEgVVNELgAAAAADVXNkAAAAAAEAAABXSVNPIDQyMTcgY29kZSBhbmQgdGhlIEZYIHJhdGUgYmFzaXMgaXQgaXMgcHJpY2VkIGFnYWluc3QsIHZpYSB0aGUKRlggYWRhcHRlciAoQURSLTAwNikuAAAAAARGaWF0AAAAAgAAABEAAAfQAAAADEZ4UmF0ZVNvdXJjZQAAAAEAAAAgUGVnZ2VkIHRvIGFub3RoZXIgb25jaGFpbiBhc3NldC4AAAAFQXNzZXQAAAAAAAABAAAAEw==",
        "AAAAAQAAAElPbmUgZXBvY2gncyBtZWFzdXJlZCBzaWduYWxzIGZvciBvbmUgYXNzZXQuIHRlY2huaWNhbC1kb2MubWQgU2VjdGlvbiA0LjEuAAAAAAAAAAAAAAlTaWduYWxTZXQAAAAAAAAMAAAAvlNvdXJjZWQgb25seSBmcm9tIGBTdGFraW5nOjphZ2dyZWdhdGVgLiBSaXNrT3JhY2xlIG92ZXJ3cml0ZXMgdGhpcwpmaWVsZCBvbiBgcG9zdF9zaWduYWxzYCBhbmQgYGZpbmFsaXplX2VuZHBvaW50YDsgYW55IGtlZXBlciBzdXBwbGllZAp2YWx1ZSBpcyBpZ25vcmVkLCBzbyBrZWVwZXJzIHBvc3QgYFVua25vd25gIChBRFItMDA1KS4AAAAAAAhlbmRwb2ludAAAB9AAAAAORW5kcG9pbnRTdGF0dXMAAAAAAAAAAAAFZXBvY2gAAAAAAAAGAAAAJkhhc2ggb2YgcmF3IGlucHV0cywgZm9yIHJlY29tcHV0YXRpb24uAAAAAAALaW5wdXRzX2hhc2gAAAAD7gAAACAAAAAAAAAADmlzc3Vlcl9hY3Rpb25zAAAAAAfQAAAADUlzc3VlckFjdGlvbnMAAAAAAAAjRGVwdGggd2l0aGluIDIlIG9mIHBlZywgVVNEQyB1bml0cy4AAAAADmxpcXVpZGl0eV8ycGN0AAAAAAALAAAAIlRXQVAgcHJpY2UgLyByZWZlcmVuY2UsIFNDQUxFIDFlNy4AAAAAAAlwZWdfcmF0aW8AAAAAAAALAAAAjzEwdGggcGVyY2VudGlsZSBvZiB0aGUgdm9sdW1lIHdlaWdodGVkIHByaWNlIHNlcmllcyBpbiB0aGUgd2luZG93LApkaXZpZGVkIGJ5IHRoZSByZWZlcmVuY2UsIFNDQUxFIDFlNy4gQSBzaW5nbGUgd2ljayBjYW5ub3QgbW92ZSBpdAooQURSLTAwNSkuAAAAAA1wZWdfcmF0aW9fcDEwAAAAAAAACwAAABFMZWRnZXIgdGltZXN0YW1wLgAAAAAAAAlwb3N0ZWRfYXQAAAAAAAAGAAAAAAAAAAZwb3N0ZXIAAAAAABMAAAAwTmV0IGJ1cm5lZCBtaW51cyBpc3N1ZWQgdGhpcyBlcG9jaCwgYXNzZXQgdW5pdHMuAAAADnJlZGVtcHRpb25fbmV0AAAAAAALAAAAnFRvdGFsIGNpcmN1bGF0aW5nIHN1cHBseSwgYXNzZXQgdW5pdHMuIEtlZXBlciBwb3N0ZWQgZnJvbSBsZWRnZXIgYXNzZXQKc3RhdHM7IFNFUC00MSBoYXMgbm8gYHRvdGFsX3N1cHBseWAsIHNvIGl0IGNhbm5vdCBiZSBjcm9zcyBjaGVja2VkCm9uY2hhaW4gKEFEUi0wMDUpLgAAAAZzdXBwbHkAAAAAAAsAAAASdnMgcHJldmlvdXMgZXBvY2guAAAAAAARc3VwcGx5X2NoYW5nZV9icHMAAAAAAAAF",
        "AAAAAgAAAD9GaW5hbGl0eSBvZiBvbmUgcmluZyBidWZmZXIgc2xvdC4gdGVjaG5pY2FsLWRvYy5tZCBTZWN0aW9uIDUuOC4AAAAAAAAAAAlTbG90U3RhdGUAAAAAAAAEAAAAAAAAAEROZXZlciBwb3N0ZWQsIG9yIG92ZXJ0dXJuZWQgYW5kIG5vdCB5ZXQgcmVwb3N0ZWQuIENvdW50cyBhcyBtaXNzaW5nLgAAAAVFbXB0eQAAAAAAAAAAAABSUG9zdGVkLCBpbnNpZGUgaXRzIGRpc3B1dGUgd2luZG93LiBSZWFkcyBhcyBGaW5hbCBvbmNlCmBwZW5kaW5nX3VudGlsYCBoYXMgcGFzc2VkLgAAAAAAB1BlbmRpbmcAAAAAAAAAAHdQb3N0ZWQgYW5kIGRpc3B1dGVkLiBOb3QgZmluYWwgdW50aWwgdGhlIGRpc3B1dGUgcmVzb2x2ZXM7IGFuCm92ZXJ0dXJuZWQgc2xvdCByZXR1cm5zIHRvIEVtcHR5IGZvciByZXBvc3RpbmcgKEFEUi0wMDUpLgAAAAAIRGlzcHV0ZWQAAAAAAAAAAAAAAAVGaW5hbAAAAA==",
        "AAAAAQAAAFtDb25maWd1cmF0aW9uIGZvciBvbmUgaXNzdWVkIGFzc2V0IGNvdmVyZWQgYnkgdGhlIFJpc2tPcmFjbGUuCnRlY2huaWNhbC1kb2MubWQgU2VjdGlvbiA0LjEuAAAAAAAAAAALQXNzZXRDb25maWcAAAAACQAAAEJPcHRpb25hbCBTb3JvYmFuIEFNTSBwcmljZSBhZGFwdGVycyAoYFByaWNlQWRhcHRlcmAsIFNlY3Rpb24gMy4zKS4AAAAAAAxhbW1fYWRhcHRlcnMAAAPqAAAAEwAAADNTdGVsbGFyIEFzc2V0IENvbnRyYWN0IGFkZHJlc3Mgb2YgdGhlIGlzc3VlZCBhc3NldC4AAAAABWFzc2V0AAAAAAAAEwAAAAAAAAAHZW5hYmxlZAAAAAABAAAAXUZYIGFkYXB0ZXIgKGBGeEFkYXB0ZXJgLCBTZWN0aW9uIDMuMykuIFJlcXVpcmVkIHdoZW4gYHJlZmVyZW5jZWAgaXMKYEZpYXRgLCBgTm9uZWAgb3RoZXJ3aXNlLgAAAAAAAApmeF9hZGFwdGVyAAAAAAPoAAAAEwAAABtGb3IgU0VQLTEgLyBTRVAtMjQgcHJvYmluZy4AAAAAC2hvbWVfZG9tYWluAAAAABAAAAAeQ2xhc3NpYyBpc3N1ZXIgYWNjb3VudCAoRy4uLikuAAAAAAAGaXNzdWVyAAAAAAATAAAAcklzc3VlciBhY2NvdW50IGZsYWdzLiBJc3N1ZXJGcmVlemUgZGVmaW5pdGlvbnMgY2FuIG9ubHkgYmUgcmVnaXN0ZXJlZAp3aGVuIHRoZXNlIG1ha2UgYSBmcmVlemUgcG9zc2libGUgKEFEUi0wMDYpLgAAAAAADGlzc3Vlcl9mbGFncwAAB9AAAAALSXNzdWVyRmxhZ3MAAAAAuUluIFVTREMgdW5pdHMuIEEgRGVwZWcgd2luZG93IGNvdW50cyBvbmx5IGlmIHRoZSBtZWRpYW4KYGxpcXVpZGl0eV8ycGN0YCBvZiB0aGUgNyBkYXlzIGJlZm9yZSB0aGUgd2luZG93IHN0YXJ0ZWQgaXMgYXQgbGVhc3QKdGhpcyB2YWx1ZS4gTmV2ZXIgY29tcGFyZWQgYWdhaW5zdCBsaXZlIGxpcXVpZGl0eSAoQURSLTAwNSkuAAAAAAAADW1pbl9saXF1aWRpdHkAAAAAAAALAAAAlldoYXQgdGhlIGFzc2V0IHNob3VsZCBiZSB3b3J0aC4gRml4ZWQgYXQgYGFkZF9hc3NldGA6IGB1cGRhdGVfYXNzZXRgCnJlamVjdHMgYW55IGNoYW5nZSwgc28gZXZlcnkgZXZlbnQgZGVmaW5pdGlvbiB0aGF0IHBpbnMgaXQgc3RheXMKdmFsaWQgKEFEUi0wMDYpLgAAAAAACXJlZmVyZW5jZQAAAAAAB9AAAAAJUmVmZXJlbmNlAAAA",
        "AAAAAQAAAK5UaGUgY2xhc3NpYyBpc3N1ZXIgZmxhZ3MgdGhhdCBtYWtlIGFuIGlzc3VlciBmcmVlemUgcG9zc2libGUuIEFuCklzc3VlckZyZWV6ZSBkZWZpbml0aW9uIGNhbiBiZSByZWdpc3RlcmVkIG9ubHkgaWYgYXQgbGVhc3Qgb25lIGlzIHNldC4KdGVjaG5pY2FsLWRvYy5tZCBTZWN0aW9uIDQuMSwgQURSLTAwNi4AAAAAAAAAAAALSXNzdWVyRmxhZ3MAAAAAAgAAAD9BVVRIX1JFVk9DQUJMRTogdGhlIGlzc3VlciBjYW4gcmV2b2tlIGEgaG9sZGVyJ3MgYXV0aG9yaXphdGlvbi4AAAAADmF1dGhfcmV2b2NhYmxlAAAAAAABAAAANENMQVdCQUNLX0VOQUJMRUQ6IHRoZSBpc3N1ZXIgY2FuIGNsYXcgYmFjayBiYWxhbmNlcy4AAAAQY2xhd2JhY2tfZW5hYmxlZAAAAAE=",
        "AAAAAgAAALRXaGljaCBGWCByYXRlIGEgYFJlZmVyZW5jZTo6RmlhdGAgaXMgcHJpY2VkIGFnYWluc3QuIE1hdHRlcnMgd2hlcmV2ZXIgYW4Kb2ZmaWNpYWwgcmF0ZSBhbmQgYSBtYXJrZXQgKHBhcmFsbGVsKSByYXRlIGRpdmVyZ2UsIGZvciBleGFtcGxlIEFSUy4KdGVjaG5pY2FsLWRvYy5tZCBTZWN0aW9uIDQuMSwgQURSLTAwNi4AAAAAAAAADEZ4UmF0ZVNvdXJjZQAAAAIAAAAAAAAAOlRoZSByYXRlIHB1Ymxpc2hlZCBieSB0aGUgY2VudHJhbCBiYW5rIG9yIG9mZmljaWFsIGZpeGluZy4AAAAAAAhPZmZpY2lhbAAAAAAAAAAvVGhlIHJhdGUgYXQgd2hpY2ggdGhlIGN1cnJlbmN5IGFjdHVhbGx5IHRyYWRlcy4AAAAABk1hcmtldAAA",
        "AAAAAQAAAAAAAAAAAAAADUlzc3VlckFjdGlvbnMAAAAAAAAEAAAAAAAAABBhdXRoX3Jldm9jYXRpb25zAAAABAAAAAAAAAAPY2xhd2JhY2tfYW1vdW50AAAAAAsAAAAAAAAACWNsYXdiYWNrcwAAAAAAAAQAAAAAAAAADGZsYWdfY2hhbmdlcwAAAAQ=",
        "AAAAAgAAAAAAAAAAAAAADkVuZHBvaW50U3RhdHVzAAAAAAAEAAAAAAAAAAAAAAAHVW5rbm93bgAAAAAAAAAAAAAAAAJVcAAAAAAAAAAAAAAAAAAIRGVncmFkZWQAAAAAAAAAAAAAAAREb3du" ]),
      options
    )
  }
  public readonly fromJSON = {
    band: this.txFromJSON<Result<Band>>,
        ring: this.txFromJSON<Array<RingSlot>>,
        score: this.txFromJSON<Result<RiskScore>>,
        assets: this.txFromJSON<Array<string>>,
        latest: this.txFromJSON<Option<SignalSet>>,
        signals: this.txFromJSON<Option<SignalSet>>,
        is_final: this.txFromJSON<boolean>,
        is_stale: this.txFromJSON<boolean>,
        add_asset: this.txFromJSON<Result<void>>,
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
        dispute_signals: this.txFromJSON<Result<void>>,
        clear_event_band: this.txFromJSON<Result<void>>,
        effective_window: this.txFromJSON<Array<Option<SlotState>>>,
        median_liquidity: this.txFromJSON<i128>,
        event_in_progress: this.txFromJSON<boolean>,
        finalize_endpoint: this.txFromJSON<Result<void>>,
        overturned_signals: this.txFromJSON<Option<SignalSet>>,
        set_event_in_progress: this.txFromJSON<Result<void>>,
        resolve_signal_dispute: this.txFromJSON<Result<void>>,
        resolve_signal_dispute_timeout: this.txFromJSON<Result<void>>
  }
}
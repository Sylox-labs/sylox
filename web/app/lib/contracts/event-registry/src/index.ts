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
    contractId: "CA7CQNGU6X7DAJUN747KZHA3YDNO4GBLWVDU45BUBVKLEV7H3CVIP6EF",
  }
} as const

export const Errors = {
  1: {message:"AlreadyInitialized"},
  2: {message:"NotInitialized"},
  /**
   * Never actually returned: every authorization check goes through
   * Soroban's native `Address::require_auth()`, which traps the
   * host call directly rather than returning a `Result` this
   * contract could wrap. Kept for cross-contract error code
   * compatibility, the same reasoning `RiskOracle`/`Staking`/
   * `Treasury` document for their own copies of this code.
   */
  3: {message:"Unauthorized"},
  /**
   * Not currently reachable: this contract has no pause
   * integration in this build (Section 16.2 lists no
   * EventRegistry-specific pause scope). Kept for code number
   * compatibility.
   */
  4: {message:"Paused"},
  /**
   * Checked arithmetic failed: the IssuerFreeze check's own running
   * clawback-amount and revocation-count sums over its 7 day
   * window, and the clawback ratio's own scale-up before dividing
   * by supply. Bounded by realistic USDC amounts in practice
   * (each term already passed `RiskOracle.post_signals`'s own
   * sanity bounds), but checked rather than assumed, matching
   * `Staking`'s/`Treasury`'s own convention.
   */
  5: {message:"MathOverflow"},
  /**
   * No `EventDefinition` stored under the requested (asset, kind,
   * version).
   */
  200: {message:"UnknownDefinition"},
  /**
   * `propose_tier1` while a non-terminal event already exists for
   * this (asset, kind, version) (invariant E3).
   */
  201: {message:"EventInProgress"},
  /**
   * A Tier 1 proposal's ring-buffer check did not meet the
   * definition: too many missing epochs, a present epoch past
   * threshold, or a liquidity baseline below `min_liquidity`
   * (design note Section 3).
   */
  202: {message:"Tier1CheckFailed"},
  /**
   * `challenge`'s bond lock in `Staking` failed. Not reachable as
   * built: `challenge` calls `Staking.lock_bond` directly (not a
   * `try_*` variant), so a real failure on `Staking`'s own side
   * (for example, the challenger's USDC balance too low for the
   * transfer) traps the call rather than returning a `Result` this
   * contract could translate into its own error code, the same
   * reasoning every other cross-contract call in this workspace
   * follows. Kept for code number compatibility.
   */
  203: {message:"InsufficientBond"},
  /**
   * `finalize` called before `challenge_secs` has elapsed since
   * `proposed_at`.
   */
  204: {message:"ChallengeWindowOpen"},
  /**
   * `challenge` called after `challenge_secs` has elapsed, or
   * against an event no longer `Proposed`.
   */
  205: {message:"ChallengeWindowClosed"},
  /**
   * A function's own required state (`Proposed`, `Escalated`, ...)
   * does not match the event's current one.
   */
  206: {message:"WrongState"},
  /**
   * Unreachable as built (design note review item D4): a fixed
   * post-resolution cooldown was in the original spec design but is
   * replaced here by a new-data test (`window_start > left_at`),
   * which `propose_tier1` enforces itself rather than returning a
   * distinct "still cooling down" code. Kept for code number
   * compatibility.
   */
  207: {message:"CooldownActive"},
  /**
   * `register_definition`'s own validation failed: asset unknown,
   * `reference` mismatch, a parameter unused by `kind` is non
   * zero, or the window plus baseline does not fit the ring buffer.
   */
  208: {message:"InvalidDefinition"},
  /**
   * An IssuerFreeze definition for an asset whose `issuer_flags`
   * allow neither revocation nor clawback.
   */
  209: {message:"FreezeImpossible"},
  /**
   * A live series still pins the version `register_definition`
   * would supersede. Unreachable in this build (no `MarketFactory`
   * to report a live series at all, so this check never finds one
   * to object to); kept for code number compatibility and for the
   * day `MarketFactory` exists.
   */
  210: {message:"DefinitionInUse"},
  /**
   * `rule` called after the ruling deadline; use `resolve_timeout`.
   */
  211: {message:"RulingDeadlinePassed"},
  /**
   * `resolve_timeout` called before the ruling deadline.
   */
  212: {message:"RulingDeadlineNotReached"},
  /**
   * New (feat/event-registry, design note review item D2/R2/R3):
   * `finalize` on a Depeg proposal whose cure window still has an
   * epoch that is neither effectively Final nor permanently
   * missing (still `Pending` before its own `pending_until`, or
   * `Disputed` and unresolved, or `Empty` but still inside its own
   * backfill window). Not a failure: callable again once the data
   * settles one way or the other.
   */
  213: {message:"DataNotFinal"},
  /**
   * New (feat/event-registry, design note review item D3): `version`
   * is registered but not acceptable: neither the current canonical
   * version for (asset, kind) nor pinned by any live series (the
   * latter check is a stand-in returning `false` until
   * `MarketFactory` exists, Section 2 of the design note).
   */
  214: {message:"VersionNotCovered"},
  /**
   * New (feat/event-registry): `challenge`, `finalize`, `rule` or
   * `resolve_timeout` against an `event_id` with no stored
   * `EventRecord`. Kept distinct from `UnknownDefinition` (no
   * canonical definition, or no such version), since these are
   * different questions: one is about a DEFINITION, the other
   * about a specific PROPOSAL.
   */
  215: {message:"UnknownEvent"}
}










/**
 * PR #15 review, finding F2. Bit `i` of `recorded` is set once the
 * cure-window epoch `first_cure_epoch + i` has been observed Final or
 * PermanentlyMissing at least once; `any_below_threshold`/
 * `any_missing` are the OR of every such observation so far. A `u128`
 * bitmap comfortably covers the up-to-72 cure epochs `challenge_secs`
 * can specify (finding F3's own bound), with headroom to spare.
 * Deliberately never clears a bit once set: a disposition, once
 * observed Final or PermanentlyMissing, cannot change (an epoch that
 * is genuinely Final never reverts to Pending or Disputed, and
 * PermanentlyMissing is a statement about elapsed time, which never
 * un-elapses), so recording is monotonic and `checkpoint_cure` is
 * naturally idempotent.
 */
export interface CureProgress {
  any_below_threshold: boolean;
  any_missing: boolean;
  recorded: u128;
}

export type Reference = {tag: "Usd", values: void} | {tag: "Fiat", values: readonly [string, FxRateSource]} | {tag: "Asset", values: readonly [string]};

/**
 * Which FX rate a `Reference::Fiat` is priced against. Matters wherever an
 * official rate and a market (parallel) rate diverge, for example ARS.
 * technical-doc.md Section 4.1, ADR-006.
 */
export type FxRateSource = {tag: "Official", values: void} | {tag: "Market", values: void};

/**
 * Result of `EventRegistry::cover_gate(asset)`: whether new cover may be
 * bought on an asset right now (ADR-003). technical-doc.md Section 9.4.
 */
export type CoverGate = {tag: "Clear", values: void} | {tag: "EventInProgress", values: void} | {tag: "RecentDepeg", values: void} | {tag: "RecentEndpointOutage", values: void} | {tag: "RecentIssuerAction", values: void} | {tag: "UnbuiltBacklog", values: void};

export type EventKind = {tag: "Depeg", values: void} | {tag: "IssuerFreeze", values: void} | {tag: "MintWithoutBacking", values: void} | {tag: "WithdrawalHalt", values: void} | {tag: "Insolvency", values: void};

export type EventState = {tag: "None", values: void} | {tag: "Proposed", values: void} | {tag: "Challenged", values: void} | {tag: "Escalated", values: void} | {tag: "Declared", values: void} | {tag: "Rejected", values: void} | {tag: "Cured", values: void};


/**
 * One proposed credit event, keyed by `(asset, kind, def_version)`
 * (ADR-001). technical-doc.md Section 4.3.
 */
export interface EventRecord {
  asset: string;
  /**
 * Proposer bond, held by Staking (ADR-004). Zero for Tier 1 and Tier 3.
 */
bond: i128;
  declared_at: Option<u64>;
  /**
 * The canonical definition version the proposal was checked against.
 */
def_version: u32;
  /**
 * Set when a challenge escalates the event to the committee. The ruling
 * deadline is `escalated_at + ruling_deadline_secs` (ADR-002).
 */
escalated_at: Option<u64>;
  evidence_hash: Buffer;
  id: u64;
  kind: EventKind;
  proposed_at: u64;
  proposer: string;
  state: EventState;
  /**
 * 1, 2 or 3.
 */
tier: u32;
  /**
 * Start of the failure window. Decides which series the event covers
 * (ADR-003, Section 8.6).
 */
window_start: u64;
}


/**
 * The canonical, versioned rules for one event kind on one asset.
 * Stored by `(asset, kind, version)`; exactly one version per
 * `(asset, kind)` is canonical at a time (ADR-001).
 * technical-doc.md Section 4.3.
 * 
 * Parameters that do not apply to `kind` must be zero; `register_definition`
 * rejects a definition that sets them.
 */
export interface EventDefinition {
  asset: string;
  /**
 * IssuerFreeze: new (feat/event-registry). Section 8.2's own text
 * ("`auth_revocations` above the threshold") names this check but
 * the spec, before this field, defined no threshold for it;
 * `freeze_pct_bps` is a basis-points ratio against `supply`,
 * which has no sensible meaning against a raw revocation count.
 * The count of authorization revocations in the 7 day window must
 * exceed this value for the revocation branch of the IssuerFreeze
 * check to pass.
 */
auth_revocation_threshold: u32;
  /**
 * All kinds: e.g. 86_400.
 */
challenge_secs: u64;
  /**
 * Depeg: e.g. 9_800_000, only during challenge.
 */
cure_threshold: i128;
  /**
 * Depeg: e.g. 9_500_000 = 0.95.
 */
depeg_threshold: i128;
  /**
 * Depeg: e.g. 259_200 = 72h.
 */
depeg_window_secs: u64;
  /**
 * IssuerFreeze: X in the PRD. Compared against `clawback_amount /
 * supply` over the 7 day window (Section 8.2).
 */
freeze_pct_bps: u32;
  /**
 * WithdrawalHalt: e.g. 259_200 = 72h.
 */
halt_window_secs: u64;
  kind: EventKind;
  /**
 * Depeg: epochs in the window with no Final posting that are ignored,
 * e.g. 6 of 72. More than this and the check fails (ADR-005).
 */
max_missing_epochs: u32;
  /**
 * MintWithoutBacking: Y in the PRD.
 */
mint_spike_bps: u32;
  /**
 * Copy of `AssetConfig.reference` at registration, including the FX
 * rate source, so the definition fixes what "the peg" means (ADR-006).
 */
reference: Reference;
  /**
 * All kinds: committee ruling deadline counted from escalation,
 * e.g. 1_209_600 = 14 days (ADR-002).
 */
ruling_deadline_secs: u64;
  /**
 * def_version. Assigned by `register_definition` as the previous
 * canonical version plus one, starting at 1.
 */
version: u32;
}

/**
 * Returned by `EventRegistry::event_status(asset, kind)`, which is per
 * `(asset, kind)` for the canonical version (ADR-001).
 * technical-doc.md Section 12.2.
 */
export type AssetEventStatus = {tag: "None", values: void} | {tag: "InProgress", values: readonly [u64]} | {tag: "Declared", values: readonly [u64, u32, u64, u64]};

export interface Client {
  /**
   * Construct and simulate a rule transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  rule: ({event_id, declare, reason}: {event_id: u64, declare: boolean, reason: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a event transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  event: ({event_id}: {event_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Option<EventRecord>>>

  /**
   * Construct and simulate a covers transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * technical-doc.md Section 8.6.
   */
  covers: ({event_id, def_version, start, expiry}: {event_id: u64, def_version: u32, start: u64, expiry: u64}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a finalize transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * technical-doc.md Section 8.1, as corrected by design review
   * items D1 (cure window), D2/R2/R3 (three-way epoch state) and R1
   * (cure strictness). See `docs/design/event-registry.md` Section 5.
   */
  finalize: ({event_id}: {event_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a challenge transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  challenge: ({challenger, event_id, evidence}: {challenger: string, event_id: u64, evidence: Buffer}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a cover_gate transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * technical-doc.md Section 9.4 step 2, ADR-003. First-match order.
   * Thresholds and windows come from the asset's own canonical
   * Depeg definition where one is registered; the Section 23
   * default applies otherwise (matching Section 9.4's own stated
   * fallback rule verbatim). WithdrawalHalt is out of scope for
   * this build (no canonical definition of that kind can exist
   * yet), so its own window always uses the Section 23 default.
   */
  cover_gate: ({asset}: {asset: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<CoverGate>>>

  /**
   * Construct and simulate a definition transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  definition: ({asset, kind, version}: {asset: string, kind: EventKind, version: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Option<EventDefinition>>>

  /**
   * Construct and simulate a initialize transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  initialize: ({governor, oracle, staking, factory, usdc}: {governor: string, oracle: string, staking: string, factory: string, usdc: string}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a in_progress transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  in_progress: ({asset}: {asset: string}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a event_status transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  event_status: ({asset, kind}: {asset: string, kind: EventKind}, options?: MethodOptions) => Promise<AssembledTransaction<AssetEventStatus>>

  /**
   * Construct and simulate a has_declared transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  has_declared: ({asset}: {asset: string}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a propose_tier1 transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * technical-doc.md Section 8.2, as amended by this build's lead
   * decision (design note Section 2) and design review item D3.
   */
  propose_tier1: ({caller, asset, kind, version}: {caller: string, asset: string, kind: EventKind, version: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>

  /**
   * Construct and simulate a checkpoint_cure transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * PR #15 review, finding F2. Permissionless (no `require_auth`):
   * anyone, including the keeper service, may call this to record
   * a Depeg event's cure-window progress before an epoch that is
   * already decidable rotates out of `RiskOracle`'s own ring.
   * Unlike `finalize`, this never errors on "not ready" — recording
   * whatever is currently decidable, and keeping that record, is
   * itself the successful outcome; there being more to record later
   * is not a failure. Calling it twice in a row is a no-op the
   * second time (`record_cure_progress`'s own recorded-bit check).
   */
  checkpoint_cure: ({event_id}: {event_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<CureProgress>>>

  /**
   * Construct and simulate a current_version transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  current_version: ({asset, kind}: {asset: string, kind: EventKind}, options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a resolve_timeout transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  resolve_timeout: ({event_id}: {event_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a ruling_deadline transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  ruling_deadline: ({event_id}: {event_id: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Option<u64>>>

  /**
   * Construct and simulate a committee_misses transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  committee_misses: ({committee}: {committee: string}, options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a active_event_count transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  active_event_count: ({asset}: {asset: string}, options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a register_definition transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * technical-doc.md Section 8.8. `def.version` is ignored on input
   * (the caller cannot pick a version number); the stored version is
   * always the previous canonical version plus one, starting at 1.
   */
  register_definition: ({def}: {def: EventDefinition}, options?: MethodOptions) => Promise<AssembledTransaction<Result<u32>>>

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
      new ContractSpec([ "AAAAAAAAAAAAAAAEcnVsZQAAAAMAAAAAAAAACGV2ZW50X2lkAAAABgAAAAAAAAAHZGVjbGFyZQAAAAABAAAAAAAAAAZyZWFzb24AAAAAA+4AAAAgAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAAFZXZlbnQAAAAAAAABAAAAAAAAAAhldmVudF9pZAAAAAYAAAABAAAD6AAAB9AAAAALRXZlbnRSZWNvcmQA",
        "AAAAAAAAAB10ZWNobmljYWwtZG9jLm1kIFNlY3Rpb24gOC42LgAAAAAAAAZjb3ZlcnMAAAAAAAQAAAAAAAAACGV2ZW50X2lkAAAABgAAAAAAAAALZGVmX3ZlcnNpb24AAAAABAAAAAAAAAAFc3RhcnQAAAAAAAAGAAAAAAAAAAZleHBpcnkAAAAAAAYAAAABAAAAAQ==",
        "AAAAAAAAAL10ZWNobmljYWwtZG9jLm1kIFNlY3Rpb24gOC4xLCBhcyBjb3JyZWN0ZWQgYnkgZGVzaWduIHJldmlldwppdGVtcyBEMSAoY3VyZSB3aW5kb3cpLCBEMi9SMi9SMyAodGhyZWUtd2F5IGVwb2NoIHN0YXRlKSBhbmQgUjEKKGN1cmUgc3RyaWN0bmVzcykuIFNlZSBgZG9jcy9kZXNpZ24vZXZlbnQtcmVnaXN0cnkubWRgIFNlY3Rpb24gNS4AAAAAAAAIZmluYWxpemUAAAABAAAAAAAAAAhldmVudF9pZAAAAAYAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAAAAAAAJY2hhbGxlbmdlAAAAAAAAAwAAAAAAAAAKY2hhbGxlbmdlcgAAAAAAEwAAAAAAAAAIZXZlbnRfaWQAAAAGAAAAAAAAAAhldmlkZW5jZQAAA+4AAAAgAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAaR0ZWNobmljYWwtZG9jLm1kIFNlY3Rpb24gOS40IHN0ZXAgMiwgQURSLTAwMy4gRmlyc3QtbWF0Y2ggb3JkZXIuClRocmVzaG9sZHMgYW5kIHdpbmRvd3MgY29tZSBmcm9tIHRoZSBhc3NldCdzIG93biBjYW5vbmljYWwKRGVwZWcgZGVmaW5pdGlvbiB3aGVyZSBvbmUgaXMgcmVnaXN0ZXJlZDsgdGhlIFNlY3Rpb24gMjMKZGVmYXVsdCBhcHBsaWVzIG90aGVyd2lzZSAobWF0Y2hpbmcgU2VjdGlvbiA5LjQncyBvd24gc3RhdGVkCmZhbGxiYWNrIHJ1bGUgdmVyYmF0aW0pLiBXaXRoZHJhd2FsSGFsdCBpcyBvdXQgb2Ygc2NvcGUgZm9yCnRoaXMgYnVpbGQgKG5vIGNhbm9uaWNhbCBkZWZpbml0aW9uIG9mIHRoYXQga2luZCBjYW4gZXhpc3QKeWV0KSwgc28gaXRzIG93biB3aW5kb3cgYWx3YXlzIHVzZXMgdGhlIFNlY3Rpb24gMjMgZGVmYXVsdC4AAAAKY292ZXJfZ2F0ZQAAAAAAAQAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAQAAA+kAAAfQAAAACUNvdmVyR2F0ZQAAAAAAAAM=",
        "AAAAAAAAAAAAAAAKZGVmaW5pdGlvbgAAAAAAAwAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAAAAAARraW5kAAAH0AAAAAlFdmVudEtpbmQAAAAAAAAAAAAAB3ZlcnNpb24AAAAABAAAAAEAAAPoAAAH0AAAAA9FdmVudERlZmluaXRpb24A",
        "AAAAAAAAAAAAAAAKaW5pdGlhbGl6ZQAAAAAABQAAAAAAAAAIZ292ZXJub3IAAAATAAAAAAAAAAZvcmFjbGUAAAAAABMAAAAAAAAAB3N0YWtpbmcAAAAAEwAAAAAAAAAHZmFjdG9yeQAAAAATAAAAAAAAAAR1c2RjAAAAEwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAAAAAAALaW5fcHJvZ3Jlc3MAAAAAAQAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAQAAAAE=",
        "AAAAAAAAAAAAAAAMZXZlbnRfc3RhdHVzAAAAAgAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAAAAAARraW5kAAAH0AAAAAlFdmVudEtpbmQAAAAAAAABAAAH0AAAABBBc3NldEV2ZW50U3RhdHVz",
        "AAAAAAAAAAAAAAAMaGFzX2RlY2xhcmVkAAAAAQAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAQAAAAE=",
        "AAAAAAAAAHl0ZWNobmljYWwtZG9jLm1kIFNlY3Rpb24gOC4yLCBhcyBhbWVuZGVkIGJ5IHRoaXMgYnVpbGQncyBsZWFkCmRlY2lzaW9uIChkZXNpZ24gbm90ZSBTZWN0aW9uIDIpIGFuZCBkZXNpZ24gcmV2aWV3IGl0ZW0gRDMuAAAAAAAADXByb3Bvc2VfdGllcjEAAAAAAAAEAAAAAAAAAAZjYWxsZXIAAAAAABMAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAAAAAAEa2luZAAAB9AAAAAJRXZlbnRLaW5kAAAAAAAAAAAAAAd2ZXJzaW9uAAAAAAQAAAABAAAD6QAAAAYAAAAD",
        "AAAAAAAAAixQUiAjMTUgcmV2aWV3LCBmaW5kaW5nIEYyLiBQZXJtaXNzaW9ubGVzcyAobm8gYHJlcXVpcmVfYXV0aGApOgphbnlvbmUsIGluY2x1ZGluZyB0aGUga2VlcGVyIHNlcnZpY2UsIG1heSBjYWxsIHRoaXMgdG8gcmVjb3JkCmEgRGVwZWcgZXZlbnQncyBjdXJlLXdpbmRvdyBwcm9ncmVzcyBiZWZvcmUgYW4gZXBvY2ggdGhhdCBpcwphbHJlYWR5IGRlY2lkYWJsZSByb3RhdGVzIG91dCBvZiBgUmlza09yYWNsZWAncyBvd24gcmluZy4KVW5saWtlIGBmaW5hbGl6ZWAsIHRoaXMgbmV2ZXIgZXJyb3JzIG9uICJub3QgcmVhZHkiIOKAlCByZWNvcmRpbmcKd2hhdGV2ZXIgaXMgY3VycmVudGx5IGRlY2lkYWJsZSwgYW5kIGtlZXBpbmcgdGhhdCByZWNvcmQsIGlzCml0c2VsZiB0aGUgc3VjY2Vzc2Z1bCBvdXRjb21lOyB0aGVyZSBiZWluZyBtb3JlIHRvIHJlY29yZCBsYXRlcgppcyBub3QgYSBmYWlsdXJlLiBDYWxsaW5nIGl0IHR3aWNlIGluIGEgcm93IGlzIGEgbm8tb3AgdGhlCnNlY29uZCB0aW1lIChgcmVjb3JkX2N1cmVfcHJvZ3Jlc3NgJ3Mgb3duIHJlY29yZGVkLWJpdCBjaGVjaykuAAAAD2NoZWNrcG9pbnRfY3VyZQAAAAABAAAAAAAAAAhldmVudF9pZAAAAAYAAAABAAAD6QAAB9AAAAAMQ3VyZVByb2dyZXNzAAAAAw==",
        "AAAAAAAAAAAAAAAPY3VycmVudF92ZXJzaW9uAAAAAAIAAAAAAAAABWFzc2V0AAAAAAAAEwAAAAAAAAAEa2luZAAAB9AAAAAJRXZlbnRLaW5kAAAAAAAAAQAAAAQ=",
        "AAAAAAAAAAAAAAAPcmVzb2x2ZV90aW1lb3V0AAAAAAEAAAAAAAAACGV2ZW50X2lkAAAABgAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAAAAAAAPcnVsaW5nX2RlYWRsaW5lAAAAAAEAAAAAAAAACGV2ZW50X2lkAAAABgAAAAEAAAPoAAAABg==",
        "AAAAAAAAAAAAAAAQY29tbWl0dGVlX21pc3NlcwAAAAEAAAAAAAAACWNvbW1pdHRlZQAAAAAAABMAAAABAAAABA==",
        "AAAAAAAAAAAAAAASYWN0aXZlX2V2ZW50X2NvdW50AAAAAAABAAAAAAAAAAVhc3NldAAAAAAAABMAAAABAAAABA==",
        "AAAAAAAAAL90ZWNobmljYWwtZG9jLm1kIFNlY3Rpb24gOC44LiBgZGVmLnZlcnNpb25gIGlzIGlnbm9yZWQgb24gaW5wdXQKKHRoZSBjYWxsZXIgY2Fubm90IHBpY2sgYSB2ZXJzaW9uIG51bWJlcik7IHRoZSBzdG9yZWQgdmVyc2lvbiBpcwphbHdheXMgdGhlIHByZXZpb3VzIGNhbm9uaWNhbCB2ZXJzaW9uIHBsdXMgb25lLCBzdGFydGluZyBhdCAxLgAAAAATcmVnaXN0ZXJfZGVmaW5pdGlvbgAAAAABAAAAAAAAAANkZWYAAAAH0AAAAA9FdmVudERlZmluaXRpb24AAAAAAQAAA+kAAAAEAAAAAw==",
        "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAAFQAAAAAAAAASQWxyZWFkeUluaXRpYWxpemVkAAAAAAABAAAAAAAAAA5Ob3RJbml0aWFsaXplZAAAAAAAAgAAAV1OZXZlciBhY3R1YWxseSByZXR1cm5lZDogZXZlcnkgYXV0aG9yaXphdGlvbiBjaGVjayBnb2VzIHRocm91Z2gKU29yb2JhbidzIG5hdGl2ZSBgQWRkcmVzczo6cmVxdWlyZV9hdXRoKClgLCB3aGljaCB0cmFwcyB0aGUKaG9zdCBjYWxsIGRpcmVjdGx5IHJhdGhlciB0aGFuIHJldHVybmluZyBhIGBSZXN1bHRgIHRoaXMKY29udHJhY3QgY291bGQgd3JhcC4gS2VwdCBmb3IgY3Jvc3MtY29udHJhY3QgZXJyb3IgY29kZQpjb21wYXRpYmlsaXR5LCB0aGUgc2FtZSByZWFzb25pbmcgYFJpc2tPcmFjbGVgL2BTdGFraW5nYC8KYFRyZWFzdXJ5YCBkb2N1bWVudCBmb3IgdGhlaXIgb3duIGNvcGllcyBvZiB0aGlzIGNvZGUuAAAAAAAADFVuYXV0aG9yaXplZAAAAAMAAACtTm90IGN1cnJlbnRseSByZWFjaGFibGU6IHRoaXMgY29udHJhY3QgaGFzIG5vIHBhdXNlCmludGVncmF0aW9uIGluIHRoaXMgYnVpbGQgKFNlY3Rpb24gMTYuMiBsaXN0cyBubwpFdmVudFJlZ2lzdHJ5LXNwZWNpZmljIHBhdXNlIHNjb3BlKS4gS2VwdCBmb3IgY29kZSBudW1iZXIKY29tcGF0aWJpbGl0eS4AAAAAAAAGUGF1c2VkAAAAAAAEAAABjENoZWNrZWQgYXJpdGhtZXRpYyBmYWlsZWQ6IHRoZSBJc3N1ZXJGcmVlemUgY2hlY2sncyBvd24gcnVubmluZwpjbGF3YmFjay1hbW91bnQgYW5kIHJldm9jYXRpb24tY291bnQgc3VtcyBvdmVyIGl0cyA3IGRheQp3aW5kb3csIGFuZCB0aGUgY2xhd2JhY2sgcmF0aW8ncyBvd24gc2NhbGUtdXAgYmVmb3JlIGRpdmlkaW5nCmJ5IHN1cHBseS4gQm91bmRlZCBieSByZWFsaXN0aWMgVVNEQyBhbW91bnRzIGluIHByYWN0aWNlCihlYWNoIHRlcm0gYWxyZWFkeSBwYXNzZWQgYFJpc2tPcmFjbGUucG9zdF9zaWduYWxzYCdzIG93bgpzYW5pdHkgYm91bmRzKSwgYnV0IGNoZWNrZWQgcmF0aGVyIHRoYW4gYXNzdW1lZCwgbWF0Y2hpbmcKYFN0YWtpbmdgJ3MvYFRyZWFzdXJ5YCdzIG93biBjb252ZW50aW9uLgAAAAxNYXRoT3ZlcmZsb3cAAAAFAAAAR05vIGBFdmVudERlZmluaXRpb25gIHN0b3JlZCB1bmRlciB0aGUgcmVxdWVzdGVkIChhc3NldCwga2luZCwKdmVyc2lvbikuAAAAABFVbmtub3duRGVmaW5pdGlvbgAAAAAAAMgAAABpYHByb3Bvc2VfdGllcjFgIHdoaWxlIGEgbm9uLXRlcm1pbmFsIGV2ZW50IGFscmVhZHkgZXhpc3RzIGZvcgp0aGlzIChhc3NldCwga2luZCwgdmVyc2lvbikgKGludmFyaWFudCBFMykuAAAAAAAAD0V2ZW50SW5Qcm9ncmVzcwAAAADJAAAAwkEgVGllciAxIHByb3Bvc2FsJ3MgcmluZy1idWZmZXIgY2hlY2sgZGlkIG5vdCBtZWV0IHRoZQpkZWZpbml0aW9uOiB0b28gbWFueSBtaXNzaW5nIGVwb2NocywgYSBwcmVzZW50IGVwb2NoIHBhc3QKdGhyZXNob2xkLCBvciBhIGxpcXVpZGl0eSBiYXNlbGluZSBiZWxvdyBgbWluX2xpcXVpZGl0eWAKKGRlc2lnbiBub3RlIFNlY3Rpb24gMykuAAAAAAAQVGllcjFDaGVja0ZhaWxlZAAAAMoAAAHVYGNoYWxsZW5nZWAncyBib25kIGxvY2sgaW4gYFN0YWtpbmdgIGZhaWxlZC4gTm90IHJlYWNoYWJsZSBhcwpidWlsdDogYGNoYWxsZW5nZWAgY2FsbHMgYFN0YWtpbmcubG9ja19ib25kYCBkaXJlY3RseSAobm90IGEKYHRyeV8qYCB2YXJpYW50KSwgc28gYSByZWFsIGZhaWx1cmUgb24gYFN0YWtpbmdgJ3Mgb3duIHNpZGUKKGZvciBleGFtcGxlLCB0aGUgY2hhbGxlbmdlcidzIFVTREMgYmFsYW5jZSB0b28gbG93IGZvciB0aGUKdHJhbnNmZXIpIHRyYXBzIHRoZSBjYWxsIHJhdGhlciB0aGFuIHJldHVybmluZyBhIGBSZXN1bHRgIHRoaXMKY29udHJhY3QgY291bGQgdHJhbnNsYXRlIGludG8gaXRzIG93biBlcnJvciBjb2RlLCB0aGUgc2FtZQpyZWFzb25pbmcgZXZlcnkgb3RoZXIgY3Jvc3MtY29udHJhY3QgY2FsbCBpbiB0aGlzIHdvcmtzcGFjZQpmb2xsb3dzLiBLZXB0IGZvciBjb2RlIG51bWJlciBjb21wYXRpYmlsaXR5LgAAAAAAABBJbnN1ZmZpY2llbnRCb25kAAAAywAAAEpgZmluYWxpemVgIGNhbGxlZCBiZWZvcmUgYGNoYWxsZW5nZV9zZWNzYCBoYXMgZWxhcHNlZCBzaW5jZQpgcHJvcG9zZWRfYXRgLgAAAAAAE0NoYWxsZW5nZVdpbmRvd09wZW4AAAAAzAAAAGBgY2hhbGxlbmdlYCBjYWxsZWQgYWZ0ZXIgYGNoYWxsZW5nZV9zZWNzYCBoYXMgZWxhcHNlZCwgb3IKYWdhaW5zdCBhbiBldmVudCBubyBsb25nZXIgYFByb3Bvc2VkYC4AAAAVQ2hhbGxlbmdlV2luZG93Q2xvc2VkAAAAAAAAzQAAAGZBIGZ1bmN0aW9uJ3Mgb3duIHJlcXVpcmVkIHN0YXRlIChgUHJvcG9zZWRgLCBgRXNjYWxhdGVkYCwgLi4uKQpkb2VzIG5vdCBtYXRjaCB0aGUgZXZlbnQncyBjdXJyZW50IG9uZS4AAAAAAApXcm9uZ1N0YXRlAAAAAADOAAABPVVucmVhY2hhYmxlIGFzIGJ1aWx0IChkZXNpZ24gbm90ZSByZXZpZXcgaXRlbSBENCk6IGEgZml4ZWQKcG9zdC1yZXNvbHV0aW9uIGNvb2xkb3duIHdhcyBpbiB0aGUgb3JpZ2luYWwgc3BlYyBkZXNpZ24gYnV0IGlzCnJlcGxhY2VkIGhlcmUgYnkgYSBuZXctZGF0YSB0ZXN0IChgd2luZG93X3N0YXJ0ID4gbGVmdF9hdGApLAp3aGljaCBgcHJvcG9zZV90aWVyMWAgZW5mb3JjZXMgaXRzZWxmIHJhdGhlciB0aGFuIHJldHVybmluZyBhCmRpc3RpbmN0ICJzdGlsbCBjb29saW5nIGRvd24iIGNvZGUuIEtlcHQgZm9yIGNvZGUgbnVtYmVyCmNvbXBhdGliaWxpdHkuAAAAAAAADkNvb2xkb3duQWN0aXZlAAAAAADPAAAAt2ByZWdpc3Rlcl9kZWZpbml0aW9uYCdzIG93biB2YWxpZGF0aW9uIGZhaWxlZDogYXNzZXQgdW5rbm93biwKYHJlZmVyZW5jZWAgbWlzbWF0Y2gsIGEgcGFyYW1ldGVyIHVudXNlZCBieSBga2luZGAgaXMgbm9uCnplcm8sIG9yIHRoZSB3aW5kb3cgcGx1cyBiYXNlbGluZSBkb2VzIG5vdCBmaXQgdGhlIHJpbmcgYnVmZmVyLgAAAAARSW52YWxpZERlZmluaXRpb24AAAAAAADQAAAAY0FuIElzc3VlckZyZWV6ZSBkZWZpbml0aW9uIGZvciBhbiBhc3NldCB3aG9zZSBgaXNzdWVyX2ZsYWdzYAphbGxvdyBuZWl0aGVyIHJldm9jYXRpb24gbm9yIGNsYXdiYWNrLgAAAAAQRnJlZXplSW1wb3NzaWJsZQAAANEAAAERQSBsaXZlIHNlcmllcyBzdGlsbCBwaW5zIHRoZSB2ZXJzaW9uIGByZWdpc3Rlcl9kZWZpbml0aW9uYAp3b3VsZCBzdXBlcnNlZGUuIFVucmVhY2hhYmxlIGluIHRoaXMgYnVpbGQgKG5vIGBNYXJrZXRGYWN0b3J5YAp0byByZXBvcnQgYSBsaXZlIHNlcmllcyBhdCBhbGwsIHNvIHRoaXMgY2hlY2sgbmV2ZXIgZmluZHMgb25lCnRvIG9iamVjdCB0byk7IGtlcHQgZm9yIGNvZGUgbnVtYmVyIGNvbXBhdGliaWxpdHkgYW5kIGZvciB0aGUKZGF5IGBNYXJrZXRGYWN0b3J5YCBleGlzdHMuAAAAAAAAD0RlZmluaXRpb25JblVzZQAAAADSAAAAP2BydWxlYCBjYWxsZWQgYWZ0ZXIgdGhlIHJ1bGluZyBkZWFkbGluZTsgdXNlIGByZXNvbHZlX3RpbWVvdXRgLgAAAAAUUnVsaW5nRGVhZGxpbmVQYXNzZWQAAADTAAAANGByZXNvbHZlX3RpbWVvdXRgIGNhbGxlZCBiZWZvcmUgdGhlIHJ1bGluZyBkZWFkbGluZS4AAAAYUnVsaW5nRGVhZGxpbmVOb3RSZWFjaGVkAAAA1AAAAYlOZXcgKGZlYXQvZXZlbnQtcmVnaXN0cnksIGRlc2lnbiBub3RlIHJldmlldyBpdGVtIEQyL1IyL1IzKToKYGZpbmFsaXplYCBvbiBhIERlcGVnIHByb3Bvc2FsIHdob3NlIGN1cmUgd2luZG93IHN0aWxsIGhhcyBhbgplcG9jaCB0aGF0IGlzIG5laXRoZXIgZWZmZWN0aXZlbHkgRmluYWwgbm9yIHBlcm1hbmVudGx5Cm1pc3NpbmcgKHN0aWxsIGBQZW5kaW5nYCBiZWZvcmUgaXRzIG93biBgcGVuZGluZ191bnRpbGAsIG9yCmBEaXNwdXRlZGAgYW5kIHVucmVzb2x2ZWQsIG9yIGBFbXB0eWAgYnV0IHN0aWxsIGluc2lkZSBpdHMgb3duCmJhY2tmaWxsIHdpbmRvdykuIE5vdCBhIGZhaWx1cmU6IGNhbGxhYmxlIGFnYWluIG9uY2UgdGhlIGRhdGEKc2V0dGxlcyBvbmUgd2F5IG9yIHRoZSBvdGhlci4AAAAAAAAMRGF0YU5vdEZpbmFsAAAA1QAAASdOZXcgKGZlYXQvZXZlbnQtcmVnaXN0cnksIGRlc2lnbiBub3RlIHJldmlldyBpdGVtIEQzKTogYHZlcnNpb25gCmlzIHJlZ2lzdGVyZWQgYnV0IG5vdCBhY2NlcHRhYmxlOiBuZWl0aGVyIHRoZSBjdXJyZW50IGNhbm9uaWNhbAp2ZXJzaW9uIGZvciAoYXNzZXQsIGtpbmQpIG5vciBwaW5uZWQgYnkgYW55IGxpdmUgc2VyaWVzICh0aGUKbGF0dGVyIGNoZWNrIGlzIGEgc3RhbmQtaW4gcmV0dXJuaW5nIGBmYWxzZWAgdW50aWwKYE1hcmtldEZhY3RvcnlgIGV4aXN0cywgU2VjdGlvbiAyIG9mIHRoZSBkZXNpZ24gbm90ZSkuAAAAABFWZXJzaW9uTm90Q292ZXJlZAAAAAAAANYAAAE+TmV3IChmZWF0L2V2ZW50LXJlZ2lzdHJ5KTogYGNoYWxsZW5nZWAsIGBmaW5hbGl6ZWAsIGBydWxlYCBvcgpgcmVzb2x2ZV90aW1lb3V0YCBhZ2FpbnN0IGFuIGBldmVudF9pZGAgd2l0aCBubyBzdG9yZWQKYEV2ZW50UmVjb3JkYC4gS2VwdCBkaXN0aW5jdCBmcm9tIGBVbmtub3duRGVmaW5pdGlvbmAgKG5vCmNhbm9uaWNhbCBkZWZpbml0aW9uLCBvciBubyBzdWNoIHZlcnNpb24pLCBzaW5jZSB0aGVzZSBhcmUKZGlmZmVyZW50IHF1ZXN0aW9uczogb25lIGlzIGFib3V0IGEgREVGSU5JVElPTiwgdGhlIG90aGVyCmFib3V0IGEgc3BlY2lmaWMgUFJPUE9TQUwuAAAAAAAMVW5rbm93bkV2ZW50AAAA1w==",
        "AAAABQAAAAAAAAAAAAAACkV2ZW50Q3VyZWQAAAAAAAIAAAAFc3lsb3gAAAAAAAALZXZlbnRfY3VyZWQAAAAAAgAAAAAAAAAFYXNzZXQAAAAAAAATAAAAAQAAAAAAAAAIZXZlbnRfaWQAAAAGAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAADUV2ZW50RGVjbGFyZWQAAAAAAAACAAAABXN5bG94AAAAAAAADmV2ZW50X2RlY2xhcmVkAAAAAAAGAAAAAAAAAAVhc3NldAAAAAAAABMAAAABAAAAAAAAAAhldmVudF9pZAAAAAYAAAAAAAAAAAAAAARraW5kAAAH0AAAAAlFdmVudEtpbmQAAAAAAAAAAAAAAAAAAAtkZWZfdmVyc2lvbgAAAAAEAAAAAAAAAAAAAAAMd2luZG93X3N0YXJ0AAAABgAAAAAAAAAAAAAAC2RlY2xhcmVkX2F0AAAAAAYAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAADUV2ZW50UHJvcG9zZWQAAAAAAAACAAAABXN5bG94AAAAAAAADmV2ZW50X3Byb3Bvc2VkAAAAAAAIAAAAAAAAAAVhc3NldAAAAAAAABMAAAABAAAAAAAAAAhldmVudF9pZAAAAAYAAAAAAAAAAAAAAARraW5kAAAH0AAAAAlFdmVudEtpbmQAAAAAAAAAAAAAAAAAAAtkZWZfdmVyc2lvbgAAAAAEAAAAAAAAAAAAAAAEdGllcgAAAAQAAAAAAAAAAAAAAAx3aW5kb3dfc3RhcnQAAAAGAAAAAAAAAAAAAAAIcHJvcG9zZXIAAAATAAAAAAAAAAAAAAAIZXZpZGVuY2UAAAPuAAAAIAAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAADUV2ZW50UmVqZWN0ZWQAAAAAAAACAAAABXN5bG94AAAAAAAADmV2ZW50X3JlamVjdGVkAAAAAAADAAAAAAAAAAVhc3NldAAAAAAAABMAAAABAAAAAAAAAAhldmVudF9pZAAAAAYAAAAAAAAAAAAAAAZyZWFzb24AAAAAA+4AAAAgAAAAAAAAAAI=",
        "AAAABQAAAAAAAAAAAAAADkV2ZW50RXNjYWxhdGVkAAAAAAACAAAABXN5bG94AAAAAAAAD2V2ZW50X2VzY2FsYXRlZAAAAAAEAAAAAAAAAAVhc3NldAAAAAAAABMAAAABAAAAAAAAAAhldmVudF9pZAAAAAYAAAAAAAAAAAAAAAxlc2NhbGF0ZWRfYXQAAAAGAAAAAAAAAAAAAAAPcnVsaW5nX2RlYWRsaW5lAAAAAAYAAAAAAAAAAg==",
        "AAAABQAAAAAAAAAAAAAADlJ1bGluZ1RpbWVkT3V0AAAAAAACAAAABXN5bG94AAAAAAAAEHJ1bGluZ190aW1lZF9vdXQAAAAFAAAAAAAAAAVhc3NldAAAAAAAABMAAAABAAAAAAAAAAhldmVudF9pZAAAAAYAAAAAAAAAQGB0cnVlYCBpZiB0aGUgZGVmYXVsdCBvdXRjb21lIHdhcyBEZWNsYXJlZCwgYGZhbHNlYCBpZiBSZWplY3RlZC4AAAAQb3V0Y29tZV9kZWNsYXJlZAAAAAEAAAAAAAAAAAAAAAljb21taXR0ZWUAAAAAAAATAAAAAAAAAAAAAAAMbWlzc2VzX2FmdGVyAAAABAAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAD0V2ZW50Q2hhbGxlbmdlZAAAAAACAAAABXN5bG94AAAAAAAAEGV2ZW50X2NoYWxsZW5nZWQAAAAEAAAAAAAAAAVhc3NldAAAAAAAABMAAAABAAAAAAAAAAhldmVudF9pZAAAAAYAAAAAAAAAAAAAAApjaGFsbGVuZ2VyAAAAAAATAAAAAAAAAAAAAAAIZXZpZGVuY2UAAAPuAAAAIAAAAAAAAAAC",
        "AAAABQAAAAAAAAAAAAAAFERlZmluaXRpb25SZWdpc3RlcmVkAAAAAgAAAAVzeWxveAAAAAAAABVkZWZpbml0aW9uX3JlZ2lzdGVyZWQAAAAAAAAEAAAAAAAAAAVhc3NldAAAAAAAABMAAAABAAAAAAAAAARraW5kAAAH0AAAAAlFdmVudEtpbmQAAAAAAAAAAAAAAAAAAAd2ZXJzaW9uAAAAAAQAAAAAAAAAAAAAABBwcmV2aW91c192ZXJzaW9uAAAABAAAAAAAAAAC",
        "AAAAAQAAAtlQUiAjMTUgcmV2aWV3LCBmaW5kaW5nIEYyLiBCaXQgYGlgIG9mIGByZWNvcmRlZGAgaXMgc2V0IG9uY2UgdGhlCmN1cmUtd2luZG93IGVwb2NoIGBmaXJzdF9jdXJlX2Vwb2NoICsgaWAgaGFzIGJlZW4gb2JzZXJ2ZWQgRmluYWwgb3IKUGVybWFuZW50bHlNaXNzaW5nIGF0IGxlYXN0IG9uY2U7IGBhbnlfYmVsb3dfdGhyZXNob2xkYC8KYGFueV9taXNzaW5nYCBhcmUgdGhlIE9SIG9mIGV2ZXJ5IHN1Y2ggb2JzZXJ2YXRpb24gc28gZmFyLiBBIGB1MTI4YApiaXRtYXAgY29tZm9ydGFibHkgY292ZXJzIHRoZSB1cC10by03MiBjdXJlIGVwb2NocyBgY2hhbGxlbmdlX3NlY3NgCmNhbiBzcGVjaWZ5IChmaW5kaW5nIEYzJ3Mgb3duIGJvdW5kKSwgd2l0aCBoZWFkcm9vbSB0byBzcGFyZS4KRGVsaWJlcmF0ZWx5IG5ldmVyIGNsZWFycyBhIGJpdCBvbmNlIHNldDogYSBkaXNwb3NpdGlvbiwgb25jZQpvYnNlcnZlZCBGaW5hbCBvciBQZXJtYW5lbnRseU1pc3NpbmcsIGNhbm5vdCBjaGFuZ2UgKGFuIGVwb2NoIHRoYXQKaXMgZ2VudWluZWx5IEZpbmFsIG5ldmVyIHJldmVydHMgdG8gUGVuZGluZyBvciBEaXNwdXRlZCwgYW5kClBlcm1hbmVudGx5TWlzc2luZyBpcyBhIHN0YXRlbWVudCBhYm91dCBlbGFwc2VkIHRpbWUsIHdoaWNoIG5ldmVyCnVuLWVsYXBzZXMpLCBzbyByZWNvcmRpbmcgaXMgbW9ub3RvbmljIGFuZCBgY2hlY2twb2ludF9jdXJlYCBpcwpuYXR1cmFsbHkgaWRlbXBvdGVudC4AAAAAAAAAAAAADEN1cmVQcm9ncmVzcwAAAAMAAAAAAAAAE2FueV9iZWxvd190aHJlc2hvbGQAAAAAAQAAAAAAAAALYW55X21pc3NpbmcAAAAAAQAAAAAAAAAIcmVjb3JkZWQAAAAK",
        "AAAAAgAAAAAAAAAAAAAACVJlZmVyZW5jZQAAAAAAAAMAAAAAAAAADzEgdW5pdCA9IDEgVVNELgAAAAADVXNkAAAAAAEAAABXSVNPIDQyMTcgY29kZSBhbmQgdGhlIEZYIHJhdGUgYmFzaXMgaXQgaXMgcHJpY2VkIGFnYWluc3QsIHZpYSB0aGUKRlggYWRhcHRlciAoQURSLTAwNikuAAAAAARGaWF0AAAAAgAAABEAAAfQAAAADEZ4UmF0ZVNvdXJjZQAAAAEAAAAgUGVnZ2VkIHRvIGFub3RoZXIgb25jaGFpbiBhc3NldC4AAAAFQXNzZXQAAAAAAAABAAAAEw==",
        "AAAAAgAAALRXaGljaCBGWCByYXRlIGEgYFJlZmVyZW5jZTo6RmlhdGAgaXMgcHJpY2VkIGFnYWluc3QuIE1hdHRlcnMgd2hlcmV2ZXIgYW4Kb2ZmaWNpYWwgcmF0ZSBhbmQgYSBtYXJrZXQgKHBhcmFsbGVsKSByYXRlIGRpdmVyZ2UsIGZvciBleGFtcGxlIEFSUy4KdGVjaG5pY2FsLWRvYy5tZCBTZWN0aW9uIDQuMSwgQURSLTAwNi4AAAAAAAAADEZ4UmF0ZVNvdXJjZQAAAAIAAAAAAAAAOlRoZSByYXRlIHB1Ymxpc2hlZCBieSB0aGUgY2VudHJhbCBiYW5rIG9yIG9mZmljaWFsIGZpeGluZy4AAAAAAAhPZmZpY2lhbAAAAAAAAAAvVGhlIHJhdGUgYXQgd2hpY2ggdGhlIGN1cnJlbmN5IGFjdHVhbGx5IHRyYWRlcy4AAAAABk1hcmtldAAA",
        "AAAAAgAAAIxSZXN1bHQgb2YgYEV2ZW50UmVnaXN0cnk6OmNvdmVyX2dhdGUoYXNzZXQpYDogd2hldGhlciBuZXcgY292ZXIgbWF5IGJlCmJvdWdodCBvbiBhbiBhc3NldCByaWdodCBub3cgKEFEUi0wMDMpLiB0ZWNobmljYWwtZG9jLm1kIFNlY3Rpb24gOS40LgAAAAAAAAAJQ292ZXJHYXRlAAAAAAAABgAAAAAAAAA0Tm8gdHJhaWxpbmcgZmFpbHVyZSBzaWduYWwgYW5kIG5vIGV2ZW50IGluIHByb2dyZXNzLgAAAAVDbGVhcgAAAAAAAAAAAABKQW4gZXZlbnQgZm9yIHRoZSBhc3NldCwgb2YgYW55IGtpbmQsIGlzIFByb3Bvc2VkLCBDaGFsbGVuZ2VkIG9yCkVzY2FsYXRlZC4AAAAAAA9FdmVudEluUHJvZ3Jlc3MAAAAAAAAAAFBBbiBlcG9jaCBpbiB0aGUgdHJhaWxpbmcgZGVwZWcgd2luZG93IGhhcyBgcGVnX3JhdGlvYCBiZWxvdyB0aGUKZGVwZWcgdGhyZXNob2xkLgAAAAtSZWNlbnREZXBlZwAAAAAAAAAAQUVuZHBvaW50IHN0YXR1cyB3YXMgRG93biBvciBEZWdyYWRlZCBpbiB0aGUgdHJhaWxpbmcgaGFsdCB3aW5kb3cuAAAAAAAAFFJlY2VudEVuZHBvaW50T3V0YWdlAAAAAAAAAENBIGNsYXdiYWNrIG9yIGF1dGhvcml6YXRpb24gcmV2b2NhdGlvbiBvY2N1cnJlZCBpbiB0aGUgbGFzdCA3IGRheXMuAAAAABJSZWNlbnRJc3N1ZXJBY3Rpb24AAAAAAAAAAAIWU2luY2UgdjEuNSAoU2VjdGlvbiA1LjkgUzUpOiBtb3JlIHVuYnVpbHQgaG91cnMgc2l0IGluIHRoZQp0cmFpbGluZyBkZXBlZyB3aW5kb3cgdGhhbiBgY292ZXJfZ2F0ZWAgY2FuIHNhZmVseSBzY2FuIGluIG9uZQpjYWxsIChgTUFYX1VOQlVJTFRfSE9VUlNfU0NBTk5FRF9CWV9DT1ZFUl9HQVRFYCkuIEJsb2NrcyBuZXcKY292ZXIgdGhlIHNhbWUgd2F5IGFueSBvdGhlciBnYXRlIHN0YXRlIGRvZXMsIHJhdGhlciB0aGFuCnNraXBwaW5nIHRoZSBkZXBlZyBjaGVjayBvdXRyaWdodCBvciByaXNraW5nIHRoZSBjYWxsIGl0c2VsZgpleGNlZWRpbmcgdGhlIG5ldHdvcmsncyBvd24gdHJhbnNhY3Rpb24gbWVtb3J5IGxpbWl0OiBhIGxvbmcKZW5vdWdoIGJ1aWxkIGJhY2tsb2csIG9yIGVub3VnaCBzaW11bHRhbmVvdXMgZGlzcHV0ZXMgZWFjaApob2xkaW5nIHRoZWlyIG93biBob3VyIG9wZW4sIHJlYWRzIHRoZSBzYW1lIGFzIGEgZGVwZWcgd291bGQsCnNpbmNlIHRoZSBmZWVkIGNhbm5vdCBjdXJyZW50bHkgcHJvdmUgaXQgaXMgY2xlYXIuAAAAAAAOVW5idWlsdEJhY2tsb2cAAA==",
        "AAAAAgAAAAAAAAAAAAAACUV2ZW50S2luZAAAAAAAAAUAAAAAAAAAAAAAAAVEZXBlZwAAAAAAAAAAAAAAAAAADElzc3VlckZyZWV6ZQAAAAAAAAAAAAAAEk1pbnRXaXRob3V0QmFja2luZwAAAAAAAAAAAAAAAAAOV2l0aGRyYXdhbEhhbHQAAAAAAAAAAAAAAAAACkluc29sdmVuY3kAAA==",
        "AAAAAgAAAAAAAAAAAAAACkV2ZW50U3RhdGUAAAAAAAcAAAAAAAAAAAAAAAROb25lAAAAAAAAAAAAAAAIUHJvcG9zZWQAAAAAAAAAAAAAAApDaGFsbGVuZ2VkAAAAAAAAAAAAAAAAAAlFc2NhbGF0ZWQAAAAAAAAAAAAAAAAAAAhEZWNsYXJlZAAAAAAAAAAAAAAACFJlamVjdGVkAAAAAAAAAAAAAAAFQ3VyZWQAAAA=",
        "AAAAAQAAAGlPbmUgcHJvcG9zZWQgY3JlZGl0IGV2ZW50LCBrZXllZCBieSBgKGFzc2V0LCBraW5kLCBkZWZfdmVyc2lvbilgCihBRFItMDAxKS4gdGVjaG5pY2FsLWRvYy5tZCBTZWN0aW9uIDQuMy4AAAAAAAAAAAAAC0V2ZW50UmVjb3JkAAAAAA0AAAAAAAAABWFzc2V0AAAAAAAAEwAAAEVQcm9wb3NlciBib25kLCBoZWxkIGJ5IFN0YWtpbmcgKEFEUi0wMDQpLiBaZXJvIGZvciBUaWVyIDEgYW5kIFRpZXIgMy4AAAAAAAAEYm9uZAAAAAsAAAAAAAAAC2RlY2xhcmVkX2F0AAAAA+gAAAAGAAAAQlRoZSBjYW5vbmljYWwgZGVmaW5pdGlvbiB2ZXJzaW9uIHRoZSBwcm9wb3NhbCB3YXMgY2hlY2tlZCBhZ2FpbnN0LgAAAAAAC2RlZl92ZXJzaW9uAAAAAAQAAACCU2V0IHdoZW4gYSBjaGFsbGVuZ2UgZXNjYWxhdGVzIHRoZSBldmVudCB0byB0aGUgY29tbWl0dGVlLiBUaGUgcnVsaW5nCmRlYWRsaW5lIGlzIGBlc2NhbGF0ZWRfYXQgKyBydWxpbmdfZGVhZGxpbmVfc2Vjc2AgKEFEUi0wMDIpLgAAAAAADGVzY2FsYXRlZF9hdAAAA+gAAAAGAAAAAAAAAA1ldmlkZW5jZV9oYXNoAAAAAAAD7gAAACAAAAAAAAAAAmlkAAAAAAAGAAAAAAAAAARraW5kAAAH0AAAAAlFdmVudEtpbmQAAAAAAAAAAAAAC3Byb3Bvc2VkX2F0AAAAAAYAAAAAAAAACHByb3Bvc2VyAAAAEwAAAAAAAAAFc3RhdGUAAAAAAAfQAAAACkV2ZW50U3RhdGUAAAAAAAoxLCAyIG9yIDMuAAAAAAAEdGllcgAAAAQAAABaU3RhcnQgb2YgdGhlIGZhaWx1cmUgd2luZG93LiBEZWNpZGVzIHdoaWNoIHNlcmllcyB0aGUgZXZlbnQgY292ZXJzCihBRFItMDAzLCBTZWN0aW9uIDguNikuAAAAAAAMd2luZG93X3N0YXJ0AAAABg==",
        "AAAAAQAAATxUaGUgY2Fub25pY2FsLCB2ZXJzaW9uZWQgcnVsZXMgZm9yIG9uZSBldmVudCBraW5kIG9uIG9uZSBhc3NldC4KU3RvcmVkIGJ5IGAoYXNzZXQsIGtpbmQsIHZlcnNpb24pYDsgZXhhY3RseSBvbmUgdmVyc2lvbiBwZXIKYChhc3NldCwga2luZClgIGlzIGNhbm9uaWNhbCBhdCBhIHRpbWUgKEFEUi0wMDEpLgp0ZWNobmljYWwtZG9jLm1kIFNlY3Rpb24gNC4zLgoKUGFyYW1ldGVycyB0aGF0IGRvIG5vdCBhcHBseSB0byBga2luZGAgbXVzdCBiZSB6ZXJvOyBgcmVnaXN0ZXJfZGVmaW5pdGlvbmAKcmVqZWN0cyBhIGRlZmluaXRpb24gdGhhdCBzZXRzIHRoZW0uAAAAAAAAAA9FdmVudERlZmluaXRpb24AAAAADgAAAAAAAAAFYXNzZXQAAAAAAAATAAABwUlzc3VlckZyZWV6ZTogbmV3IChmZWF0L2V2ZW50LXJlZ2lzdHJ5KS4gU2VjdGlvbiA4LjIncyBvd24gdGV4dAooImBhdXRoX3Jldm9jYXRpb25zYCBhYm92ZSB0aGUgdGhyZXNob2xkIikgbmFtZXMgdGhpcyBjaGVjayBidXQKdGhlIHNwZWMsIGJlZm9yZSB0aGlzIGZpZWxkLCBkZWZpbmVkIG5vIHRocmVzaG9sZCBmb3IgaXQ7CmBmcmVlemVfcGN0X2Jwc2AgaXMgYSBiYXNpcy1wb2ludHMgcmF0aW8gYWdhaW5zdCBgc3VwcGx5YCwKd2hpY2ggaGFzIG5vIHNlbnNpYmxlIG1lYW5pbmcgYWdhaW5zdCBhIHJhdyByZXZvY2F0aW9uIGNvdW50LgpUaGUgY291bnQgb2YgYXV0aG9yaXphdGlvbiByZXZvY2F0aW9ucyBpbiB0aGUgNyBkYXkgd2luZG93IG11c3QKZXhjZWVkIHRoaXMgdmFsdWUgZm9yIHRoZSByZXZvY2F0aW9uIGJyYW5jaCBvZiB0aGUgSXNzdWVyRnJlZXplCmNoZWNrIHRvIHBhc3MuAAAAAAAAGWF1dGhfcmV2b2NhdGlvbl90aHJlc2hvbGQAAAAAAAAEAAAAF0FsbCBraW5kczogZS5nLiA4Nl80MDAuAAAAAA5jaGFsbGVuZ2Vfc2VjcwAAAAAABgAAAC1EZXBlZzogZS5nLiA5XzgwMF8wMDAsIG9ubHkgZHVyaW5nIGNoYWxsZW5nZS4AAAAAAAAOY3VyZV90aHJlc2hvbGQAAAAAAAsAAAAdRGVwZWc6IGUuZy4gOV81MDBfMDAwID0gMC45NS4AAAAAAAAPZGVwZWdfdGhyZXNob2xkAAAAAAsAAAAaRGVwZWc6IGUuZy4gMjU5XzIwMCA9IDcyaC4AAAAAABFkZXBlZ193aW5kb3dfc2VjcwAAAAAAAAYAAABsSXNzdWVyRnJlZXplOiBYIGluIHRoZSBQUkQuIENvbXBhcmVkIGFnYWluc3QgYGNsYXdiYWNrX2Ftb3VudCAvCnN1cHBseWAgb3ZlciB0aGUgNyBkYXkgd2luZG93IChTZWN0aW9uIDguMikuAAAADmZyZWV6ZV9wY3RfYnBzAAAAAAAEAAAAI1dpdGhkcmF3YWxIYWx0OiBlLmcuIDI1OV8yMDAgPSA3MmguAAAAABBoYWx0X3dpbmRvd19zZWNzAAAABgAAAAAAAAAEa2luZAAAB9AAAAAJRXZlbnRLaW5kAAAAAAAAf0RlcGVnOiBlcG9jaHMgaW4gdGhlIHdpbmRvdyB3aXRoIG5vIEZpbmFsIHBvc3RpbmcgdGhhdCBhcmUgaWdub3JlZCwKZS5nLiA2IG9mIDcyLiBNb3JlIHRoYW4gdGhpcyBhbmQgdGhlIGNoZWNrIGZhaWxzIChBRFItMDA1KS4AAAAAEm1heF9taXNzaW5nX2Vwb2NocwAAAAAABAAAACFNaW50V2l0aG91dEJhY2tpbmc6IFkgaW4gdGhlIFBSRC4AAAAAAAAObWludF9zcGlrZV9icHMAAAAAAAQAAACGQ29weSBvZiBgQXNzZXRDb25maWcucmVmZXJlbmNlYCBhdCByZWdpc3RyYXRpb24sIGluY2x1ZGluZyB0aGUgRlgKcmF0ZSBzb3VyY2UsIHNvIHRoZSBkZWZpbml0aW9uIGZpeGVzIHdoYXQgInRoZSBwZWciIG1lYW5zIChBRFItMDA2KS4AAAAAAAlyZWZlcmVuY2UAAAAAAAfQAAAACVJlZmVyZW5jZQAAAAAAAGFBbGwga2luZHM6IGNvbW1pdHRlZSBydWxpbmcgZGVhZGxpbmUgY291bnRlZCBmcm9tIGVzY2FsYXRpb24sCmUuZy4gMV8yMDlfNjAwID0gMTQgZGF5cyAoQURSLTAwMikuAAAAAAAAFHJ1bGluZ19kZWFkbGluZV9zZWNzAAAABgAAAGlkZWZfdmVyc2lvbi4gQXNzaWduZWQgYnkgYHJlZ2lzdGVyX2RlZmluaXRpb25gIGFzIHRoZSBwcmV2aW91cwpjYW5vbmljYWwgdmVyc2lvbiBwbHVzIG9uZSwgc3RhcnRpbmcgYXQgMS4AAAAAAAAHdmVyc2lvbgAAAAAE",
        "AAAAAgAAAJhSZXR1cm5lZCBieSBgRXZlbnRSZWdpc3RyeTo6ZXZlbnRfc3RhdHVzKGFzc2V0LCBraW5kKWAsIHdoaWNoIGlzIHBlcgpgKGFzc2V0LCBraW5kKWAgZm9yIHRoZSBjYW5vbmljYWwgdmVyc2lvbiAoQURSLTAwMSkuCnRlY2huaWNhbC1kb2MubWQgU2VjdGlvbiAxMi4yLgAAAAAAAAAQQXNzZXRFdmVudFN0YXR1cwAAAAMAAAAAAAAAAAAAAAROb25lAAAAAQAAAAsoZXZlbnRfaWQpLgAAAAAKSW5Qcm9ncmVzcwAAAAAAAQAAAAYAAAABAAAAMyhldmVudF9pZCwgZGVmX3ZlcnNpb24sIHdpbmRvd19zdGFydCwgZGVjbGFyZWRfYXQpLgAAAAAIRGVjbGFyZWQAAAAEAAAABgAAAAQAAAAGAAAABg==" ]),
      options
    )
  }
  public readonly fromJSON = {
    rule: this.txFromJSON<Result<void>>,
        event: this.txFromJSON<Option<EventRecord>>,
        covers: this.txFromJSON<boolean>,
        finalize: this.txFromJSON<Result<void>>,
        challenge: this.txFromJSON<Result<void>>,
        cover_gate: this.txFromJSON<Result<CoverGate>>,
        definition: this.txFromJSON<Option<EventDefinition>>,
        initialize: this.txFromJSON<Result<void>>,
        in_progress: this.txFromJSON<boolean>,
        event_status: this.txFromJSON<AssetEventStatus>,
        has_declared: this.txFromJSON<boolean>,
        propose_tier1: this.txFromJSON<Result<u64>>,
        checkpoint_cure: this.txFromJSON<Result<CureProgress>>,
        current_version: this.txFromJSON<u32>,
        resolve_timeout: this.txFromJSON<Result<void>>,
        ruling_deadline: this.txFromJSON<Option<u64>>,
        committee_misses: this.txFromJSON<u32>,
        active_event_count: this.txFromJSON<u32>,
        register_definition: this.txFromJSON<Result<u32>>
  }
}
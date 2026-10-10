import { riskOracleClient } from "./contracts/risk-oracle";
import { assetDisplayName } from "./contracts/token";
import { riskBandFor } from "./band";
import type { RiskBand } from "@sylox/ui/risk-bands";

const PEG_RATIO_SCALE = 10_000_000; // i128, scale 1e7 (lib/contracts/risk-oracle's own doc comment on peg_ratio).

export interface ExplorerAssetRow {
  asset: string;
  /**
   * The asset code, parsed off the front of SEP-41 name()'s
   * "CODE:ISSUER" format (e.g. "USDC"). Falls back to the shortened
   * contract address if name() failed or didn't contain a ":".
   */
  code: string;
  /** RiskOracle.asset_config(asset).home_domain, or null if unset. */
  homeDomain: string | null;
  band: RiskBand;
  /** 0-100, or null when the contract has no score yet (brand-new asset, epoch 0). */
  score: number | null;
  /**
   * latest(asset).peg_ratio, descaled to a plain decimal (e.g. 0.9998).
   * Null when there's no posted signal yet (latest() returns None) - a
   * brand-new asset reads this the same honest way score does.
   */
  pegRatio: number | null;
  /**
   * Read straight from the contract's own check_stale()/score().stale
   * (never recomputed client-side - see lib/contracts/risk-oracle's
   * is_stale/check_stale doc comments and technical-doc.md Section 5.5:
   * check_stale/score().stale is the recommended read, is_stale alone
   * can miss a stalled-finality gap).
   */
  stale: boolean;
  /** RiskOracle.event_in_progress(asset): a challenge window is open. */
  eventInProgress: boolean;
  /**
   * The Event band is only ever reachable by an explicit declared-event
   * flag, never by score alone (technical-doc.md Section 6.3: "sticky
   * until governance re-registers a new canonical definition version").
   * So band.tag === "Event" already means an event has been declared;
   * no second contract read is needed to know that.
   */
  eventDeclared: boolean;
}

export interface ExplorerAssetError {
  asset: string;
  message: string;
}

export interface ExplorerData {
  rows: ExplorerAssetRow[];
  /** Assets whose reads failed - rendered as their own "couldn't read this asset" cards, not a page-wide failure. */
  errors: ExplorerAssetError[];
}

function codeFromDisplayName(name: string, asset: string): string {
  const [code] = name.split(":");
  // A fallback name (already a shortened address, from assetDisplayName's
  // own catch) has no ":" to split on - fall through to the same shape.
  return code && code !== name ? code : `${asset.slice(0, 4)}…${asset.slice(-4)}`;
}

async function fetchRow(
  oracle: ReturnType<typeof riskOracleClient>,
  asset: string,
): Promise<ExplorerAssetRow> {
  const [scoreTx, staleTx, inProgressTx, latestTx, configTx, name] = await Promise.all([
    oracle.score({ asset }),
    oracle.check_stale({ asset }),
    oracle.event_in_progress({ asset }),
    oracle.latest({ asset }),
    oracle.asset_config({ asset }),
    assetDisplayName(asset),
  ]);

  const scoreResult = scoreTx.result;
  if (scoreResult.isErr()) {
    throw new Error(
      `RiskOracle.score returned a contract error: ${scoreResult.unwrapErr().message}`,
    );
  }
  const riskScore = scoreResult.unwrap();

  const staleResult = staleTx.result;
  const stale = staleResult.isErr() ? true : staleResult.unwrap();

  const latest = latestTx.result;
  const pegRatio = latest ? Number(latest.peg_ratio) / PEG_RATIO_SCALE : null;

  const config = configTx.result;
  const homeDomain = config?.home_domain || null;

  return {
    asset,
    code: codeFromDisplayName(name, asset),
    homeDomain,
    band: riskBandFor(riskScore.band),
    score: riskScore.epoch === BigInt(0) ? null : riskScore.score,
    pegRatio,
    stale,
    eventInProgress: inProgressTx.result,
    eventDeclared: riskScore.band.tag === "Event",
  };
}

/**
 * Fetches every tracked asset's current risk band, score, latest peg
 * value, staleness and event status straight from RiskOracle. Every
 * value here is a live contract read; nothing is computed or hardcoded
 * on the client side of what the contract itself reports.
 *
 * One asset's read failing (a bad config, an RPC hiccup) never fails
 * the whole page: that asset's error is collected separately so the
 * rest of the grid still renders.
 */
export async function fetchExplorerData(): Promise<ExplorerData> {
  const oracle = riskOracleClient();

  const assetsTx = await oracle.assets();
  const assets = assetsTx.result;

  const rows: ExplorerAssetRow[] = [];
  const errors: ExplorerAssetError[] = [];

  const results = await Promise.allSettled(assets.map((asset) => fetchRow(oracle, asset)));

  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      rows.push(result.value);
    } else {
      errors.push({
        asset: assets[index],
        message: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  });

  return { rows, errors };
}

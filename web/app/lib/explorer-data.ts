import { riskOracleClient } from "./contracts/risk-oracle";
import { riskBandFor } from "./band";
import type { RiskBand } from "@sylox/ui/risk-bands";

export interface ExplorerAssetRow {
  asset: string;
  band: RiskBand;
  /** 0-100, or null when the contract has no score yet (brand-new asset, epoch 0). */
  score: number | null;
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

/**
 * Fetches every tracked asset's current risk band, score, staleness and
 * event status straight from RiskOracle. Every value here is a live
 * contract read; nothing is computed or hardcoded on the client side of
 * what the contract itself reports.
 */
export async function fetchExplorerRows(): Promise<ExplorerAssetRow[]> {
  const oracle = riskOracleClient();

  const assetsTx = await oracle.assets();
  const assets = assetsTx.result;

  const rows = await Promise.all(
    assets.map(async (asset): Promise<ExplorerAssetRow> => {
      const [scoreTx, staleTx, inProgressTx] = await Promise.all([
        oracle.score({ asset }),
        oracle.check_stale({ asset }),
        oracle.event_in_progress({ asset }),
      ]);

      const scoreResult = scoreTx.result;
      if (scoreResult.isErr()) {
        throw new Error(
          `RiskOracle.score(${asset}) returned a contract error: ${scoreResult.unwrapErr().message}`,
        );
      }
      const riskScore = scoreResult.unwrap();

      const staleResult = staleTx.result;
      const stale = staleResult.isErr() ? true : staleResult.unwrap();

      return {
        asset,
        band: riskBandFor(riskScore.band),
        score: riskScore.epoch === BigInt(0) ? null : riskScore.score,
        stale,
        eventInProgress: inProgressTx.result,
        eventDeclared: riskScore.band.tag === "Event",
      };
    }),
  );

  return rows;
}

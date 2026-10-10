/** stellar.expert's testnet transaction URL, for every write this screen makes - so the result of Checkpoint/Finalize is independently checkable, not just "the button said it worked." */
export function stellarExpertTxUrl(hash: string): string {
  return `https://stellar.expert/explorer/testnet/tx/${hash}`;
}

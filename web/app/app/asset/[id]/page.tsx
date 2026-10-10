import { AssetPageClient } from "./AssetPageClient";

// Every asset ID is a runtime contract address chosen by the visitor,
// and the page's data comes from live RPC reads, not anything
// prerenderable - this route is never static (Cache Components' own
// "block" escape hatch, see the build error this silences).
export const instant = false;

export default async function AssetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: asset } = await params;
  return <AssetPageClient asset={asset} />;
}

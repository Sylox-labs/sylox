import { EventPageClient } from "./EventPageClient";

// Same reasoning as the Asset screen's page.tsx: every event ID is
// chosen at runtime and the page's data comes from live RPC reads, so
// it can never be meaningfully prerendered - Cache Components' own
// "block" escape hatch.
export const instant = false;

export default async function EventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EventPageClient eventId={id} />;
}

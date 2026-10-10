"use client";

import { useEffect, useState } from "react";

function formatRemaining(seconds: number): string {
  if (seconds <= 0) return "Window closed";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
  return `${minutes}m ${secs}s`;
}

/** Ticks once a second toward a real contract deadline (never a RingSlot's pending_until - see lib/event-data.ts's fetchCountdown doc comment). */
export function Countdown({ deadline, label }: { deadline: bigint; label: string }) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const interval = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(interval);
  }, []);

  const remaining = Number(deadline) - now;

  return (
    <div>
      <p className="font-mono text-xs uppercase tracking-wide text-cyber-tin">{label}</p>
      <p className="mt-1 font-mono text-2xl text-silo-oatmeal" data-numeric>
        {formatRemaining(remaining)}
      </p>
    </div>
  );
}

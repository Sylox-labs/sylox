/**
 * Reduced-motion fallback for Ledger Grid: a plain CSS grid of dots
 * composing a single static state-1-like frame (even lattice, Cyber Tin
 * with Nth-point Silo Oatmeal accents, no motion). Simplification per the
 * brief §"Respect prefers-reduced-motion" — a true per-state crossfade is
 * out of scope for this checkpoint build.
 */
const COLUMNS = 24;
const ROWS = 14;
const TOTAL = COLUMNS * ROWS;

export function LedgerGridStaticFallback() {
  const dots = Array.from({ length: TOTAL }, (_, index) => index);

  return (
    <div
      className="flex h-full w-full items-center justify-center bg-slate-black"
      aria-hidden="true"
    >
      <div
        className="grid w-full max-w-5xl gap-[clamp(6px,1.4vw,18px)] px-10"
        style={{ gridTemplateColumns: `repeat(${COLUMNS}, minmax(0, 1fr))` }}
      >
        {dots.map((index) => (
          <span
            key={index}
            className="aspect-square rounded-full"
            style={{
              backgroundColor:
                index % 7 === 0
                  ? "var(--color-silo-oatmeal)"
                  : "var(--color-cyber-tin)",
              opacity: index % 7 === 0 ? 0.9 : 0.45,
            }}
          />
        ))}
      </div>
    </div>
  );
}

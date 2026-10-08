/**
 * Reduced-motion fallback for Horizon Line: a plain CSS composition of
 * state 1 ("holding the peg") — a tight, still horizontal band of dots.
 * Simplification note: the brief's §7.2 ideal is a per-state crossfade;
 * for this checkpoint we render a single static state-1-like frame behind
 * all four panels, which satisfies "no motion, no WebGL dependency" without
 * building four separate composited frames.
 */
export function HorizonLineStaticFallback() {
  const dots = Array.from({ length: 48 }, (_, i) => i);

  return (
    <div className="relative flex h-full w-full items-center justify-center bg-slate-black">
      <div className="flex w-full max-w-5xl items-center gap-[2px] px-10">
        {dots.map((i) => (
          <span
            key={i}
            className="h-[3px] flex-1 rounded-full"
            style={{
              backgroundColor: i % 9 === 0 ? "var(--color-silo-oatmeal)" : "var(--color-cyber-tin)",
              opacity: 0.55 + ((i % 5) / 5) * 0.3,
            }}
          />
        ))}
      </div>
    </div>
  );
}

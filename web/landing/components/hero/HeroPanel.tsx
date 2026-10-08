export interface HeroCta {
  label: string;
  href: string;
  variant: "primary" | "secondary";
}

interface HeroPanelProps {
  eyebrow: string;
  heading: string;
  body: string;
  ctas?: HeroCta[];
  /** Panel 1's heading renders as the page's single real <h1> (brief §7.2). */
  isFirstPanel?: boolean;
  panelIndex: number;
}

/**
 * One of the four scrolling copy panels over a hero canvas. Panel 1 is
 * visible immediately (it's the LCP element); panels 2-4 get a staggered
 * parallax entrance driven by a per-panel CSS custom property written from
 * ScrollTrigger (see lib/motion/scrollProgressVar.ts) — the entrance
 * itself is plain CSS reading that variable, not JS-driven per frame.
 */
export function HeroPanel({
  eyebrow,
  heading,
  body,
  ctas,
  isFirstPanel = false,
  panelIndex,
}: HeroPanelProps) {
  const HeadingTag = isFirstPanel ? "h1" : "h2";

  return (
    <div
      className="flex min-h-screen items-center px-6 md:px-16"
      style={{ "--delay": panelIndex } as React.CSSProperties}
      data-hero-panel
    >
      <div className="relative max-w-xl py-24 md:py-0">
        <div
          className="absolute inset-0 -z-10 rounded-3xl bg-[radial-gradient(ellipse_at_left,_rgba(11,12,14,0.85),_transparent_70%)] md:-inset-x-12"
          aria-hidden="true"
        />
        <p className="font-mono text-xs uppercase tracking-[0.15em] text-cyber-tin md:text-sm">
          {eyebrow}
        </p>
        <HeadingTag className="mt-4 font-display text-4xl leading-[0.95] tracking-tight text-silo-oatmeal md:text-6xl">
          {heading}
        </HeadingTag>
        <p className="mt-6 max-w-md text-base leading-relaxed text-cyber-tin md:text-lg">
          {body}
        </p>
        {ctas && (
          <div className="mt-8 flex flex-wrap gap-4">
            {ctas.map((cta) => (
              <a
                key={cta.label}
                href={cta.href}
                className={
                  cta.variant === "primary"
                    ? "rounded-full bg-risk-crimson px-6 py-3 text-sm font-medium text-slate-black transition-colors hover:bg-risk-crimson-tint"
                    : "rounded-full border border-cement-grey px-6 py-3 text-sm font-medium text-silo-oatmeal transition-colors hover:border-silo-oatmeal"
                }
              >
                {cta.label}
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

import { hero } from "@/content";
import { Eyebrow, ButtonLink } from "@sylox/ui/components";

/**
 * ProofBridge-style layout trial: full-bleed looping video occupies the
 * upper field as ambient background, the headline sits lower-left at
 * poster scale, and eyebrow/body ride alongside it as a small side note
 * rather than stacked above. Antigravity is intentionally not mounted
 * here (not deleted — see AntigravityField.tsx) while this direction is
 * being evaluated against the particle-field version.
 */
export function SimpleHero() {
  const panel = hero.panels[0];

  return (
    <section
      data-theme="dark"
      className="relative isolate flex min-h-screen flex-col justify-end overflow-hidden bg-slate-black px-6 pb-16 pt-24 md:px-16 md:pb-20"
    >
      <video
        className="absolute inset-0 h-full w-full object-cover"
        src="/brand/sylox-radar-hero.webm"
        autoPlay
        loop
        muted
        playsInline
        aria-hidden="true"
      />

      {/* Readability scrim: darkens behind the copy so the video never
          competes with it. On mobile the copy spans the full width (the
          hero stacks, it isn't side-by-side), so a left-anchored radial
          fade leaves the right half of the text unprotected — this uses
          a full-width vertical scrim there instead, and only switches to
          the narrower left-anchored radial once the layout is genuinely
          asymmetric at md. */}
      <div
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,_rgba(11,12,14,0.7)_0%,_rgba(11,12,14,0.3)_40%,_rgba(11,12,14,0.92)_75%,_rgba(11,12,14,0.97)_100%)] md:bg-[linear-gradient(0deg,_rgba(11,12,14,0.95)_0%,_rgba(11,12,14,0.6)_35%,_rgba(11,12,14,0.15)_60%,_rgba(11,12,14,0.5)_100%)]"
        aria-hidden="true"
      />

      <div className="relative z-10 flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
        <h1 className="max-w-4xl font-display text-5xl font-black leading-[0.92] tracking-tight text-silo-oatmeal md:text-8xl lg:text-9xl">
          {panel.heading}
        </h1>

        <div className="max-w-xs md:pb-3 md:text-right">
          <Eyebrow>{panel.eyebrow}</Eyebrow>
          <p className="mt-3 text-sm leading-relaxed text-cyber-tin md:text-base">
            {panel.body}
          </p>
        </div>
      </div>

      {panel.ctas && (
        <div className="relative z-10 mt-8 flex flex-wrap gap-4">
          {panel.ctas.map((cta) => (
            <ButtonLink key={cta.label} href={cta.href} variant={cta.variant}>
              {cta.label}
            </ButtonLink>
          ))}
        </div>
      )}
    </section>
  );
}

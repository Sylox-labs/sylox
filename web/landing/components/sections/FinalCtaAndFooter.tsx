"use client";

import { useRef, useState, type FormEvent } from "react";
import Image from "next/image";
import { finalCta, footer, openSource, nav } from "@/content";
import { useScrollReveal } from "@/lib/motion/useScrollReveal";
import { RoleDropdown } from "./RoleDropdown";

type SubmitState = "idle" | "submitting" | "success" | "error";

/**
 * Deliberately NOT dark-on-dark after Faq: light surface, full-width
 * poster heading instead of the eyebrow+h2+body pattern every other
 * section used, so it reads as its own closing statement rather than a
 * continuation of the FAQ list. The open-source blurb + footer sit in a
 * separate dark bar beneath, visually a different object (denser, smaller
 * type, multi-column) rather than a repeat of this section's own shape.
 */
export function FinalCtaAndFooter() {
  const [submitState, setSubmitState] = useState<SubmitState>("idle");
  const waitlistUrl = process.env.NEXT_PUBLIC_WAITLIST_URL;
  const containerRef = useRef<HTMLDivElement>(null);
  useScrollReveal(containerRef);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const email = (form.elements.namedItem("email") as HTMLInputElement).value;
    const role = (form.elements.namedItem("role") as HTMLSelectElement).value;

    if (!waitlistUrl) {
      window.location.href = `mailto:hello@sylox.xyz?subject=Early access&body=${encodeURIComponent(
        `Email: ${email}\nRole: ${role}`,
      )}`;
      return;
    }

    setSubmitState("submitting");
    try {
      const response = await fetch(waitlistUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role }),
      });
      if (!response.ok) throw new Error(`Request failed: ${response.status}`);
      setSubmitState("success");
      form.reset();
    } catch {
      setSubmitState("error");
    }
  }

  return (
    <>
      <section
        id="early-access"
        data-theme="light"
        className="bg-silo-oatmeal px-6 py-32 md:px-16 md:py-48"
      >
        <div ref={containerRef} className="mx-auto max-w-5xl">
          <h2
            data-reveal
            className="font-display text-[13vw] leading-[0.88] tracking-tight text-slate-black md:text-[7vw]"
          >
            {finalCta.heading}
          </h2>
          <p data-reveal className="mt-8 max-w-md text-base leading-relaxed text-anchor-graphite md:text-lg">
            {finalCta.body}
          </p>

          <form
            data-reveal
            onSubmit={handleSubmit}
            className="mt-10 flex flex-col gap-4 md:flex-row"
          >
            <label className="sr-only" htmlFor="email">
              Email address
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              placeholder="you@example.com"
              className="flex-1 rounded-full border border-cement-grey bg-transparent px-5 py-3 text-sm text-slate-black placeholder:text-anchor-graphite/60 focus-visible:border-risk-crimson"
            />
            <RoleDropdown name="role" options={finalCta.roles} placeholder="Role" />
            <button
              type="submit"
              disabled={submitState === "submitting"}
              className="shrink-0 rounded-full bg-risk-crimson px-6 py-3 text-sm font-medium text-slate-black transition-colors hover:bg-risk-crimson-tint disabled:opacity-60"
            >
              {submitState === "submitting" ? "Sending..." : finalCta.submitLabel}
            </button>
          </form>

          <div role="status" aria-live="polite" className="mt-3 min-h-[1.5em]">
            {submitState === "success" && (
              <p className="text-sm text-slate-black">
                You&apos;re on the list. We&apos;ll be in touch.
              </p>
            )}
            {submitState === "error" && (
              <p className="text-sm text-risk-crimson">
                Something went wrong. Try again, or email{" "}
                <a href="mailto:hello@sylox.xyz" className="underline">
                  hello@sylox.xyz
                </a>
                .
              </p>
            )}
          </div>
        </div>
      </section>

      <footer data-theme="dark" className="bg-slate-black px-6 py-16 md:px-16">
        <div className="mx-auto max-w-5xl">
          <div className="flex items-center gap-3">
            <Image
              src="/brand/sylox-mark.webp"
              alt=""
              width={56}
              height={48}
              className="h-12 w-auto"
            />
            <span className="font-display text-3xl font-black uppercase tracking-tight text-silo-oatmeal">
              Sylox
            </span>
          </div>

          <div className="mt-10 grid gap-10 border-b border-cement-grey/30 pb-12 md:grid-cols-4">
            <div>
              <p className="font-mono text-xs uppercase tracking-[0.15em] text-cyber-tin">
                {openSource.eyebrow}
              </p>
              <p className="mt-3 text-sm leading-relaxed text-silo-oatmeal">
                {openSource.heading}
              </p>
            </div>
            {openSource.items.map((item) => (
              <div key={item.title}>
                <p className="font-mono text-xs uppercase tracking-wide text-silo-oatmeal">
                  {item.title}
                </p>
                <p className="mt-2 text-sm leading-relaxed text-cyber-tin">
                  {item.body}
                </p>
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-6 pt-8 text-sm text-cyber-tin md:flex-row md:items-center md:justify-between">
            <p className="text-xs">{footer.tagline}</p>
            <nav className="flex gap-6" aria-label="Footer">
              <a
                href={nav.github.href}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-silo-oatmeal"
              >
                GitHub
              </a>
              <a href={footer.links.x} className="hover:text-silo-oatmeal">
                X
              </a>
              <a href={footer.links.contact} className="hover:text-silo-oatmeal">
                Contact
              </a>
            </nav>
          </div>
          <div className="mt-6 text-xs text-cyber-tin/70">
            © {new Date().getFullYear()} Sylox. {footer.builtOnStellar}.
          </div>
        </div>
      </footer>
    </>
  );
}

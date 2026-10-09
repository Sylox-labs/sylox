"use client";

import { useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { faq } from "@/content";
import { useScrollReveal } from "@/lib/motion/useScrollReveal";

export function Faq() {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  useScrollReveal(containerRef);

  return (
    <section
      id="faq"
      data-theme="light"
      className="bg-silo-oatmeal px-6 py-24 md:px-16 md:py-32"
    >
      <div ref={containerRef} className="mx-auto max-w-3xl">
        <p data-reveal className="font-mono text-xs uppercase tracking-[0.15em] text-anchor-graphite md:text-sm">
          {faq.eyebrow}
        </p>
        <h2 data-reveal className="mt-4 font-display text-4xl leading-[0.95] tracking-tight text-slate-black md:text-6xl">
          Questions, answered plainly.
        </h2>

        <div className="mt-16 divide-y divide-cement-grey/30 border-y border-cement-grey/30">
          {faq.items.map((item, index) => {
            const isOpen = openIndex === index;
            return (
              <div key={item.question} data-reveal>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-4 py-6 text-left"
                  aria-expanded={isOpen}
                  aria-controls={`faq-answer-${index}`}
                  onClick={() => setOpenIndex(isOpen ? null : index)}
                >
                  <span className="text-lg font-medium text-slate-black md:text-xl">
                    {item.question}
                  </span>
                  <ChevronDown
                    className={`h-6 w-6 shrink-0 text-anchor-graphite transition-transform duration-200 ${
                      isOpen ? "rotate-180 text-risk-crimson" : ""
                    }`}
                    aria-hidden="true"
                  />
                </button>
                <div
                  id={`faq-answer-${index}`}
                  className="grid transition-[grid-template-rows] duration-300 ease-out"
                  style={{ gridTemplateRows: isOpen ? "1fr" : "0fr" }}
                >
                  <div className="overflow-hidden">
                    <p className="max-w-xl pb-6 text-sm leading-relaxed text-anchor-graphite md:text-base">
                      {item.answer}
                    </p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

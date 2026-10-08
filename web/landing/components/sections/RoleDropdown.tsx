"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

interface RoleDropdownProps {
  name: string;
  options: string[];
  placeholder: string;
}

/**
 * Custom-styled listbox replacing the bare native <select> in the final
 * CTA form. Keeps a hidden native <select> in sync for form submission
 * (so handleSubmit's form.elements lookup keeps working unchanged) while
 * rendering its own button + panel for the actual visual/interaction.
 */
export function RoleDropdown({ name, options, placeholder }: RoleDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    function handleClickOutside(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsOpen(false);
        buttonRef.current?.focus();
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  return (
    <div ref={rootRef} className="relative">
      {/* Hidden native select carries the real form value. */}
      <select
        name={name}
        required
        value={selected ?? ""}
        onChange={() => {}}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
      >
        <option value="" disabled>
          {placeholder}
        </option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>

      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((open) => !open)}
        className="flex w-full items-center justify-between gap-3 rounded-full border border-cement-grey bg-transparent px-5 py-3 text-sm text-slate-black transition-colors hover:border-slate-black focus-visible:border-risk-crimson md:w-48"
      >
        <span className={selected ? "" : "text-anchor-graphite/60"}>
          {selected ?? placeholder}
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>

      {isOpen && (
        <ul
          role="listbox"
          tabIndex={-1}
          className="absolute left-0 top-[calc(100%+8px)] z-10 w-full min-w-48 overflow-hidden rounded-lg border border-cement-grey/60 bg-silo-oatmeal shadow-lg"
        >
          {options.map((option) => (
            <li key={option}>
              <button
                type="button"
                role="option"
                aria-selected={selected === option}
                onClick={() => {
                  setSelected(option);
                  setIsOpen(false);
                  buttonRef.current?.focus();
                }}
                className={`flex w-full items-center justify-between px-5 py-3 text-left text-sm transition-colors hover:bg-risk-crimson hover:text-slate-black ${
                  selected === option ? "bg-slate-black/5 font-medium text-slate-black" : "text-anchor-graphite"
                }`}
              >
                {option}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

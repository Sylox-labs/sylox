import type { AnchorHTMLAttributes } from "react";

export interface ButtonLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  variant?: "primary" | "secondary";
}

const VARIANT_CLASS: Record<NonNullable<ButtonLinkProps["variant"]>, string> = {
  primary:
    "rounded-full bg-risk-crimson px-6 py-3 text-sm font-medium text-slate-black transition-colors hover:bg-risk-crimson-tint",
  secondary:
    "rounded-full border border-cement-grey px-6 py-3 text-sm font-medium text-silo-oatmeal transition-colors hover:border-silo-oatmeal",
};

/**
 * The hero CTA pair (brief: primary = filled crimson, secondary = hairline
 * outline), previously duplicated verbatim across HeroPanel and
 * SimpleHero. Renders an `<a>` — every current usage is a navigation
 * link, never a form action.
 */
export function ButtonLink({ variant = "primary", className = "", ...props }: ButtonLinkProps) {
  return <a className={`${VARIANT_CLASS[variant]} ${className}`} {...props} />;
}

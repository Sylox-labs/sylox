import type { AnchorHTMLAttributes, HTMLAttributes } from "react";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Renders as an anchor instead of a div, for the whole-card-as-link pattern. */
  href?: string;
}

const CARD_CLASS =
  "rounded-sm border border-cement-grey/30 p-6 transition-colors hover:border-risk-crimson/50";

/**
 * The hairline card: a 1px border that strengthens to Risk Crimson on
 * hover, the whole card as a single click target when used as a link
 * (DESIGN_NOTES.md: "Hairline card borders that strengthen on hover,
 * with the whole card as a single click target"). No background fill,
 * no shadow — depth comes from the border alone, per house-rule.
 *
 * First real extraction of this pattern (the landing page's own
 * bordered boxes - WhoItsFor's bento cells, Faq's divider rows - are
 * each structurally different enough that none of them were safe to
 * force into one shared component during the design-system PR; this is
 * the first consumer with a plain "isolated bordered box" shape).
 */
export function Card({ href, className = "", ...props }: CardProps) {
  if (href) {
    const { children, ...anchorProps } = props as Omit<CardProps, "href"> &
      AnchorHTMLAttributes<HTMLAnchorElement>;
    return (
      <a href={href} className={`block ${CARD_CLASS} ${className}`} {...anchorProps}>
        {children}
      </a>
    );
  }
  return <div className={`${CARD_CLASS} ${className}`} {...props} />;
}

import Link from "next/link";

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

/** A simple trail (brief: "Add a simple breadcrumb on Asset and Event pages"). The last item is always the current page, plain text, never a link. */
export function Breadcrumb({ items }: { items: BreadcrumbItem[] }) {
  return (
    <nav aria-label="Breadcrumb" className="font-mono text-xs text-cyber-tin">
      <ol className="flex flex-wrap items-center gap-2">
        {items.map((item, i) => (
          <li key={i} className="flex items-center gap-2">
            {i > 0 && <span aria-hidden="true">/</span>}
            {item.href ? (
              <Link href={item.href} className="transition-colors hover:text-silo-oatmeal">
                {item.label}
              </Link>
            ) : (
              <span aria-current="page" className="text-silo-oatmeal">
                {item.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function NavLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
  return (
    <Link
      href={href}
      className={`rounded-md px-2.5 py-1.5 text-[13px] ${
        active
          ? "bg-[var(--color-canvas)] font-medium text-[var(--color-ink)]"
          : "text-[var(--color-muted)] hover:bg-[var(--color-canvas)]"
      }`}
    >
      {children}
    </Link>
  );
}

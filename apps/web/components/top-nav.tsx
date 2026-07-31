"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/boards", label: "Live departures" },
  { href: "/status", label: "Network status" },
  { href: "/map", label: "Live map" },
  { href: "/commute", label: "My commute" },
];

/** True when `href` is the active section (exact for "/", prefix otherwise). */
function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

export function TopNav() {
  const pathname = usePathname();
  return (
    <nav className="topnav" aria-label="Primary">
      {LINKS.map((link) => {
        const active = isActive(pathname, link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={active ? "nav-active" : undefined}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}

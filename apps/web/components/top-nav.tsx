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

interface Props {
  /** Signed-in user — adds a "Settings" link. Signed out: neither link shows. */
  isSignedIn: boolean;
  /** Signed-in admin — adds an "Admin" link alongside Settings. */
  isAdmin: boolean;
}

export function TopNav({ isSignedIn, isAdmin }: Props) {
  const pathname = usePathname();
  const links = [
    ...LINKS,
    ...(isSignedIn ? [{ href: "/settings", label: "Settings" }] : []),
    ...(isAdmin ? [{ href: "/admin", label: "Admin" }] : []),
  ];
  return (
    <nav className="topnav" aria-label="Primary">
      {links.map((link) => {
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

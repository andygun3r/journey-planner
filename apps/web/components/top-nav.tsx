"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AccountMenu } from "@/components/account-menu";

const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/boards", label: "Live departures" },
  { href: "/status", label: "Network status" },
  { href: "/map", label: "Live map" },
];

/** True when `href` is the active section (exact for "/", prefix otherwise). */
function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

interface Props {
  /** Signed-in user — adds the account menu (Settings, and Admin for admins). */
  isSignedIn: boolean;
  /** Signed-in admin — adds an "Admin" link inside the account menu. */
  isAdmin: boolean;
}

export function TopNav({ isSignedIn, isAdmin }: Props) {
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
      {isSignedIn && <AccountMenu isAdmin={isAdmin} />}
    </nav>
  );
}

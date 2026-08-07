"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

interface Props {
  isAdmin: boolean;
}

/** True when `href` is the active section (exact for "/", prefix otherwise). */
function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Account/admin dropdown, separated from the primary product nav (Dashboard,
 * Live departures, Network status, Live map) — Settings and Admin aren't
 * things you navigate to for the timetable, they're account-level. A native
 * <details> gives keyboard support and outside-click-to-close for free.
 */
export function AccountMenu({ isAdmin }: Props) {
  const pathname = usePathname();
  const ref = useRef<HTMLDetailsElement>(null);
  const active = isActive(pathname, "/settings") || isActive(pathname, "/admin");

  // Close after navigating, so the menu doesn't stay open on the next page.
  useEffect(() => {
    ref.current?.removeAttribute("open");
  }, [pathname]);

  return (
    <details ref={ref} className="account-menu">
      <summary className={active ? "nav-active" : undefined}>Account</summary>
      <div className="account-menu-panel" role="menu">
        <Link href="/settings" role="menuitem">
          Settings
        </Link>
        {isAdmin && (
          <Link href="/admin" role="menuitem">
            Admin
          </Link>
        )}
      </div>
    </details>
  );
}

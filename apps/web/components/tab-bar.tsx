"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const TABS = [
  { href: "/", label: "Plan", icon: PlanIcon },
  { href: "/boards", label: "Boards", icon: BoardsIcon },
  { href: "/map", label: "Map", icon: MapIcon },
  { href: "/status", label: "Status", icon: StatusIcon },
];

/** True when `href` is the active section (exact for "/", prefix otherwise). */
function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

interface Props {
  /** Signed-in user — adds a "More" tab (Settings, and Admin for admins). */
  isSignedIn: boolean;
  /** Signed-in admin — adds an "Admin" link inside the "More" sheet. */
  isAdmin: boolean;
}

/**
 * Fixed bottom tab bar — the mobile-native primary navigation (DESIGN.md's
 * signature nav pattern). Desktop keeps the text-link TopNav; this is hidden
 * above the tabbar breakpoint via CSS. Settings/Admin live behind a "More"
 * tab here rather than as extra fixed-width tabs — same account-level split
 * as the desktop AccountMenu dropdown, just a sheet instead of a popover
 * since a dropdown above a fixed bottom bar has nowhere natural to anchor.
 */
export function TabBar({ isSignedIn, isAdmin }: Props) {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreActive = isActive(pathname, "/settings") || isActive(pathname, "/admin");

  // Close the sheet after navigating, so it doesn't stay open on the next page.
  useEffect(() => {
    setMoreOpen(false);
  }, [pathname]);

  return (
    <>
      {isSignedIn && moreOpen && (
        <>
          <button
            type="button"
            className="tab-sheet-backdrop"
            aria-label="Close menu"
            onClick={() => setMoreOpen(false)}
          />
          <div className="tab-sheet" role="menu">
            <Link href="/settings" role="menuitem" className="tab-sheet-item">
              Settings
            </Link>
            {isAdmin && (
              <Link href="/admin" role="menuitem" className="tab-sheet-item">
                Admin
              </Link>
            )}
          </div>
        </>
      )}
      <nav className="tabbar" aria-label="Primary">
        {TABS.map((tab) => {
          const active = isActive(pathname, tab.href);
          const Icon = tab.icon;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={active ? "tab tab-active" : "tab"}
            >
              <Icon />
              <span>{tab.label}</span>
            </Link>
          );
        })}
        {isSignedIn && (
          <button
            type="button"
            className={moreActive ? "tab tab-active" : "tab"}
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((v) => !v)}
          >
            <MoreIcon />
            <span>More</span>
          </button>
        )}
      </nav>
    </>
  );
}

function PlanIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">
      <path
        d="M4 12h16M4 12l4-4M4 12l4 4M20 12l-4-4M20 12l-4 4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function BoardsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">
      <rect x="3.5" y="5" width="17" height="14" rx="2.5" stroke="currentColor" strokeWidth="2" />
      <path d="M3.5 10h17M8 5v14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function MapIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">
      <path
        d="M9 4.5 4 6.5v13l5-2 6 2 5-2v-13l-5 2-6-2Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M9 4.5v13M15 6.5v13" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">
      <circle cx="5" cy="12" r="1.6" fill="currentColor" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" />
      <circle cx="19" cy="12" r="1.6" fill="currentColor" />
    </svg>
  );
}

function StatusIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">
      <path
        d="M4 17V13a8 8 0 0 1 16 0v4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path d="M2.5 17h3v3h-3zM18.5 17h3v3h-3z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

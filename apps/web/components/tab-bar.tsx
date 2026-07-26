"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/", label: "Plan", icon: PlanIcon },
  { href: "/boards", label: "Boards", icon: BoardsIcon },
  { href: "/map", label: "Map", icon: MapIcon },
  { href: "/commute", label: "Commute", icon: CommuteIcon },
  { href: "/status", label: "Status", icon: StatusIcon },
];

/** True when `href` is the active section (exact for "/", prefix otherwise). */
function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Fixed bottom tab bar — the mobile-native primary navigation (DESIGN.md's
 * signature nav pattern). Desktop keeps the text-link TopNav; this is hidden
 * above the tabbar breakpoint via CSS.
 */
export function TabBar() {
  const pathname = usePathname();
  return (
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
    </nav>
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

function CommuteIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true">
      <rect x="5" y="4" width="14" height="16" rx="3" stroke="currentColor" strokeWidth="2" />
      <path d="M5 9h14M9 4v-1M15 4v-1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="9" cy="14" r="1.3" fill="currentColor" />
      <circle cx="15" cy="14" r="1.3" fill="currentColor" />
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

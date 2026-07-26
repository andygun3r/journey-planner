"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

/**
 * Moves keyboard/screen-reader focus to the main content's heading after a
 * client-side navigation, so SR users are told the new page loaded (SPA
 * navigations don't do this by default). Skips the very first render.
 */
export function FocusOnNavigate() {
  const pathname = usePathname();
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const main = document.getElementById("main");
    if (!main) return;
    const heading = main.querySelector<HTMLElement>("h1");
    const target = heading ?? main;
    // Make the target programmatically focusable without a persistent tabstop.
    if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: false });
  }, [pathname]);

  return null;
}

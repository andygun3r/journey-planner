"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Recent journey searches, persisted in localStorage (no server write per
 * search). Newest first, de-duplicated by from→to, capped at MAX.
 */

export interface RecentSearch {
  from: string;
  fromName: string;
  to: string;
  toName: string;
  at: number;
}

const KEY = "mainline:recents";
const MAX = 8;

function read(): RecentSearch[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RecentSearch[]) : [];
  } catch {
    return [];
  }
}

export function recordRecent(entry: Omit<RecentSearch, "at">): void {
  if (typeof window === "undefined") return;
  const existing = read().filter((r) => !(r.from === entry.from && r.to === entry.to));
  const next = [{ ...entry, at: Date.now() }, ...existing].slice(0, MAX);
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage full/blocked — recents are best-effort */
  }
}

export function useRecents(): {
  recents: RecentSearch[];
  remove: (from: string, to: string) => void;
} {
  const [recents, setRecents] = useState<RecentSearch[]>([]);

  useEffect(() => {
    setRecents(read());
  }, []);

  const remove = useCallback((from: string, to: string) => {
    const next = read().filter((r) => !(r.from === from && r.to === to));
    try {
      window.localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
    setRecents(next);
  }, []);

  return { recents, remove };
}

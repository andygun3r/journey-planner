"use client";

import { useRouter, useSearchParams } from "next/navigation";
import type { OtherCommute } from "@/lib/commute-dashboard";

interface Props {
  /** The commute currently shown. */
  activeId: string;
  activeLabel: string;
  otherCommutes: OtherCommute[];
}

/** Lets a user with more than one commute pick which one the dashboard shows. */
export function CommuteSwitcher({ activeId, activeLabel, otherCommutes }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();

  if (otherCommutes.length === 0) return null;

  function onChange(id: string) {
    const params = new URLSearchParams(searchParams);
    params.set("commute", id);
    // Switching commute drops any daily-flex shift from the previous one.
    params.delete("shift");
    router.push(`?${params.toString()}`);
  }

  return (
    <label className="commute-switcher">
      <span className="commute-switcher-label">Commute</span>
      <select value={activeId} onChange={(e) => onChange(e.target.value)} aria-label="Choose commute">
        <option value={activeId}>{activeLabel}</option>
        {otherCommutes.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </select>
    </label>
  );
}

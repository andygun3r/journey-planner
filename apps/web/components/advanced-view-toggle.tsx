"use client";

import { useState } from "react";
import { ServiceAdvancedView } from "./service-advanced-view";

/** "Show junction-by-junction detail" toggle for the service-detail position section. */
export function AdvancedViewToggle({ serviceId }: { serviceId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="advanced-view-toggle-wrap">
      <button
        type="button"
        className="advanced-view-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? "Hide junction-by-junction detail" : "Show junction-by-junction detail"}
        <span className="advanced-view-toggle-chevron" aria-hidden="true">
          {open ? "▲" : "▼"}
        </span>
      </button>
      {open && <ServiceAdvancedView serviceId={serviceId} />}
    </div>
  );
}

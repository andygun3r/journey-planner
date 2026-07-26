"use client";

import { useState } from "react";
import { ServiceAdvancedView } from "./service-advanced-view";

/** "Show junction-by-junction detail" toggle for the service-detail position section. */
export function AdvancedViewToggle({ serviceId, rid }: { serviceId: string; rid: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="advanced-view-toggle-wrap">
      <button type="button" className="map-panel-full advanced-view-toggle" onClick={() => setOpen((o) => !o)}>
        {open ? "Hide junction-by-junction detail" : "Show junction-by-junction detail →"}
      </button>
      {open && <ServiceAdvancedView serviceId={serviceId} rid={rid} />}
    </div>
  );
}

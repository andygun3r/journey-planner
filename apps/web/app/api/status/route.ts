import { NextResponse } from "next/server";
import {
  disruptionsConfigured,
  fetchNetworkDisruptions,
  RTPPM_TO_DISRUPTIONS_NAME,
  serviceIndicatorsByToc,
  type Disruption,
} from "@/lib/disruptions";
import { getPlannedEngineeringWorks } from "@/lib/kb-incidents";
import { getNetworkPunctuality, type OperatorPunctuality } from "@/lib/punctuality";
import { lineStatus, tflConfigured } from "@/lib/tfl";

export const dynamic = "force-dynamic";

const TFL_RAIL_MODES = ["tube", "overground", "elizabeth-line", "dlr"] as const;

function disruptionsFor(op: OperatorPunctuality, networkDisruptions: Disruption[]) {
  const name = RTPPM_TO_DISRUPTIONS_NAME[op.name] ?? op.name;
  return networkDisruptions.filter((d) => d.operators.includes(name));
}

export async function GET() {
  const [punctuality, tflLines, indicatorsByName, networkDisruptions, engineeringWorks] =
    await Promise.all([
      getNetworkPunctuality(),
      tflConfigured() ? lineStatus(TFL_RAIL_MODES) : Promise.resolve([]),
      disruptionsConfigured() ? serviceIndicatorsByToc().catch(() => new Map()) : Promise.resolve(new Map()),
      disruptionsConfigured()
        ? fetchNetworkDisruptions().catch(() => [] as Disruption[])
        : Promise.resolve([] as Disruption[]),
      getPlannedEngineeringWorks(),
    ]);

  return NextResponse.json(
    {
      updatedAt: punctuality.updatedAt,
      national: punctuality.national,
      operators: punctuality.operators.map((op) => {
        const disruptionName = RTPPM_TO_DISRUPTIONS_NAME[op.name] ?? op.name;
        const indicator = indicatorsByName.get(disruptionName);
        return {
          ...op,
          disruption: indicator && !indicator.good
            ? {
                status: indicator.status,
                statusDescription: indicator.statusDescription,
                disruptions: disruptionsFor(op, networkDisruptions).map((d) => ({
                  id: d.id,
                  summary: d.summary,
                  planned: d.planned,
                })),
              }
            : null,
        };
      }),
      vstpToday: punctuality.vstpToday,
      tflLines,
      engineeringWorks: engineeringWorks.slice(0, 12).map((work) => ({
        id: work.id,
        summary: work.summary,
        description: work.description,
        affectedOperators: work.affectedOperators,
        affectedRoutesText: work.affectedRoutesText,
        startsAt: work.startsAt?.toISOString() ?? null,
        endsAt: work.endsAt?.toISOString() ?? null,
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

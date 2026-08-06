import { ormSignal } from "@signaller/db";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

/**
 * Materialise physical signal positions from the self-hosted
 * OpenRailwayMap-vector PostGIS import into the app database.
 *
 * ORM is our best available "where is the signal post?" source. It is not live
 * signalling data and it will not contain every Network Rail signal, but when
 * a `ref` matches a TD/SOP signal item it gives a much better coordinate than
 * the SMART station/throat anchor.
 */

function normalizeSignalRef(value: string | null | undefined): string | null {
  const normalized = value?.replace(/[^A-Za-z0-9]/g, "").toUpperCase() ?? "";
  return normalized || null;
}

interface OrmSignalRow {
  osmId: string;
  ref: string | null;
  normalizedRef: string | null;
  caption: string | null;
  signalDirection: string | null;
  signalPosition: string | null;
  trackBearing: number | null;
  main: string | null;
  mainDesign: string | null;
  mainFunction: string | null;
  mainForm: string | null;
  mainStates: string | null;
  distant: string | null;
  distantForm: string | null;
  distantStates: string | null;
  combined: string | null;
  combinedForm: string | null;
  combinedStates: string | null;
  minor: string | null;
  minorForm: string | null;
  shunting: string | null;
  shuntingForm: string | null;
  mainRepeated: string | null;
  mainRepeatedForm: string | null;
  route: string | null;
  routeDesign: string | null;
  routeForm: string | null;
  routeStates: string | null;
  tags: Record<string, string> | null;
  lat: number;
  lon: number;
}

async function readOrmSignals(): Promise<OrmSignalRow[]> {
  const url = process.env.ORM_DATABASE_URL ?? "postgresql://postgres@orm-db:5432/gis";
  const ormClient = postgres(url);
  try {
    const rows = await ormClient<
      Array<{
        osm_id: string | number;
        ref: string | null;
        caption: string | null;
        signal_direction: string | null;
        signal_position: string | null;
        track_bearing: number | null;
        main: string | null;
        main_design: string | null;
        main_function: string | null;
        main_form: string | null;
        main_states: string | null;
        distant: string | null;
        distant_form: string | null;
        distant_states: string | null;
        combined: string | null;
        combined_form: string | null;
        combined_states: string | null;
        minor: string | null;
        minor_form: string | null;
        shunting: string | null;
        shunting_form: string | null;
        main_repeated: string | null;
        main_repeated_form: string | null;
        route: string | null;
        route_design: string | null;
        route_form: string | null;
        route_states: string | null;
        tags: Record<string, string> | null;
        lat: number;
        lon: number;
      }>
    >`
      select
        s.osm_id,
        s.ref,
        s.caption,
        s.signal_direction,
        s."railway:signal:position" as signal_position,
        case
          when nearest.way is null then null
          else degrees(ST_Azimuth(
            ST_LineInterpolatePoint(
              nearest.way,
              greatest(0, least(1, ST_LineLocatePoint(nearest.way, s.way) - 0.0001))
            ),
            ST_LineInterpolatePoint(
              nearest.way,
              greatest(0, least(1, ST_LineLocatePoint(nearest.way, s.way) + 0.0001))
            )
          ))
        end as track_bearing,
        s."railway:signal:main" as main,
        s."railway:signal:main:design" as main_design,
        s."railway:signal:main:function" as main_function,
        s."railway:signal:main:form" as main_form,
        s."railway:signal:main:states" as main_states,
        s."railway:signal:distant" as distant,
        s."railway:signal:distant:form" as distant_form,
        s."railway:signal:distant:states" as distant_states,
        s."railway:signal:combined" as combined,
        s."railway:signal:combined:form" as combined_form,
        s."railway:signal:combined:states" as combined_states,
        s."railway:signal:minor" as minor,
        s."railway:signal:minor:form" as minor_form,
        s."railway:signal:shunting" as shunting,
        s."railway:signal:shunting:form" as shunting_form,
        s."railway:signal:main_repeated" as main_repeated,
        s."railway:signal:main_repeated:form" as main_repeated_form,
        s."railway:signal:route" as route,
        s."railway:signal:route:design" as route_design,
        s."railway:signal:route:form" as route_form,
        s."railway:signal:route:states" as route_states,
        jsonb_strip_nulls(jsonb_build_object(
          'railway', s.railway,
          'ref', s.ref,
          'caption', s.caption,
          'railway:signal:direction', s.signal_direction,
          'railway:signal:position', s."railway:signal:position",
          'railway:signal:main', s."railway:signal:main",
          'railway:signal:main:design', s."railway:signal:main:design",
          'railway:signal:main:function', s."railway:signal:main:function",
          'railway:signal:main:form', s."railway:signal:main:form",
          'railway:signal:main:states', s."railway:signal:main:states",
          'railway:signal:distant', s."railway:signal:distant",
          'railway:signal:distant:form', s."railway:signal:distant:form",
          'railway:signal:distant:states', s."railway:signal:distant:states",
          'railway:signal:combined', s."railway:signal:combined",
          'railway:signal:combined:form', s."railway:signal:combined:form",
          'railway:signal:combined:states', s."railway:signal:combined:states",
          'railway:signal:minor', s."railway:signal:minor",
          'railway:signal:minor:form', s."railway:signal:minor:form",
          'railway:signal:shunting', s."railway:signal:shunting",
          'railway:signal:shunting:form', s."railway:signal:shunting:form",
          'railway:signal:main_repeated', s."railway:signal:main_repeated",
          'railway:signal:main_repeated:form', s."railway:signal:main_repeated:form",
          'railway:signal:route', s."railway:signal:route",
          'railway:signal:route:design', s."railway:signal:route:design",
          'railway:signal:route:form', s."railway:signal:route:form",
          'railway:signal:route:states', s."railway:signal:route:states"
        )) as tags,
        ST_Y(ST_Transform(s.way, 4326)) as lat,
        ST_X(ST_Transform(s.way, 4326)) as lon
      from signals s
      left join lateral (
        select l.way
        from railway_line l
        where l.way is not null and ST_DWithin(l.way, s.way, 25)
        order by l.way <-> s.way
        limit 1
      ) nearest on true
      where s.way is not null
    `;

    return rows.map((r) => ({
      osmId: String(r.osm_id),
      ref: r.ref,
      normalizedRef: normalizeSignalRef(r.ref ?? r.caption),
      caption: r.caption,
      signalDirection: r.signal_direction,
      signalPosition: r.signal_position,
      trackBearing: r.track_bearing === null ? null : Number(r.track_bearing),
      main: r.main,
      mainDesign: r.main_design,
      mainFunction: r.main_function,
      mainForm: r.main_form,
      mainStates: r.main_states,
      distant: r.distant,
      distantForm: r.distant_form,
      distantStates: r.distant_states,
      combined: r.combined,
      combinedForm: r.combined_form,
      combinedStates: r.combined_states,
      minor: r.minor,
      minorForm: r.minor_form,
      shunting: r.shunting,
      shuntingForm: r.shunting_form,
      mainRepeated: r.main_repeated,
      mainRepeatedForm: r.main_repeated_form,
      route: r.route,
      routeDesign: r.route_design,
      routeForm: r.route_form,
      routeStates: r.route_states,
      tags: r.tags,
      lat: Number(r.lat),
      lon: Number(r.lon),
    }));
  } finally {
    await ormClient.end();
  }
}

export async function importOrmSignals(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  const rows = await readOrmSignals();
  console.log(`[orm-signals] read ${rows.length} physical signal rows from orm-db`);

  const mainClient = postgres(url);
  const db = drizzle(mainClient);
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`truncate table ${ormSignal}`);
      const BATCH = 2000;
      for (let i = 0; i < rows.length; i += BATCH) {
        await tx.insert(ormSignal).values(rows.slice(i, i + BATCH));
      }
    });
    const withRef = rows.filter((r) => r.normalizedRef).length;
    console.log(`[orm-signals] wrote ${rows.length} orm_signal rows (${withRef} with a ref/caption)`);
  } finally {
    await mainClient.end();
  }
}

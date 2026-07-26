import {
  createDb,
  etlRun,
  fare,
  fareFlow,
  ndfOverride,
  routeName,
  stationCluster,
  ticketType,
} from "@mainline/db";
import mysql from "mysql2/promise";

/**
 * Loads the DTD RJFAF fares data that `dtd2mysql --fares` imported into the
 * MariaDB scratch DB (ETL_MYSQL_URL) into Postgres. Mirrors the timetable
 * loader's transaction + batch pattern (load-postgres.ts).
 *
 * dtd2mysql's RJFAF schema (the tables it creates):
 *   flow(flow_id, origin_code, destination_code, route_code, direction,
 *        start_date, end_date)
 *   fare(flow_id, ticket_code, fare, restriction_code)
 *   ticket_type(ticket_code, description, tkt_class, tkt_type, max_passengers,
 *        tkt_group/validity_code)
 *   station_cluster(cluster_id, cluster_nlc / member) — cluster membership
 *   non_derivable_fare(origin_code, destination_code, route_code, railcard_code,
 *        ticket_code, fare, start_date, end_date)
 *   route(route_code, description)
 *
 * Column names have drifted across dtd2mysql versions; queries below select
 * defensively and the loader logs a clear error if a table/column is missing,
 * so first-integration mismatches are easy to fix.
 */

const BATCH = 2000;

function isoDate(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

async function insertBatched<T>(
  rows: T[],
  insert: (chunk: T[]) => Promise<unknown>,
): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH) {
    await insert(rows.slice(i, i + BATCH));
  }
}

export async function loadFares(): Promise<void> {
  const mysqlUrl = process.env.ETL_MYSQL_URL ?? "mysql://root:etl@mariadb:3306/dtd";
  const conn = await mysql.createConnection(mysqlUrl);
  const db = createDb();

  try {
    const [flows] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT flow_id, origin_code, destination_code, route_code, direction,
              start_date, end_date FROM flow`,
    );
    const [fares] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT flow_id, ticket_code, fare, restriction_code FROM fare`,
    );
    const [ticketTypes] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT ticket_code, description, tkt_class, tkt_type, max_passengers FROM ticket_type`,
    );
    const [clusters] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT cluster_id, cluster_nlc FROM station_cluster`,
    );
    const [routes] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT route_code, description FROM route`,
    );
    // NDF table name varies; try the common one, tolerate absence.
    let ndfs: mysql.RowDataPacket[] = [];
    try {
      const [rows] = await conn.query<mysql.RowDataPacket[]>(
        `SELECT origin_code, destination_code, route_code, railcard_code, ticket_code,
                fare, start_date, end_date FROM non_derivable_fare`,
      );
      ndfs = rows;
    } catch {
      console.warn("[load-fares] non_derivable_fare table absent — skipping NDF overrides");
    }

    await db.transaction(async (tx) => {
      await tx.delete(fare);
      await tx.delete(fareFlow);
      await tx.delete(ticketType);
      await tx.delete(stationCluster);
      await tx.delete(ndfOverride);
      await tx.delete(routeName);

      await insertBatched(flows, (chunk) =>
        tx.insert(fareFlow).values(
          chunk.map((r) => ({
            flowId: String(r.flow_id),
            originNlc: String(r.origin_code),
            destNlc: String(r.destination_code),
            routeCode: String(r.route_code),
            direction: String(r.direction ?? "R"),
            startDate: isoDate(r.start_date),
            endDate: isoDate(r.end_date),
          })),
        ),
      );

      await insertBatched(fares, (chunk) =>
        tx.insert(fare).values(
          chunk.map((r) => ({
            flowId: String(r.flow_id),
            ticketCode: String(r.ticket_code),
            pricePence: Number(r.fare),
            restrictionCode: r.restriction_code ? String(r.restriction_code) : null,
          })),
        ),
      );

      await insertBatched(ticketTypes, (chunk) =>
        tx.insert(ticketType).values(
          chunk.map((r) => ({
            code: String(r.ticket_code),
            description: String(r.description ?? r.ticket_code),
            class: String(r.tkt_class ?? "2"),
            type: String(r.tkt_type ?? "S"),
            maxPassengers: r.max_passengers != null ? Number(r.max_passengers) : null,
          })),
        ),
      );

      await insertBatched(clusters, (chunk) =>
        tx
          .insert(stationCluster)
          .values(
            chunk.map((r) => ({
              clusterNlc: String(r.cluster_id),
              memberNlc: String(r.cluster_nlc),
            })),
          )
          .onConflictDoNothing(),
      );

      await insertBatched(routes, (chunk) =>
        tx
          .insert(routeName)
          .values(
            chunk.map((r) => ({
              routeCode: String(r.route_code),
              name: String(r.description ?? r.route_code),
            })),
          )
          .onConflictDoNothing(),
      );

      await insertBatched(ndfs, (chunk) =>
        tx
          .insert(ndfOverride)
          .values(
            chunk.map((r) => ({
              originNlc: String(r.origin_code),
              destNlc: String(r.destination_code),
              routeCode: String(r.route_code),
              railcard: String(r.railcard_code ?? ""),
              ticketCode: String(r.ticket_code),
              pricePence: Number(r.fare),
              startDate: isoDate(r.start_date),
              endDate: isoDate(r.end_date),
            })),
          )
          .onConflictDoNothing(),
      );

      await tx.insert(etlRun).values({
        feed: "fares",
        version: "RJFAF",
        ok: true,
        detail: `${flows.length} flows, ${fares.length} fares, ${ticketTypes.length} ticket types`,
      });
    });

    console.log(
      `[load-fares] loaded ${flows.length} flows, ${fares.length} fares, ` +
        `${ticketTypes.length} ticket types, ${clusters.length} cluster rows, ` +
        `${ndfs.length} NDF overrides into Postgres`,
    );
  } finally {
    await conn.end();
  }
}

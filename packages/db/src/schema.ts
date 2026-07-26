import {
  bigserial,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Reference data (loaded by the ETL from DTD .MSN / GTFS post-processing)
// ---------------------------------------------------------------------------

export const station = pgTable("station", {
  crs: text("crs").primaryKey(),
  name: text("name").notNull(),
  tiplocs: text("tiplocs").array().notNull().default([]),
  nlc: text("nlc"),
  lat: real("lat"),
  lon: real("lon"),
  /** Minimum interchange time in minutes, from .MSN. */
  interchangeMin: smallint("interchange_min").notNull().default(5),
});

/**
 * The Rosetta stone: joins GTFS trips (routing engine) to Darwin trains
 * (train_uid + scheduled start date). Emitted by the ETL post-processor.
 */
export const tripMapping = pgTable(
  "trip_mapping",
  {
    gtfsTripId: text("gtfs_trip_id").primaryKey(),
    trainUid: text("train_uid").notNull(),
    dateRunsFrom: date("date_runs_from").notNull(),
    dateRunsTo: date("date_runs_to").notNull(),
    /** Bit 0 = Monday ... bit 6 = Sunday. */
    daysMask: smallint("days_mask").notNull(),
    /** CIF STP indicator: P permanent, O overlay, N new, C cancel. */
    stpIndicator: text("stp_indicator").notNull(),
  },
  (t) => [index("trip_mapping_uid_idx").on(t.trainUid)],
);

export const etlRun = pgTable("etl_run", {
  id: uuid("id").primaryKey().defaultRandom(),
  feed: text("feed").notNull(), // timetable | fares | routeing
  version: text("version").notNull(), // e.g. RJTTF512
  importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
  ok: boolean("ok").notNull(),
  detail: text("detail"),
});

// ---------------------------------------------------------------------------
// Darwin real-time state (upserted by services/darwin-ingest)
// ---------------------------------------------------------------------------

export const darwinTrain = pgTable(
  "darwin_train",
  {
    rid: text("rid").primaryKey(),
    uid: text("uid").notNull(),
    /** Scheduled start date. */
    ssd: date("ssd").notNull(),
    toc: text("toc"),
    cancelled: boolean("cancelled").notNull().default(false),
    cancelReason: text("cancel_reason"),
    lateReason: text("late_reason"),
    deactivated: boolean("deactivated").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("darwin_train_uid_ssd_idx").on(t.uid, t.ssd)],
);

/**
 * Keyed by (rid, tiploc), NOT (rid, seq): Darwin's TS messages carry only a
 * shifting subset of a train's stops (the ones near its current position),
 * so an index into any single TS message's location list is not a stable
 * seq — two different TS messages can legitimately place unrelated stops at
 * seq 0. `seq` here is instead assigned once, from the SC (schedule)
 * message's full ordered calling pattern (applySchedule), and TS updates
 * patch the existing row for that tiploc rather than inventing a new seq.
 */
export const darwinStopForecast = pgTable(
  "darwin_stop_forecast",
  {
    rid: text("rid").notNull(),
    seq: smallint("seq").notNull(),
    tiploc: text("tiploc").notNull(),
    crs: text("crs"),
    // Times are HH:MM[:SS] strings in UK local time, as Darwin supplies them.
    schedArr: text("sched_arr"),
    schedDep: text("sched_dep"),
    schedPass: text("sched_pass"),
    estArr: text("est_arr"),
    estDep: text("est_dep"),
    actArr: text("act_arr"),
    actDep: text("act_dep"),
    platform: text("platform"),
    platformChanged: boolean("platform_changed").notNull().default(false),
    suppressed: boolean("suppressed").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.rid, t.tiploc] }),
    index("darwin_stop_crs_idx").on(t.crs),
    index("darwin_stop_seq_idx").on(t.rid, t.seq),
  ],
);

export const darwinStationMessage = pgTable("darwin_station_message", {
  id: integer("id").primaryKey(),
  category: text("category"),
  severity: text("severity"),
  html: text("html").notNull(),
  crsList: text("crs_list").array().notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Coach formation per train run, assembled from Darwin scheduleFormations
 * (the coach layout) + formationLoading (live per-coach loading %). Fills the
 * gaps where LDBWS doesn't return formation for a service.
 * `coaches` is [{ number, coachClass, first, loading? }] as JSONB.
 */
export const darwinFormation = pgTable("darwin_formation", {
  rid: text("rid").primaryKey(),
  fid: text("fid"),
  coaches: jsonb("coaches").notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Network Rail Open Data (TRUST Movements + Train Describer, via services/nr-ingest)
// ---------------------------------------------------------------------------

/**
 * CORPUS reference: maps STANOX <-> TIPLOC <-> CRS <-> NLC. Loaded from the
 * Network Rail CORPUS reference feed; lets us translate movement/berth reports
 * (STANOX-keyed) to the CRS/TIPLOC world the rest of Mainline uses.
 */
export const nrCorpus = pgTable(
  "nr_corpus",
  {
    stanox: text("stanox").primaryKey(),
    tiploc: text("tiploc"),
    crs: text("crs"),
    nlc: text("nlc"),
    description: text("description"),
  },
  (t) => [index("nr_corpus_tiploc_idx").on(t.tiploc), index("nr_corpus_crs_idx").on(t.crs)],
);

/**
 * SMART reference: maps Train Describer berth steps to STANOX + event type.
 * Loaded from the Network Rail SMART reference feed. Turns "berth A stepped to
 * berth B in TD area XY" into "train passed <location>".
 */
export const nrSmart = pgTable(
  "nr_smart",
  {
    // Composite identity of a berth step.
    tdArea: text("td_area").notNull(),
    fromBerth: text("from_berth"),
    toBerth: text("to_berth"),
    stanox: text("stanox"),
    /** ARRIVE / DEPART / INTERPOSE etc. */
    eventType: text("event_type"),
    /** Platform, where SMART records it. */
    platform: text("platform"),
    berthOffset: text("berth_offset"),
  },
  (t) => [
    primaryKey({ columns: [t.tdArea, t.fromBerth, t.toBerth] }),
    index("nr_smart_stanox_idx").on(t.stanox),
  ],
);

/**
 * Raw S-class signalling state from the TD feed. Each SF_MSG sets one address
 * (a byte) within a TD area to a value; individual bits within that byte are
 * signalling elements (signals, points, track circuits). We store the latest
 * byte per (area, address); decoding to specific signals/aspects happens via
 * sop_mapping. This is undecoded ground truth — last-writer-wins per address.
 */
export const nrSignallingState = pgTable(
  "nr_signalling_state",
  {
    tdArea: text("td_area").notNull(),
    /** Hex address within the area (e.g. "0B"). */
    address: text("address").notNull(),
    /** Current hex byte value at that address (e.g. "fa"). */
    data: text("data").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tdArea, t.address] })],
);

/**
 * SOP / ECS bit-map reference: which signalling item each (area, address, bit)
 * represents. Sourced per TD area from Open Rail Data SOP tables / ECS specs
 * (not all areas are published — unmapped bits render as "unknown"). Joining
 * nr_signalling_state × sop_mapping yields live per-signal aspects.
 */
export const sopMapping = pgTable(
  "sop_mapping",
  {
    tdArea: text("td_area").notNull(),
    address: text("address").notNull(),
    /** Bit index 0-7 within the byte. */
    bit: smallint("bit").notNull(),
    /** signal | point | track | route. */
    itemType: text("item_type").notNull(),
    /** Signal number / points id / track-circuit id. */
    itemId: text("item_id"),
    /** For signal-aspect bits: what a set bit means (e.g. "red", "off"). */
    aspect: text("aspect"),
    description: text("description"),
  },
  (t) => [
    primaryKey({ columns: [t.tdArea, t.address, t.bit] }),
    index("sop_item_idx").on(t.tdArea, t.itemId),
  ],
);

/**
 * Latest known live position per train, assembled from TRUST movement reports
 * and TD berth steps. Keyed by TRUST train_id (Network Rail's own id); we link
 * it to Darwin rid via headcode + origin where possible.
 */
export const nrTrainPosition = pgTable(
  "nr_train_position",
  {
    trainId: text("train_id").primaryKey(),
    /** 4-char headcode / train reporting number (train describer id). */
    headcode: text("headcode"),
    /** Darwin rid once we've correlated the two (may be null). */
    rid: text("rid"),
    /** STANOX / location of the most recent report. */
    lastStanox: text("last_stanox"),
    lastTiploc: text("last_tiploc"),
    lastCrs: text("last_crs"),
    /** ARRIVAL or DEPARTURE (movement) or PASS (berth). */
    lastEventType: text("last_event_type"),
    /** Actual timestamp of the last report (ms since epoch as text). */
    lastReportedAt: timestamp("last_reported_at", { withTimezone: true }),
    /** Current TD berth + area (finer than STANOX). */
    tdArea: text("td_area"),
    berth: text("berth"),
    /** Seconds late at the last movement report. */
    lateness: integer("lateness"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("nr_pos_headcode_idx").on(t.headcode),
    index("nr_pos_rid_idx").on(t.rid),
    // The live map scans for recently-reported trains.
    index("nr_pos_reported_idx").on(t.lastReportedAt),
  ],
);

/**
 * uid -> headcode, from Network Rail's SCHEDULE feed (JsonScheduleV1.CIF_train_uid
 * + schedule_segment.signalling_id). Darwin's TS/activation messages carry a
 * uid (darwin_train.uid); the live TD feed broadcasts a headcode, not a uid —
 * this is the only stable link between the two, resolving service-progress
 * ambiguity without needing "exactly one nearby TD headcode" guesswork (see
 * enrichWithNrProgress in apps/web/lib/service-progress.ts).
 * Replaced wholesale on each SCHEDULE load, same as nr_corpus/nr_smart — a
 * uid can have several schedule variants (STP indicators) but its reporting
 * headcode is effectively constant, so last-write-wins during the load.
 */
export const nrHeadcode = pgTable("nr_headcode", {
  uid: text("uid").primaryKey(),
  headcode: text("headcode").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Append-only log of every position report (TRUST movement or TD berth step),
 * mirroring nr_train_position's current-state row at the moment it was written.
 * Same trainId identity space (TRUST numeric id or "TD:{headcode}"), unified
 * across both feeds. Powers the service-detail "advanced view" — a timestamped
 * list of junctions/berths actually passed, joined against nr_smart/nr_corpus
 * for names and darwin_stop_forecast for scheduled-vs-actual comparison.
 * No FK to nr_train_position: TRUST train ids can be reused across service
 * days, so history must survive independently of the live row's lifecycle.
 * Pruned by services/nr-ingest on a retention window (see NR_POSITION_HISTORY_RETENTION_DAYS).
 */
export const nrTrainPositionHistory = pgTable(
  "nr_train_position_history",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    trainId: text("train_id").notNull(),
    headcode: text("headcode"),
    rid: text("rid"),
    lastStanox: text("last_stanox"),
    lastTiploc: text("last_tiploc"),
    lastCrs: text("last_crs"),
    lastEventType: text("last_event_type"),
    /** The feed's own event time (TD already UTC; TRUST corrected via trustTsToUtcMs). */
    reportedAt: timestamp("reported_at", { withTimezone: true }).notNull(),
    tdArea: text("td_area"),
    berth: text("berth"),
    lateness: integer("lateness"),
    /** Ingest write time — used for pruning, independent of feed-reported time. */
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("nr_pos_hist_train_time_idx").on(t.trainId, t.reportedAt),
    index("nr_pos_hist_rid_time_idx").on(t.rid, t.reportedAt),
    index("nr_pos_hist_recorded_idx").on(t.recordedAt),
  ],
);

/**
 * VSTP (Very Short Term Planning) schedules: trains planned too late for the
 * CIF timetable (charters, engineering diversions, short-notice extras). Kept
 * so board/journey lookups can recognise trains the static GTFS knows nothing
 * about. `schedule` holds the full parsed location list as JSONB.
 */
export const nrVstpSchedule = pgTable(
  "nr_vstp_schedule",
  {
    /** `${trainUid}|${startDate}|${stpIndicator}` — VSTP's natural identity. */
    id: text("id").primaryKey(),
    trainUid: text("train_uid").notNull(),
    startDate: date("start_date"),
    endDate: date("end_date"),
    stpIndicator: text("stp_indicator"),
    /** Create | Update | Delete. */
    transactionType: text("transaction_type"),
    headcode: text("headcode"),
    originTiploc: text("origin_tiploc"),
    destTiploc: text("dest_tiploc"),
    schedule: jsonb("schedule").notNull().default([]),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("nr_vstp_uid_idx").on(t.trainUid)],
);

/**
 * Temporary Speed Restrictions, from the TSR feed (weekly batches per route
 * group). Locations are STANOX — translate via nr_corpus for display.
 */
export const nrTsr = pgTable(
  "nr_tsr",
  {
    tsrId: text("tsr_id").primaryKey(),
    routeGroup: text("route_group"),
    routeCode: text("route_code"),
    fromStanox: text("from_stanox"),
    toStanox: text("to_stanox"),
    lineName: text("line_name"),
    direction: text("direction"),
    passengerSpeedMph: integer("passenger_speed_mph"),
    freightSpeedMph: integer("freight_speed_mph"),
    validFrom: timestamp("valid_from", { withTimezone: true }),
    validTo: timestamp("valid_to", { withTimezone: true }),
    reason: text("reason"),
    raw: jsonb("raw"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("nr_tsr_route_idx").on(t.routeGroup)],
);

/**
 * Real Time Public Performance Measure: per-operator punctuality, refreshed
 * every minute by the RTPPM feed. Row "NATIONAL" carries the network-wide
 * figure. `operatorCode` is Network Rail's numeric TOC id; match to Darwin
 * operators by name.
 */
export const nrRtppm = pgTable("nr_rtppm", {
  operatorCode: text("operator_code").primaryKey(),
  operatorName: text("operator_name"),
  total: integer("total"),
  onTime: integer("on_time"),
  late: integer("late"),
  cancelVeryLate: integer("cancel_very_late"),
  /** Today-so-far PPM percentage (0-100). */
  ppm: real("ppm"),
  /** Rolling last-hour PPM percentage. */
  rollingPpm: real("rolling_ppm"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const kbIncident = pgTable("kb_incident", {
  id: text("id").primaryKey(),
  summary: text("summary").notNull(),
  description: text("description"),
  category: text("category"),
  severity: text("severity"),
  affectedOperators: text("affected_operators").array().notNull().default([]),
  affectedRoutesText: text("affected_routes_text"),
  startsAt: timestamp("starts_at", { withTimezone: true }),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  lastUpdated: timestamp("last_updated", { withTimezone: true }),
  cleared: boolean("cleared").notNull().default(false),
});

// ---------------------------------------------------------------------------
// Fares (loaded from DTD RJFAF)
// ---------------------------------------------------------------------------

export const fareFlow = pgTable(
  "fare_flow",
  {
    flowId: text("flow_id").primaryKey(),
    originNlc: text("origin_nlc").notNull(),
    destNlc: text("dest_nlc").notNull(),
    routeCode: text("route_code").notNull(),
    /** R = reversible (valid in both directions). */
    direction: text("direction").notNull(),
    startDate: date("start_date"),
    endDate: date("end_date"),
  },
  (t) => [index("fare_flow_od_idx").on(t.originNlc, t.destNlc)],
);

export const fare = pgTable(
  "fare",
  {
    flowId: text("flow_id").notNull(),
    ticketCode: text("ticket_code").notNull(),
    pricePence: integer("price_pence").notNull(),
    restrictionCode: text("restriction_code"),
  },
  (t) => [primaryKey({ columns: [t.flowId, t.ticketCode] })],
);

export const ticketType = pgTable("ticket_type", {
  code: text("code").primaryKey(),
  description: text("description").notNull(),
  /** 1 = first, 2 = standard, 9 = undefined. */
  class: text("class").notNull(),
  /** S single, R return, N season, ... (DTD tkt_type). */
  type: text("type").notNull(),
  maxPassengers: smallint("max_passengers"),
  validity: text("validity"),
});

export const stationCluster = pgTable(
  "station_cluster",
  {
    clusterNlc: text("cluster_nlc").notNull(),
    memberNlc: text("member_nlc").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.clusterNlc, t.memberNlc] }),
    index("station_cluster_member_idx").on(t.memberNlc),
  ],
);

/** Non-derivable fares: explicit overrides that beat computed flow fares. */
export const ndfOverride = pgTable(
  "ndf_override",
  {
    originNlc: text("origin_nlc").notNull(),
    destNlc: text("dest_nlc").notNull(),
    routeCode: text("route_code").notNull(),
    railcard: text("railcard").notNull().default(""),
    ticketCode: text("ticket_code").notNull(),
    pricePence: integer("price_pence").notNull(),
    startDate: date("start_date"),
    endDate: date("end_date"),
  },
  (t) => [
    primaryKey({
      columns: [t.originNlc, t.destNlc, t.routeCode, t.railcard, t.ticketCode],
    }),
  ],
);

export const routeName = pgTable("route_name", {
  routeCode: text("route_code").primaryKey(),
  name: text("name").notNull(),
});

// ---------------------------------------------------------------------------
// Devices, commutes, alerts (no auth — device-id keyed)
// ---------------------------------------------------------------------------

export const device = pgTable("device", {
  id: uuid("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  /** Web Push subscription (v1.5); schema ready from day one. */
  pushSubscription: jsonb("push_subscription"),
});

export const commute = pgTable(
  "commute",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => device.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    /** Home location: the shared origin/destination across every day of this commute. */
    homeCrs: text("home_crs"),
    homeLabel: text("home_label"),
    // ---- LEGACY (pre per-day model) — kept for the additive 0002 migration, never
    // read or written by new code; the authoritative schedule lives in commute_leg.
    // A later migration can drop these columns.
    originCrs: text("origin_crs").notNull(),
    destCrs: text("dest_crs").notNull(),
    /** Bit 0 = Monday ... bit 6 = Sunday. LEGACY. */
    daysMask: smallint("days_mask").notNull(),
    windowStart: time("window_start").notNull(),
    windowEnd: time("window_end").notNull(),
    directionPairedCommuteId: uuid("direction_paired_commute_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("commute_device_idx").on(t.deviceId)],
);

/**
 * Per-day-of-week schedule for a commute. One row per active weekday, carrying
 * that day's work location (home lives on the parent) and its AM (home→work) /
 * PM (work→home) departure windows. This is the authoritative schedule; it
 * supports different workplaces and hours on different days.
 */
export const commuteLeg = pgTable(
  "commute_leg",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    commuteId: uuid("commute_id")
      .notNull()
      .references(() => commute.id, { onDelete: "cascade" }),
    /** 0 = Monday ... 6 = Sunday (matches daysMask bit ordering in codes.ts). */
    dayOfWeek: smallint("day_of_week").notNull(),
    /** Work location for THIS day. */
    workCrs: text("work_crs").notNull(),
    workLabel: text("work_label").notNull(),
    /** AM = home→work departure window (nullable: a day can be PM-only). */
    amWindowStart: time("am_window_start"),
    amWindowEnd: time("am_window_end"),
    /** PM = work→home departure window (nullable: a day can be AM-only). */
    pmWindowStart: time("pm_window_start"),
    pmWindowEnd: time("pm_window_end"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("commute_leg_commute_dow_idx").on(t.commuteId, t.dayOfWeek)],
);

/**
 * Holiday / leave ranges, device-keyed so a single entry suppresses alerts for
 * every commute. Inclusive date range; a single day sets start = end.
 */
export const commuteHoliday = pgTable(
  "commute_holiday",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => device.id, { onDelete: "cascade" }),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    label: text("label"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("holiday_device_idx").on(t.deviceId, t.startDate)],
);

export const favouriteJourney = pgTable(
  "favourite_journey",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => device.id, { onDelete: "cascade" }),
    fromCrs: text("from_crs").notNull(),
    toCrs: text("to_crs").notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("favourite_device_idx").on(t.deviceId)],
);

/**
 * Nightly-precomputed set of trains serving each commute window, so the
 * Darwin ingester can match live events to commutes cheaply.
 */
export const commuteCorridor = pgTable(
  "commute_corridor",
  {
    commuteId: uuid("commute_id")
      .notNull()
      .references(() => commute.id, { onDelete: "cascade" }),
    /** The specific day this corridor was resolved for. */
    serviceDate: date("service_date").notNull(),
    /** 'am' (home→work) or 'pm' (work→home). */
    direction: text("direction").notNull(),
    trainUid: text("train_uid").notNull(),
    commuteLegId: uuid("commute_leg_id").references(() => commuteLeg.id, {
      onDelete: "cascade",
    }),
    /** Resolved leg endpoints for this direction (home/work depending on am/pm). */
    originCrs: text("origin_crs"),
    destCrs: text("dest_crs"),
    /** Scheduled origin departure HH:MM, for ordering and delay calc. */
    schedDep: text("sched_dep"),
    stationCrsList: text("station_crs_list").array().notNull().default([]),
    tocs: text("tocs").array().notNull().default([]),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.commuteId, t.serviceDate, t.direction, t.trainUid] }),
    index("corridor_uid_idx").on(t.trainUid),
  ],
);

export const alert = pgTable(
  "alert",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    commuteId: uuid("commute_id")
      .notNull()
      .references(() => commute.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // cancellation | delay | kb_incident
    /** rid for train events, kb incident id for incidents. */
    ref: text("ref").notNull(),
    /** Which leg/direction/date this alert relates to (for train events). */
    commuteLegId: uuid("commute_leg_id"),
    direction: text("direction"),
    serviceDate: date("service_date"),
    headline: text("headline").notNull(),
    detail: text("detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    seenAt: timestamp("seen_at", { withTimezone: true }),
  },
  (t) => [
    index("alert_commute_idx").on(t.commuteId, t.createdAt),
    // The streaming hook and the periodic sweep must not double-insert.
    uniqueIndex("alert_dedupe_idx").on(t.commuteId, t.ref, t.kind, t.serviceDate),
  ],
);

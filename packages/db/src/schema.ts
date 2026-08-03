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
  /**
   * Station coordinates snapped onto the nearest OpenRailwayMap running line.
   * The .MSN-derived lat/lon above is the station's entrance/centroid, which
   * sits a median ~12m (and up to a few hundred metres at large stations) to
   * one side of the actual track — enough that a train plotted there visibly
   * misses the rails on the map. Populated by services/etl's `snap-stations`
   * command against the orm-db PostGIS import; null where no track was found
   * within tolerance, in which case callers fall back to lat/lon.
   */
  trackLat: real("track_lat"),
  trackLon: real("track_lon"),
  /** Minimum interchange time in minutes, from .MSN. */
  interchangeMin: smallint("interchange_min").notNull().default(5),
});

/**
 * Physical signal positions from the self-hosted OpenRailwayMap import.
 *
 * This is the "where is the post on the ground?" layer, independent of whether
 * Network Rail TD/SOP can report a live aspect for it. Many older/semaphore or
 * mechanically-worked signals will never have a live digital aspect; they still
 * belong on the map as grey physical signals when ORM has them.
 */
export const ormSignal = pgTable(
  "orm_signal",
  {
    osmId: text("osm_id").primaryKey(),
    ref: text("ref"),
    normalizedRef: text("normalized_ref"),
    caption: text("caption"),
    signalDirection: text("signal_direction"),
    signalPosition: text("signal_position"),
    trackBearing: real("track_bearing"),
    main: text("main"),
    mainDesign: text("main_design"),
    mainFunction: text("main_function"),
    mainForm: text("main_form"),
    mainStates: text("main_states"),
    distant: text("distant"),
    distantForm: text("distant_form"),
    distantStates: text("distant_states"),
    combined: text("combined"),
    combinedForm: text("combined_form"),
    combinedStates: text("combined_states"),
    minor: text("minor"),
    minorForm: text("minor_form"),
    shunting: text("shunting"),
    shuntingForm: text("shunting_form"),
    mainRepeated: text("main_repeated"),
    mainRepeatedForm: text("main_repeated_form"),
    route: text("route"),
    routeDesign: text("route_design"),
    routeForm: text("route_form"),
    routeStates: text("route_states"),
    tags: jsonb("tags"),
    lat: real("lat").notNull(),
    lon: real("lon").notNull(),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("orm_signal_ref_idx").on(t.normalizedRef),
    index("orm_signal_lon_lat_idx").on(t.lon, t.lat),
  ],
);

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
  // Remote SFTP file mtime at download time. RDG's SFTP drop reuses static
  // filenames (e.g. timetable_full.zip) rather than versioned ones, so
  // "already imported" is decided by this mtime, not by `version`/filename.
  sourceModifiedAt: timestamp("source_modified_at", { withTimezone: true }),
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
    /**
     * The 4-char headcode, from the SC message's own `trainId` attribute.
     *
     * Darwin has always sent this and it was simply never read. It matters
     * because it makes headcode -> rid a DIRECT, live lookup: the alternative
     * (nr_headcode) is derived from a ~3.2GB CIF download, loaded by a manual
     * command with no cron, and was measured 4 days stale. Note this is the
     * working's headcode, NOT unique — several rids a day share one — so it
     * still needs the usual time/location disambiguation, it just supplies a
     * far fresher candidate set.
     */
    headcode: text("headcode"),
    toc: text("toc"),
    cancelled: boolean("cancelled").notNull().default(false),
    cancelReason: text("cancel_reason"),
    lateReason: text("late_reason"),
    deactivated: boolean("deactivated").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("darwin_train_uid_ssd_idx").on(t.uid, t.ssd),
    // Serves findRidForHeadcode's Darwin-native candidate lookup.
    index("darwin_train_headcode_ssd_idx").on(t.headcode, t.ssd),
    // The prune filters on ssd alone. The two composites above both lead with
    // another column, so neither can serve that range scan.
    index("darwin_train_ssd_idx").on(t.ssd),
  ],
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
    // The originating Darwin envelope's own `ts`, epoch ms — NOT when we wrote
    // the row. Guards applyTS's upsert against an out-of-order/replayed Kafka
    // message (e.g. after the consumer resumes post-outage, see CLAUDE.md)
    // clobbering a fresher actArr/actDep with a stale one.
    lastMsgTs: timestamp("last_msg_ts", { withTimezone: true }),
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
    // The nightly prune deletes on updated_at, which is a DIFFERENT column to
    // last_reported_at above. Without this it scanned the whole table.
    index("nr_pos_updated_idx").on(t.updatedAt),
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
export const nrHeadcode = pgTable(
  "nr_headcode",
  {
    uid: text("uid").primaryKey(),
    headcode: text("headcode").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The PK is `uid`, but the hot path queries the OTHER direction:
    // findRidForHeadcode looks up candidate uids BY headcode on every
    // correlation attempt. Without this that was a parallel seq scan of all
    // ~310k rows at ~7ms a time — measured 441,322 scans reading 69 BILLION
    // rows, i.e. 99% of all rows read in the entire database, and roughly 51
    // minutes of wasted DB time.
    index("nr_headcode_headcode_idx").on(t.headcode),
  ],
);

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
    // The service-detail history view falls back to a headcode lookup when it
    // has no train id. Without this it scanned the largest table in the system.
    index("nr_pos_hist_headcode_time_idx").on(t.headcode, t.reportedAt),
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
// Commutes, alerts — owned by a signed-in user (see `user` table below).
//
// This used to be keyed by an anonymous `device` id (a cookie, no login).
// That's gone: everything that saves personal data now requires a Better
// Auth account. Rows created under the old device system are orphaned — a
// future cleanup could delete `commute`/`commute_holiday`/`favourite_journey`
// rows whose user_id no longer resolves, but nothing does that automatically.
// ---------------------------------------------------------------------------

export const commute = pgTable(
  "commute",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
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
  (t) => [index("commute_user_idx").on(t.userId)],
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
 * Holiday / leave ranges, owned by a user so a single entry suppresses alerts
 * for every commute of theirs. Inclusive date range; a single day sets
 * start = end.
 */
export const commuteHoliday = pgTable(
  "commute_holiday",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    label: text("label"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("holiday_user_idx").on(t.userId, t.startDate)],
);

export const favouriteJourney = pgTable(
  "favourite_journey",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    fromCrs: text("from_crs").notNull(),
    toCrs: text("to_crs").notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("favourite_user_idx").on(t.userId)],
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
    // Leading train_uid alone forced a filter step on the alert path, which
    // looks up (train_uid, service_date) for every tracked train.
    index("corridor_uid_date_idx").on(t.trainUid, t.serviceDate),
    // The tracked-uid refresh scans by service_date every 5 minutes.
    index("corridor_service_date_idx").on(t.serviceDate),
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

// ---------------------------------------------------------------------------
// TfL (write-through cache of StopPoint lookups; populated lazily, never
// hand-seeded — see apps/web/lib/tfl-stop-cache.ts)
// ---------------------------------------------------------------------------

export const tflStopPointCache = pgTable(
  "tfl_stop_point_cache",
  {
    naptanId: text("naptan_id").primaryKey(),
    commonName: text("common_name").notNull(),
    /** Set only when this StopPoint is also a National Rail interchange. */
    crs: text("crs"),
    lat: real("lat"),
    lon: real("lon"),
    modes: text("modes").array().notNull().default([]),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("tfl_stop_crs_idx").on(t.crs), index("tfl_stop_modes_idx").using("gin", t.modes)],
);

/**
 * Track-following geometry between two adjacent calling points, precomputed by
 * services/etl's `rail-corridors` command from the orm-db OpenRailwayMap import.
 *
 * Why materialise it: drawing a route as straight chords between calling points
 * cuts visibly across country, but resolving a real path needs a shortest-path
 * search over ~118k OSM way segments — far too slow for the request path, and
 * orm-db exposes no host port to the web app anyway. The geometry only changes
 * when the OSM extract is re-imported, so it's computed once and read back as
 * plain coordinate pairs, exactly like station.track_lat/lon.
 *
 * Directional (`from_crs`/`to_crs` ordered): GB has one-way loops and divergent
 * up/down alignments, so A→B is not always B→A reversed.
 *
 * A missing row means "no path found" and is a normal outcome — parallel-line
 * ambiguity, an unmapped corridor, or the two stations simply not being rail-
 * connected. Callers fall back to the straight chord rather than drawing
 * nothing, so coverage gaps degrade gracefully.
 */
export const railCorridor = pgTable(
  "rail_corridor",
  {
    fromCrs: text("from_crs").notNull(),
    toCrs: text("to_crs").notNull(),
    /**
     * Ordered [lon, lat] pairs flattened into a single array
     * ([lon0, lat0, lon1, lat1, ...]) — a plain real[] avoids both a PostGIS
     * dependency in the main database and the per-row overhead of jsonb.
     */
    geometry: real("geometry").array().notNull(),
    /** Along-track length in metres; lets callers sanity-check a bad match. */
    lengthM: real("length_m"),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.fromCrs, t.toCrs] })],
);

/**
 * Where a station sits on Network Rail's Track Model: which ELR (Engineer's
 * Line Reference) and approximate mileage its snapped coordinate falls at,
 * plus the WGS84 point on the matched centreline itself.
 *
 * Why this exists: no STANOX/TIPLOC/CRS feed — official or community — joins
 * to ELR+mileage. Track Model itself has no STANOX either, only ELR+mileage+
 * shape. The only way to connect the two is geometric: snap each station's
 * already-known coordinate (station.track_lat/lon, falling back to lat/lon)
 * onto the nearest Track Model centreline, then read off that point's ELR +
 * interpolated mileage. Computed by services/etl's `track-model` command.
 *
 * This gives a station a real position "along the railway" for the first
 * time — used to re-rank the signalling diagram's berths by real mileage
 * instead of pure hop-count (see apps/web/lib/signalling-layout.ts), and to
 * place stations within the national signalling map's track network.
 *
 * A missing row means no Track Model centreline was found within tolerance —
 * a normal outcome for a bus-only interchange or a station whose track isn't
 * in this extract. Callers fall back to hop-order / no ELR anchor, the same
 * "honest to the data" pattern rail_corridor and snap-stations already use.
 */
export const stationTrackModelPosition = pgTable("station_track_model_position", {
  crs: text("crs")
    .primaryKey()
    .references(() => station.crs),
  elr: text("elr").notNull(),
  /** Interpolated mileage along the ELR at the snap point (miles, e.g. 29.14). */
  mileage: real("mileage").notNull(),
  /** Track Model's own ASSET_ID for the matched centreline record. */
  assetId: text("asset_id").notNull(),
  /** The point actually used for matching, reprojected to WGS84 — may differ
   *  slightly from station.track_lat/lon since it's on the Track Model line,
   *  not the OSM line snap-stations used. */
  matchedLat: real("matched_lat").notNull(),
  matchedLon: real("matched_lon").notNull(),
  /** True ground distance (metres) from the station's input coordinate to
   *  the matched centreline — the QA/fallback signal, same role as
   *  MAX_SNAP_METERS in snap-stations.ts. */
  snapDistanceM: real("snap_distance_m").notNull(),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Track Model centrelines, reprojected once from British National Grid to
 * WGS84 at precompute time (services/etl's `track-model` command) so the web
 * app never carries BNG math at request time — the same "materialise once,
 * read back as plain coordinates" pattern as rail_corridor.
 *
 * This is the raw national track network geometry, independent of any
 * station/TD-area join — the base layer the /map signalling view draws
 * everywhere, before any live signal/berth detail is overlaid.
 */
export const trackModelLine = pgTable(
  "track_model_line",
  {
    assetId: text("asset_id").primaryKey(),
    elr: text("elr").notNull(),
    trackId: text("track_id"),
    startMileage: real("start_mileage"),
    endMileage: real("end_mileage"),
    /** Flattened [lon0, lat0, lon1, lat1, ...] WGS84 pairs, matching
     *  rail_corridor.geometry's convention. */
    geometry: real("geometry").array().notNull(),
  },
  (t) => [index("track_model_line_elr_idx").on(t.elr)],
);

// ---------------------------------------------------------------------------
// Auth (Better Auth) — signed-in users. Table shapes follow Better Auth's
// Drizzle adapter conventions exactly (see apps/web/lib/auth.ts) — column
// names/types here are what its core + magicLink + passkey + apiKey plugins
// expect, not a house style. `role` and `pushSubscription` are the two fields
// Mainline adds on top of that core shape.
// ---------------------------------------------------------------------------

/**
 * `role` is "user" (default, from public sign-up) or "admin" (gates the ETL
 * routes and /settings/timetable). Promote yourself after your first sign-up
 * with:
 *
 *   update "user" set role = 'admin' where email = 'you@example.com';
 *
 * `pushSubscription` is the signed-in user's Web Push subscription (v1.5).
 * This used to live on a separate anonymous `device` table; now that saving
 * data requires an account, it can just sit on the user directly.
 */
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  role: text("role").notNull().default("user"),
  pushSubscription: jsonb("push_subscription"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One row per sign-in method linked to a user. Magic link needs no row here (it's an email-only flow); this is ready for the account-linking Better Auth does internally. */
export const account = pgTable("account", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  idToken: text("id_token"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Short-lived tokens: magic link sign-in links live here (identifier = email). */
export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** WebAuthn credentials, one row per passkey a user has registered. */
export const passkey = pgTable("passkey", {
  id: text("id").primaryKey(),
  name: text("name"),
  publicKey: text("public_key").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  credentialID: text("credential_i_d").notNull(),
  counter: integer("counter").notNull(),
  deviceType: text("device_type").notNull(),
  backedUp: boolean("backed_up").notNull(),
  transports: text("transports"),
  createdAt: timestamp("created_at", { withTimezone: true }),
  aaguid: text("aaguid"),
});

/**
 * API keys for unattended callers — currently just the etl-cron nightly job
 * hitting the ETL routes with no human session (see checkEtlAuth). `referenceId`
 * is Better Auth's generic owner column; here it's always a user id.
 */
export const apikey = pgTable("apikey", {
  id: text("id").primaryKey(),
  configId: text("config_id").notNull().default("default"),
  name: text("name"),
  start: text("start"),
  prefix: text("prefix"),
  key: text("key").notNull(),
  /** Better Auth's generic owner column — always a user id here (no orgs). */
  referenceId: text("reference_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  refillInterval: integer("refill_interval"),
  refillAmount: integer("refill_amount"),
  lastRefillAt: timestamp("last_refill_at", { withTimezone: true }),
  enabled: boolean("enabled").notNull().default(true),
  rateLimitEnabled: boolean("rate_limit_enabled").notNull().default(true),
  rateLimitTimeWindow: integer("rate_limit_time_window"),
  rateLimitMax: integer("rate_limit_max"),
  requestCount: integer("request_count"),
  remaining: integer("remaining"),
  lastRequest: timestamp("last_request", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  permissions: text("permissions"),
  metadata: text("metadata"),
});

import { z } from "zod";

/**
 * Normalised Darwin Push Port message shapes (v17+ JSON as delivered on the
 * RDG Rail Data Marketplace Kafka feed). These model OUR normalised view after
 * parsing, not the raw wire envelope — the raw envelope shape is verified on
 * first integration and adapted in services/darwin-ingest/src/pushport.
 */

export const DarwinTime = z.object({
  /** Working timetable scheduled time, HH:MM[:SS]. */
  scheduled: z.string().optional(),
  /** Estimated time from forecast. */
  estimated: z.string().optional(),
  /** Actual reported time. */
  actual: z.string().optional(),
});
export type DarwinTime = z.infer<typeof DarwinTime>;

export const StopForecast = z.object({
  tiploc: z.string(),
  arrival: DarwinTime.optional(),
  departure: DarwinTime.optional(),
  pass: DarwinTime.optional(),
  platform: z.string().optional(),
  platformChanged: z.boolean().default(false),
  suppressed: z.boolean().default(false),
});
export type StopForecast = z.infer<typeof StopForecast>;

export const TrainStatusUpdate = z.object({
  kind: z.literal("TS"),
  rid: z.string(),
  uid: z.string(),
  /** Scheduled start date, YYYY-MM-DD. */
  ssd: z.string(),
  lateReason: z.string().optional(),
  stops: z.array(StopForecast),
});
export type TrainStatusUpdate = z.infer<typeof TrainStatusUpdate>;

export const ScheduleUpdate = z.object({
  kind: z.literal("schedule"),
  rid: z.string(),
  uid: z.string(),
  ssd: z.string(),
  toc: z.string().optional(),
  cancelled: z.boolean().default(false),
  cancelReason: z.string().optional(),
});
export type ScheduleUpdate = z.infer<typeof ScheduleUpdate>;

export const StationMessage = z.object({
  kind: z.literal("OW"),
  id: z.number(),
  category: z.string().optional(),
  severity: z.string().optional(),
  html: z.string(),
  crsList: z.array(z.string()),
});
export type StationMessage = z.infer<typeof StationMessage>;

export const Deactivation = z.object({
  kind: z.literal("deactivated"),
  rid: z.string(),
});
export type Deactivation = z.infer<typeof Deactivation>;

export const DarwinUpdate = z.discriminatedUnion("kind", [
  TrainStatusUpdate,
  ScheduleUpdate,
  StationMessage,
  Deactivation,
]);
export type DarwinUpdate = z.infer<typeof DarwinUpdate>;

import { z } from "zod";

export const JourneyStatus = z.enum([
  "on-time",
  "delayed",
  "disrupted",
  "cancelled",
]);
export type JourneyStatus = z.infer<typeof JourneyStatus>;

/** A point (station call) on a leg, with scheduled and live times. */
export const CallingPoint = z.object({
  crs: z.string(),
  name: z.string(),
  scheduled: z.iso.datetime({ offset: true }),
  /** Live estimate/actual from Darwin; absent when no forecast. */
  live: z.iso.datetime({ offset: true }).optional(),
  platform: z.string().optional(),
  platformChanged: z.boolean().optional(),
});
export type CallingPoint = z.infer<typeof CallingPoint>;

export const Leg = z.object({
  mode: z.enum(["rail", "walk"]),
  origin: CallingPoint,
  destination: CallingPoint,
  /** GTFS trip id from the routing engine; maps to Darwin via trip_mapping. */
  tripId: z.string().optional(),
  /** Darwin run id for today's realisation of this train, once resolved. */
  rid: z.string().optional(),
  trainUid: z.string().optional(),
  operator: z.string().optional(),
  headcode: z.string().optional(),
  cancelled: z.boolean().default(false),
  cancelReason: z.string().optional(),
  lateReason: z.string().optional(),
  /** Stay-seated portion of a splitting/joining train — shown as "no change". */
  staySeated: z.boolean().default(false),
  intermediateCalls: z.array(CallingPoint).default([]),
});
export type Leg = z.infer<typeof Leg>;

export const Fare = z.object({
  ticketCode: z.string(),
  description: z.string(),
  type: z.enum(["single", "return"]),
  pricePence: z.number().int().nonnegative(),
  routeCode: z.string(),
  routeName: z.string().optional(),
  /** True when summed per-leg rather than an end-to-end flow. */
  estimated: z.boolean().default(false),
});
export type Fare = z.infer<typeof Fare>;

export const Journey = z.object({
  id: z.string(),
  legs: z.array(Leg).min(1),
  departs: z.iso.datetime({ offset: true }),
  arrives: z.iso.datetime({ offset: true }),
  /** Live (Darwin-adjusted) times when they differ from scheduled. */
  liveDeparts: z.iso.datetime({ offset: true }).optional(),
  liveArrives: z.iso.datetime({ offset: true }).optional(),
  durationMinutes: z.number().int().positive(),
  changes: z.number().int().nonnegative(),
  status: JourneyStatus,
  delayMinutes: z.number().int().optional(),
  fares: z.array(Fare).default([]),
});
export type Journey = z.infer<typeof Journey>;

export const JourneyRequest = z.object({
  from: z.string().length(3),
  to: z.string().length(3),
  when: z.iso.datetime({ offset: true }).optional(),
  arriveBy: z.boolean().default(false),
  numItineraries: z.number().int().min(1).max(10).default(5),
});
export type JourneyRequest = z.infer<typeof JourneyRequest>;

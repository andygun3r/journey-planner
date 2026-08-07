ALTER TABLE "user" ADD COLUMN "push_commute_disruptions" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "push_pre_departure" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "push_network_disruptions" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Preserve existing behaviour: anyone who already has a push subscription
-- was, until now, getting commute-disruption pushes unconditionally. Keep
-- that working after this migration instead of silently going quiet; the
-- two new categories (pre-departure, network) stay opt-in for everyone.
UPDATE "user" SET "push_commute_disruptions" = true WHERE "push_subscription" IS NOT NULL;
-- Indexes for query paths that were scanning whole tables.
--
-- All CREATEs use IF NOT EXISTS on purpose. CREATE INDEX takes a lock that
-- blocks writes for as long as it runs, and nr_train_position_history is the
-- biggest, busiest table in the system — building an index on it inline can
-- stall ingest for minutes. On an existing database, build that one by hand
-- first and let this migration skip it:
--
--   CREATE INDEX CONCURRENTLY nr_pos_hist_headcode_time_idx
--     ON nr_train_position_history (headcode, reported_at);
--
-- CONCURRENTLY cannot run inside a transaction, which is why it is not written
-- that way here — the migrator wraps each migration in one.

DROP INDEX IF EXISTS "corridor_uid_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "corridor_uid_date_idx" ON "commute_corridor" USING btree ("train_uid","service_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "corridor_service_date_idx" ON "commute_corridor" USING btree ("service_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "darwin_train_ssd_idx" ON "darwin_train" USING btree ("ssd");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nr_pos_updated_idx" ON "nr_train_position" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nr_pos_hist_headcode_time_idx" ON "nr_train_position_history" USING btree ("headcode","reported_at");

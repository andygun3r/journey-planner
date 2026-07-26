DROP INDEX "darwin_stop_tiploc_idx";--> statement-breakpoint
ALTER TABLE "darwin_stop_forecast" DROP CONSTRAINT "darwin_stop_forecast_rid_seq_pk";--> statement-breakpoint
ALTER TABLE "darwin_stop_forecast" ADD CONSTRAINT "darwin_stop_forecast_rid_tiploc_pk" PRIMARY KEY("rid","tiploc");--> statement-breakpoint
CREATE INDEX "darwin_stop_seq_idx" ON "darwin_stop_forecast" USING btree ("rid","seq");
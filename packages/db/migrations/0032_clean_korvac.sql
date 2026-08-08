CREATE TABLE "commute_day_override" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"commute_id" uuid NOT NULL,
	"date" date NOT NULL,
	"skipped" boolean DEFAULT false NOT NULL,
	"work_crs" text,
	"work_label" text,
	"am_window_start" time,
	"am_window_end" time,
	"pm_window_start" time,
	"pm_window_end" time,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "commute_day_override" ADD CONSTRAINT "commute_day_override_commute_id_commute_id_fk" FOREIGN KEY ("commute_id") REFERENCES "public"."commute"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commute_day_override_unique_idx" ON "commute_day_override" USING btree ("commute_id","date");--> statement-breakpoint
CREATE INDEX "commute_day_override_date_idx" ON "commute_day_override" USING btree ("commute_id","date");
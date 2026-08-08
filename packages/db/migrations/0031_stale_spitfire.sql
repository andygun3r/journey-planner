CREATE TABLE "commute_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"commute_id" uuid NOT NULL,
	"commute_leg_id" uuid,
	"service_date" date NOT NULL,
	"direction" text NOT NULL,
	"origin_crs" text NOT NULL,
	"origin_label" text NOT NULL,
	"dest_crs" text NOT NULL,
	"dest_label" text NOT NULL,
	"journey" jsonb,
	"scheduled_arrival" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_reason" text
);
--> statement-breakpoint
ALTER TABLE "commute_run" ADD CONSTRAINT "commute_run_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commute_run" ADD CONSTRAINT "commute_run_commute_id_commute_id_fk" FOREIGN KEY ("commute_id") REFERENCES "public"."commute"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commute_run" ADD CONSTRAINT "commute_run_commute_leg_id_commute_leg_id_fk" FOREIGN KEY ("commute_leg_id") REFERENCES "public"."commute_leg"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commute_run_user_idx" ON "commute_run" USING btree ("user_id","service_date");--> statement-breakpoint
CREATE INDEX "commute_run_active_idx" ON "commute_run" USING btree ("commute_id","ended_at");--> statement-breakpoint
-- One active run per commute. Partial unique indexes can't be expressed in the
-- Drizzle schema, so this is hand-added: it's what stops a double-tap on
-- "Start commute" (or two devices at once) opening two competing runs.
CREATE UNIQUE INDEX "commute_run_one_active_idx" ON "commute_run" ("commute_id") WHERE "ended_at" IS NULL;
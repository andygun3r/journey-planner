CREATE TABLE "commute_leg_pin" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"commute_leg_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"sequence" smallint NOT NULL,
	"train_uid" text NOT NULL,
	"gtfs_trip_id" text,
	"origin_crs" text NOT NULL,
	"origin_label" text NOT NULL,
	"sched_dep" text NOT NULL,
	"dest_crs" text NOT NULL,
	"dest_label" text NOT NULL,
	"sched_arr" text NOT NULL,
	"toc" text,
	"picked_service_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "commute_leg_pin" ADD CONSTRAINT "commute_leg_pin_commute_leg_id_commute_leg_id_fk" FOREIGN KEY ("commute_leg_id") REFERENCES "public"."commute_leg"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commute_leg_pin_seq_idx" ON "commute_leg_pin" USING btree ("commute_leg_id","direction","sequence");--> statement-breakpoint
CREATE INDEX "commute_leg_pin_uid_idx" ON "commute_leg_pin" USING btree ("train_uid");
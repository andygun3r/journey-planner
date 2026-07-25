CREATE TABLE "nr_rtppm" (
	"operator_code" text PRIMARY KEY NOT NULL,
	"operator_name" text,
	"total" integer,
	"on_time" integer,
	"late" integer,
	"cancel_very_late" integer,
	"ppm" real,
	"rolling_ppm" real,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nr_tsr" (
	"tsr_id" text PRIMARY KEY NOT NULL,
	"route_group" text,
	"route_code" text,
	"from_stanox" text,
	"to_stanox" text,
	"line_name" text,
	"direction" text,
	"passenger_speed_mph" integer,
	"freight_speed_mph" integer,
	"valid_from" timestamp with time zone,
	"valid_to" timestamp with time zone,
	"reason" text,
	"raw" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nr_vstp_schedule" (
	"id" text PRIMARY KEY NOT NULL,
	"train_uid" text NOT NULL,
	"start_date" date,
	"end_date" date,
	"stp_indicator" text,
	"transaction_type" text,
	"headcode" text,
	"origin_tiploc" text,
	"dest_tiploc" text,
	"schedule" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "nr_tsr_route_idx" ON "nr_tsr" USING btree ("route_group");--> statement-breakpoint
CREATE INDEX "nr_vstp_uid_idx" ON "nr_vstp_schedule" USING btree ("train_uid");--> statement-breakpoint
CREATE INDEX "nr_pos_reported_idx" ON "nr_train_position" USING btree ("last_reported_at");
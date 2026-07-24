CREATE TABLE "alert" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"commute_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"headline" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "commute" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"label" text NOT NULL,
	"origin_crs" text NOT NULL,
	"dest_crs" text NOT NULL,
	"days_mask" smallint NOT NULL,
	"window_start" time NOT NULL,
	"window_end" time NOT NULL,
	"direction_paired_commute_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commute_corridor" (
	"commute_id" uuid NOT NULL,
	"train_uid" text NOT NULL,
	"station_crs_list" text[] DEFAULT '{}' NOT NULL,
	"tocs" text[] DEFAULT '{}' NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commute_corridor_commute_id_train_uid_pk" PRIMARY KEY("commute_id","train_uid")
);
--> statement-breakpoint
CREATE TABLE "darwin_station_message" (
	"id" integer PRIMARY KEY NOT NULL,
	"category" text,
	"severity" text,
	"html" text NOT NULL,
	"crs_list" text[] DEFAULT '{}' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "darwin_stop_forecast" (
	"rid" text NOT NULL,
	"seq" smallint NOT NULL,
	"tiploc" text NOT NULL,
	"crs" text,
	"sched_arr" text,
	"sched_dep" text,
	"sched_pass" text,
	"est_arr" text,
	"est_dep" text,
	"act_arr" text,
	"act_dep" text,
	"platform" text,
	"platform_changed" boolean DEFAULT false NOT NULL,
	"suppressed" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "darwin_stop_forecast_rid_seq_pk" PRIMARY KEY("rid","seq")
);
--> statement-breakpoint
CREATE TABLE "darwin_train" (
	"rid" text PRIMARY KEY NOT NULL,
	"uid" text NOT NULL,
	"ssd" date NOT NULL,
	"toc" text,
	"cancelled" boolean DEFAULT false NOT NULL,
	"cancel_reason" text,
	"late_reason" text,
	"deactivated" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"push_subscription" jsonb
);
--> statement-breakpoint
CREATE TABLE "etl_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"feed" text NOT NULL,
	"version" text NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ok" boolean NOT NULL,
	"detail" text
);
--> statement-breakpoint
CREATE TABLE "fare" (
	"flow_id" text NOT NULL,
	"ticket_code" text NOT NULL,
	"price_pence" integer NOT NULL,
	"restriction_code" text,
	CONSTRAINT "fare_flow_id_ticket_code_pk" PRIMARY KEY("flow_id","ticket_code")
);
--> statement-breakpoint
CREATE TABLE "fare_flow" (
	"flow_id" text PRIMARY KEY NOT NULL,
	"origin_nlc" text NOT NULL,
	"dest_nlc" text NOT NULL,
	"route_code" text NOT NULL,
	"direction" text NOT NULL,
	"start_date" date,
	"end_date" date
);
--> statement-breakpoint
CREATE TABLE "favourite_journey" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"from_crs" text NOT NULL,
	"to_crs" text NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "kb_incident" (
	"id" text PRIMARY KEY NOT NULL,
	"summary" text NOT NULL,
	"description" text,
	"category" text,
	"severity" text,
	"affected_operators" text[] DEFAULT '{}' NOT NULL,
	"affected_routes_text" text,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"last_updated" timestamp with time zone,
	"cleared" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ndf_override" (
	"origin_nlc" text NOT NULL,
	"dest_nlc" text NOT NULL,
	"route_code" text NOT NULL,
	"railcard" text DEFAULT '' NOT NULL,
	"ticket_code" text NOT NULL,
	"price_pence" integer NOT NULL,
	"start_date" date,
	"end_date" date,
	CONSTRAINT "ndf_override_origin_nlc_dest_nlc_route_code_railcard_ticket_code_pk" PRIMARY KEY("origin_nlc","dest_nlc","route_code","railcard","ticket_code")
);
--> statement-breakpoint
CREATE TABLE "route_name" (
	"route_code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "station" (
	"crs" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"tiplocs" text[] DEFAULT '{}' NOT NULL,
	"nlc" text,
	"lat" real,
	"lon" real,
	"interchange_min" smallint DEFAULT 5 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "station_cluster" (
	"cluster_nlc" text NOT NULL,
	"member_nlc" text NOT NULL,
	CONSTRAINT "station_cluster_cluster_nlc_member_nlc_pk" PRIMARY KEY("cluster_nlc","member_nlc")
);
--> statement-breakpoint
CREATE TABLE "ticket_type" (
	"code" text PRIMARY KEY NOT NULL,
	"description" text NOT NULL,
	"class" text NOT NULL,
	"type" text NOT NULL,
	"max_passengers" smallint,
	"validity" text
);
--> statement-breakpoint
CREATE TABLE "trip_mapping" (
	"gtfs_trip_id" text PRIMARY KEY NOT NULL,
	"train_uid" text NOT NULL,
	"date_runs_from" date NOT NULL,
	"date_runs_to" date NOT NULL,
	"days_mask" smallint NOT NULL,
	"stp_indicator" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alert" ADD CONSTRAINT "alert_commute_id_commute_id_fk" FOREIGN KEY ("commute_id") REFERENCES "public"."commute"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commute" ADD CONSTRAINT "commute_device_id_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."device"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commute_corridor" ADD CONSTRAINT "commute_corridor_commute_id_commute_id_fk" FOREIGN KEY ("commute_id") REFERENCES "public"."commute"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "favourite_journey" ADD CONSTRAINT "favourite_journey_device_id_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."device"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_commute_idx" ON "alert" USING btree ("commute_id","created_at");--> statement-breakpoint
CREATE INDEX "commute_device_idx" ON "commute" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "corridor_uid_idx" ON "commute_corridor" USING btree ("train_uid");--> statement-breakpoint
CREATE INDEX "darwin_stop_crs_idx" ON "darwin_stop_forecast" USING btree ("crs");--> statement-breakpoint
CREATE INDEX "darwin_stop_tiploc_idx" ON "darwin_stop_forecast" USING btree ("tiploc");--> statement-breakpoint
CREATE INDEX "darwin_train_uid_ssd_idx" ON "darwin_train" USING btree ("uid","ssd");--> statement-breakpoint
CREATE INDEX "fare_flow_od_idx" ON "fare_flow" USING btree ("origin_nlc","dest_nlc");--> statement-breakpoint
CREATE INDEX "favourite_device_idx" ON "favourite_journey" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "station_cluster_member_idx" ON "station_cluster" USING btree ("member_nlc");--> statement-breakpoint
CREATE INDEX "trip_mapping_uid_idx" ON "trip_mapping" USING btree ("train_uid");
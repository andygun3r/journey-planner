CREATE TABLE "commute_holiday" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commute_leg" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"commute_id" uuid NOT NULL,
	"day_of_week" smallint NOT NULL,
	"work_crs" text NOT NULL,
	"work_label" text NOT NULL,
	"am_window_start" time,
	"am_window_end" time,
	"pm_window_start" time,
	"pm_window_end" time,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alert" ADD COLUMN "commute_leg_id" uuid;--> statement-breakpoint
ALTER TABLE "alert" ADD COLUMN "direction" text;--> statement-breakpoint
ALTER TABLE "alert" ADD COLUMN "service_date" date;--> statement-breakpoint
ALTER TABLE "commute" ADD COLUMN "home_crs" text;--> statement-breakpoint
ALTER TABLE "commute" ADD COLUMN "home_label" text;--> statement-breakpoint
ALTER TABLE "commute_corridor" ADD COLUMN "service_date" date NOT NULL;--> statement-breakpoint
ALTER TABLE "commute_corridor" ADD COLUMN "direction" text NOT NULL;--> statement-breakpoint
ALTER TABLE "commute_corridor" ADD COLUMN "commute_leg_id" uuid;--> statement-breakpoint
ALTER TABLE "commute_corridor" ADD COLUMN "origin_crs" text;--> statement-breakpoint
ALTER TABLE "commute_corridor" ADD COLUMN "dest_crs" text;--> statement-breakpoint
ALTER TABLE "commute_corridor" ADD COLUMN "sched_dep" text;--> statement-breakpoint
ALTER TABLE "commute_corridor" DROP CONSTRAINT "commute_corridor_commute_id_train_uid_pk";--> statement-breakpoint
ALTER TABLE "commute_corridor" ADD CONSTRAINT "commute_corridor_commute_id_service_date_direction_train_uid_pk" PRIMARY KEY("commute_id","service_date","direction","train_uid");--> statement-breakpoint
ALTER TABLE "commute_holiday" ADD CONSTRAINT "commute_holiday_device_id_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."device"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commute_leg" ADD CONSTRAINT "commute_leg_commute_id_commute_id_fk" FOREIGN KEY ("commute_id") REFERENCES "public"."commute"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "holiday_device_idx" ON "commute_holiday" USING btree ("device_id","start_date");--> statement-breakpoint
CREATE UNIQUE INDEX "commute_leg_commute_dow_idx" ON "commute_leg" USING btree ("commute_id","day_of_week");--> statement-breakpoint
ALTER TABLE "commute_corridor" ADD CONSTRAINT "commute_corridor_commute_leg_id_commute_leg_id_fk" FOREIGN KEY ("commute_leg_id") REFERENCES "public"."commute_leg"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alert_dedupe_idx" ON "alert" USING btree ("commute_id","ref","kind","service_date");

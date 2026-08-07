CREATE TABLE "station_facility" (
	"crs" text PRIMARY KEY NOT NULL,
	"step_free_access" boolean,
	"step_free_description" text,
	"ticket_office_hours" text,
	"has_car_park" boolean,
	"car_park_spaces" integer,
	"has_toilets" boolean,
	"has_lifts" boolean,
	"has_waiting_room" boolean,
	"has_wifi" boolean,
	"assistance_available" boolean,
	"assistance_description" text,
	"raw" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kb_incident" ADD COLUMN "raw" jsonb;--> statement-breakpoint
ALTER TABLE "station_facility" ADD CONSTRAINT "station_facility_crs_station_crs_fk" FOREIGN KEY ("crs") REFERENCES "public"."station"("crs") ON DELETE no action ON UPDATE no action;
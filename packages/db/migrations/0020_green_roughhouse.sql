CREATE TABLE "station_track_model_position" (
	"crs" text PRIMARY KEY NOT NULL,
	"elr" text NOT NULL,
	"mileage" real NOT NULL,
	"asset_id" text NOT NULL,
	"matched_lat" real NOT NULL,
	"matched_lon" real NOT NULL,
	"snap_distance_m" real NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "track_model_line" (
	"asset_id" text PRIMARY KEY NOT NULL,
	"elr" text NOT NULL,
	"track_id" text,
	"start_mileage" real,
	"end_mileage" real,
	"geometry" real[] NOT NULL
);
--> statement-breakpoint
ALTER TABLE "station_track_model_position" ADD CONSTRAINT "station_track_model_position_crs_station_crs_fk" FOREIGN KEY ("crs") REFERENCES "public"."station"("crs") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "track_model_line_elr_idx" ON "track_model_line" USING btree ("elr");
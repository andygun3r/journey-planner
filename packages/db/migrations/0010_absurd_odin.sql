CREATE TABLE "tfl_stop_point_cache" (
	"naptan_id" text PRIMARY KEY NOT NULL,
	"common_name" text NOT NULL,
	"crs" text,
	"lat" real,
	"lon" real,
	"modes" text[] DEFAULT '{}' NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "tfl_stop_crs_idx" ON "tfl_stop_point_cache" USING btree ("crs");
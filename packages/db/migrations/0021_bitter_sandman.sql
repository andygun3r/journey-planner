CREATE TABLE "orm_signal" (
	"osm_id" text PRIMARY KEY NOT NULL,
	"ref" text,
	"normalized_ref" text,
	"caption" text,
	"signal_direction" text,
	"main" text,
	"main_function" text,
	"main_form" text,
	"minor" text,
	"route" text,
	"lat" real NOT NULL,
	"lon" real NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "orm_signal_ref_idx" ON "orm_signal" USING btree ("normalized_ref");--> statement-breakpoint
CREATE INDEX "orm_signal_lon_lat_idx" ON "orm_signal" USING btree ("lon","lat");
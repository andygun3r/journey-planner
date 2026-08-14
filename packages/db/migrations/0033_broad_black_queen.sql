CREATE TABLE "corridor_track_section" (
	"id" text PRIMARY KEY NOT NULL,
	"elr" text NOT NULL,
	"start_mileage" real NOT NULL,
	"end_mileage" real NOT NULL,
	"track_ids" text[] NOT NULL,
	"track_count" integer NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "corridor_track_section_elr_idx" ON "corridor_track_section" USING btree ("elr","start_mileage");
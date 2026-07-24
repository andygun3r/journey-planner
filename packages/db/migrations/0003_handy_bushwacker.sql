CREATE TABLE "nr_corpus" (
	"stanox" text PRIMARY KEY NOT NULL,
	"tiploc" text,
	"crs" text,
	"nlc" text,
	"description" text
);
--> statement-breakpoint
CREATE TABLE "nr_smart" (
	"td_area" text NOT NULL,
	"from_berth" text,
	"to_berth" text,
	"stanox" text,
	"event_type" text,
	"platform" text,
	"berth_offset" text,
	CONSTRAINT "nr_smart_td_area_from_berth_to_berth_pk" PRIMARY KEY("td_area","from_berth","to_berth")
);
--> statement-breakpoint
CREATE TABLE "nr_train_position" (
	"train_id" text PRIMARY KEY NOT NULL,
	"headcode" text,
	"rid" text,
	"last_stanox" text,
	"last_tiploc" text,
	"last_crs" text,
	"last_event_type" text,
	"last_reported_at" timestamp with time zone,
	"td_area" text,
	"berth" text,
	"lateness" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "nr_corpus_tiploc_idx" ON "nr_corpus" USING btree ("tiploc");--> statement-breakpoint
CREATE INDEX "nr_corpus_crs_idx" ON "nr_corpus" USING btree ("crs");--> statement-breakpoint
CREATE INDEX "nr_smart_stanox_idx" ON "nr_smart" USING btree ("stanox");--> statement-breakpoint
CREATE INDEX "nr_pos_headcode_idx" ON "nr_train_position" USING btree ("headcode");--> statement-breakpoint
CREATE INDEX "nr_pos_rid_idx" ON "nr_train_position" USING btree ("rid");
CREATE TABLE "nr_signalling_state" (
	"td_area" text NOT NULL,
	"address" text NOT NULL,
	"data" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nr_signalling_state_td_area_address_pk" PRIMARY KEY("td_area","address")
);
--> statement-breakpoint
CREATE TABLE "sop_mapping" (
	"td_area" text NOT NULL,
	"address" text NOT NULL,
	"bit" smallint NOT NULL,
	"item_type" text NOT NULL,
	"item_id" text,
	"aspect" text,
	"description" text,
	CONSTRAINT "sop_mapping_td_area_address_bit_pk" PRIMARY KEY("td_area","address","bit")
);
--> statement-breakpoint
CREATE INDEX "sop_item_idx" ON "sop_mapping" USING btree ("td_area","item_id");
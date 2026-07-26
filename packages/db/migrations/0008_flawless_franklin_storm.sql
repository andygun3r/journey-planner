CREATE TABLE "nr_headcode" (
	"uid" text PRIMARY KEY NOT NULL,
	"headcode" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

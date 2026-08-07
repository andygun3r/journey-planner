CREATE TABLE "toc_operator" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"website" text,
	"contact_phone" text,
	"contact_email" text,
	"raw" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

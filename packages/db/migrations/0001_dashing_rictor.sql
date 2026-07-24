CREATE TABLE "darwin_formation" (
	"rid" text PRIMARY KEY NOT NULL,
	"fid" text,
	"coaches" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

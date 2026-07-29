CREATE TABLE "rail_corridor" (
	"from_crs" text NOT NULL,
	"to_crs" text NOT NULL,
	"geometry" real[] NOT NULL,
	"length_m" real,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rail_corridor_from_crs_to_crs_pk" PRIMARY KEY("from_crs","to_crs")
);

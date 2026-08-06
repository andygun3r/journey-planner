ALTER TABLE "station_track_model_position" DROP CONSTRAINT "station_track_model_position_crs_station_crs_fk";
--> statement-breakpoint
ALTER TABLE "orm_signal" ADD COLUMN "signal_position" text;--> statement-breakpoint
ALTER TABLE "orm_signal" ADD COLUMN "track_bearing" real;--> statement-breakpoint
ALTER TABLE "orm_signal" ADD COLUMN "main_design" text;--> statement-breakpoint
ALTER TABLE "orm_signal" ADD COLUMN "main_states" text;--> statement-breakpoint
ALTER TABLE "orm_signal" ADD COLUMN "distant" text;--> statement-breakpoint
ALTER TABLE "orm_signal" ADD COLUMN "distant_form" text;--> statement-breakpoint
ALTER TABLE "orm_signal" ADD COLUMN "distant_states" text;--> statement-breakpoint
ALTER TABLE "orm_signal" ADD COLUMN "combined" text;--> statement-breakpoint
ALTER TABLE "orm_signal" ADD COLUMN "combined_form" text;--> statement-breakpoint
ALTER TABLE "orm_signal" ADD COLUMN "combined_states" text;--> statement-breakpoint
ALTER TABLE "orm_signal" ADD COLUMN "minor_form" text;--> statement-breakpoint
ALTER TABLE "orm_signal" ADD COLUMN "shunting" text;--> statement-breakpoint
ALTER TABLE "orm_signal" ADD COLUMN "shunting_form" text;--> statement-breakpoint
ALTER TABLE "orm_signal" ADD COLUMN "main_repeated" text;--> statement-breakpoint
ALTER TABLE "orm_signal" ADD COLUMN "main_repeated_form" text;--> statement-breakpoint
ALTER TABLE "orm_signal" ADD COLUMN "route_design" text;--> statement-breakpoint
ALTER TABLE "orm_signal" ADD COLUMN "route_form" text;--> statement-breakpoint
ALTER TABLE "orm_signal" ADD COLUMN "route_states" text;--> statement-breakpoint
ALTER TABLE "orm_signal" ADD COLUMN "tags" jsonb;--> statement-breakpoint
ALTER TABLE "station_track_model_position" ADD CONSTRAINT "station_track_model_position_crs_station_crs_fk" FOREIGN KEY ("crs") REFERENCES "public"."station"("crs") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "station_track_model_position" DROP CONSTRAINT "station_track_model_position_crs_station_crs_fk";
--> statement-breakpoint
ALTER TABLE "station_track_model_position" ADD CONSTRAINT "station_track_model_position_crs_station_crs_fk" FOREIGN KEY ("crs") REFERENCES "public"."station"("crs") ON DELETE cascade ON UPDATE no action;
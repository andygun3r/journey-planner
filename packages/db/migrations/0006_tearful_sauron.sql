CREATE TABLE "nr_train_position_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"train_id" text NOT NULL,
	"headcode" text,
	"rid" text,
	"last_stanox" text,
	"last_tiploc" text,
	"last_crs" text,
	"last_event_type" text,
	"reported_at" timestamp with time zone NOT NULL,
	"td_area" text,
	"berth" text,
	"lateness" integer,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "nr_pos_hist_train_time_idx" ON "nr_train_position_history" USING btree ("train_id","reported_at");--> statement-breakpoint
CREATE INDEX "nr_pos_hist_rid_time_idx" ON "nr_train_position_history" USING btree ("rid","reported_at");--> statement-breakpoint
CREATE INDEX "nr_pos_hist_recorded_idx" ON "nr_train_position_history" USING btree ("recorded_at");
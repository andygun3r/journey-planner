ALTER TABLE "user" ADD COLUMN "reduced_motion" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "text_size" text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "high_contrast" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "strengthen_cues" boolean DEFAULT false NOT NULL;
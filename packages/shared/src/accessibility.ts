import { z } from "zod";

/**
 * Accessibility preferences: an opt-in layer signed-in users can turn on
 * from /settings, on top of the app's single default theme (see PRODUCT.md's
 * Accessibility & Inclusion addendum). Kept framework-free like the rest of
 * this package so both the web app and its server actions import the same
 * shape.
 */
export const TextSize = z.enum(["normal", "large", "larger"]);
export type TextSize = z.infer<typeof TextSize>;

export const AccessibilityPrefsInput = z.object({
  reducedMotion: z.boolean(),
  textSize: TextSize,
  highContrast: z.boolean(),
  strengthenCues: z.boolean(),
});
export type AccessibilityPrefsInput = z.infer<typeof AccessibilityPrefsInput>;

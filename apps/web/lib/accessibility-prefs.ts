import { user } from "@signaller/db";
import type { AccessibilityPrefsInput } from "@signaller/shared";
import { eq } from "drizzle-orm";
import { getDb } from "./db";

const DEFAULT_PREFS: AccessibilityPrefsInput = {
  reducedMotion: false,
  textSize: "normal",
  highContrast: false,
  strengthenCues: false,
};

/** A signed-in user's accessibility preferences, or the unchanged defaults if unset. */
export async function getAccessibilityPrefs(userId: string): Promise<AccessibilityPrefsInput> {
  const rows = await getDb()
    .select({
      reducedMotion: user.reducedMotion,
      textSize: user.textSize,
      highContrast: user.highContrast,
      strengthenCues: user.strengthenCues,
    })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  const row = rows[0];
  if (!row) return DEFAULT_PREFS;
  return {
    reducedMotion: row.reducedMotion,
    textSize: row.textSize as AccessibilityPrefsInput["textSize"],
    highContrast: row.highContrast,
    strengthenCues: row.strengthenCues,
  };
}

export async function setAccessibilityPrefs(
  userId: string,
  prefs: AccessibilityPrefsInput,
): Promise<void> {
  await getDb()
    .update(user)
    .set({
      reducedMotion: prefs.reducedMotion,
      textSize: prefs.textSize,
      highContrast: prefs.highContrast,
      strengthenCues: prefs.strengthenCues,
    })
    .where(eq(user.id, userId));
}

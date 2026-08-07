"use client";

import { useState, useTransition } from "react";
import type { AccessibilityPrefsInput, TextSize } from "@signaller/shared";
import { updateAccessibilityPrefsAction } from "@/app/settings/actions";

interface Props {
  prefs: AccessibilityPrefsInput;
}

/**
 * Accessibility preferences — an opt-in layer on top of the app's one
 * default theme (see PRODUCT.md's Accessibility & Inclusion addendum).
 * Saves each control the moment it changes, same immediacy as push-toggle.
 */
export function AccessibilitySettings({ prefs: initial }: Props) {
  const [prefs, setPrefs] = useState(initial);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function save(next: AccessibilityPrefsInput) {
    setPrefs(next);
    setError(null);
    startTransition(async () => {
      const result = await updateAccessibilityPrefsAction(next);
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <div>
      <label className="day-toggle">
        <input
          type="checkbox"
          checked={prefs.reducedMotion}
          disabled={pending}
          onChange={(e) => save({ ...prefs, reducedMotion: e.target.checked })}
        />
        Reduce motion — turn off live-update animation and transitions
      </label>

      <label className="day-toggle">
        <input
          type="checkbox"
          checked={prefs.highContrast}
          disabled={pending}
          onChange={(e) => save({ ...prefs, highContrast: e.target.checked })}
        />
        High-contrast theme — an alternate palette with stronger contrast
      </label>

      <label className="day-toggle">
        <input
          type="checkbox"
          checked={prefs.strengthenCues}
          disabled={pending}
          onChange={(e) => save({ ...prefs, strengthenCues: e.target.checked })}
        />
        Strengthen non-colour cues — always underline links, reinforce status markers
      </label>

      <div className="field">
        <label htmlFor="text-size">Text size</label>
        <select
          id="text-size"
          value={prefs.textSize}
          disabled={pending}
          onChange={(e) => save({ ...prefs, textSize: e.target.value as TextSize })}
        >
          <option value="normal">Normal</option>
          <option value="large">Large</option>
          <option value="larger">Larger</option>
        </select>
      </div>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

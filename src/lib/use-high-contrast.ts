"use client";

import { useCallback, useEffect, useState } from "react";

// Polish Session D — gate/vendor/timing staff work outdoors in direct
// sunlight, where this app's normal dark theme (built for a screen, not a
// midday football pitch) can wash out. Persisted per-device via
// localStorage, same pattern as useLocaleState — it's a device preference
// the staff member sets once, not organization or event state.
const STORAGE_KEY = "eventpass-africa:scan-high-contrast";

export function useHighContrast() {
  const [highContrast, setHighContrastState] = useState(false);

  useEffect(() => {
    setHighContrastState(localStorage.getItem(STORAGE_KEY) === "1");
  }, []);

  const setHighContrast = useCallback((next: boolean) => {
    localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
    setHighContrastState(next);
  }, []);

  const toggle = useCallback(() => setHighContrast(!highContrast), [highContrast, setHighContrast]);

  return { highContrast, setHighContrast, toggle };
}

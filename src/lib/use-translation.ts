"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { dictionaries, type Locale, type TranslationKey } from "@/lib/i18n";

const STORAGE_KEY = "eventpass-africa:locale";

interface LocaleContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

export const LocaleContext = createContext<LocaleContextValue>({
  locale: "en",
  setLocale: () => {},
});

export function useLocaleState() {
  const [locale, setLocaleState] = useState<Locale>("en");

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "en" || stored === "sw") setLocaleState(stored);
  }, []);

  const setLocale = useCallback((next: Locale) => {
    localStorage.setItem(STORAGE_KEY, next);
    setLocaleState(next);
  }, []);

  return { locale, setLocale };
}

export function useTranslation() {
  const { locale, setLocale } = useContext(LocaleContext);
  // Session 20 — optional {placeholder} interpolation, needed for messages
  // that embed a dynamic amount/name/count (e.g. "Charged {amount}.") that
  // a plain key lookup can't produce on its own. Existing single-argument
  // call sites (`t("key")`) are unaffected.
  const t = useCallback(
    (key: TranslationKey, vars?: Record<string, string | number>) => {
      const template = dictionaries[locale][key] ?? dictionaries.en[key] ?? key;
      if (!vars) return template;
      return Object.entries(vars).reduce(
        (acc, [name, value]) => acc.replaceAll(`{${name}}`, String(value)),
        template as string
      );
    },
    [locale]
  );
  return { t, locale, setLocale };
}

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
  const t = useCallback(
    (key: TranslationKey) => dictionaries[locale][key] ?? dictionaries.en[key] ?? key,
    [locale]
  );
  return { t, locale, setLocale };
}

"use client";

import { SessionProvider } from "next-auth/react";
import { useEffect } from "react";
import { startAutoSync, pullFromServer } from "@/lib/sync-engine";
import { LocaleContext, useLocaleState } from "@/lib/use-translation";

export default function Providers({ children }: { children: React.ReactNode }) {
  const locale = useLocaleState();

  useEffect(() => {
    startAutoSync();
    // opportunistic first hydrate in case autoSync's initial run fired before mount
    pullFromServer();
  }, []);

  return (
    <SessionProvider>
      <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>
    </SessionProvider>
  );
}

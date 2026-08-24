"use client";

import { useSession } from "next-auth/react";
import { useEffect, useState } from "react";
import { useOnlineStatus } from "@/lib/sync-engine";

const CACHE_KEY = "eventpass-africa:cachedProfile";

interface CachedProfile {
  id: string;
  name: string;
  email: string;
  role: string;
}

/**
 * Wraps next-auth's useSession() with a localStorage fallback so the UI can
 * still show "who's logged in" while fully offline (the real NextAuth JWT
 * cookie already persists on disk and is what actually authorizes writes
 * once a sync request reaches the server — this cache is only for instant,
 * offline-safe UI rendering before that round-trip is possible).
 */
export function useAppSession() {
  const { data, status } = useSession();
  const [cached, setCached] = useState<CachedProfile | null>(null);
  const online = useOnlineStatus();

  useEffect(() => {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      try {
        setCached(JSON.parse(raw));
      } catch {
        // ignore
      }
    }
  }, []);

  useEffect(() => {
    if (status === "authenticated" && data?.user) {
      const profile: CachedProfile = {
        id: data.user.id,
        name: data.user.name ?? "",
        email: data.user.email ?? "",
        role: data.user.role ?? "USER",
      };
      localStorage.setItem(CACHE_KEY, JSON.stringify(profile));
      setCached(profile);
    }
    if (status === "unauthenticated" && online) {
      localStorage.removeItem(CACHE_KEY);
      setCached(null);
    }
  }, [status, data, online]);

  if (status === "authenticated" && data?.user) {
    return {
      user: { id: data.user.id, name: data.user.name, email: data.user.email, role: data.user.role ?? "USER" },
      status: "authenticated" as const,
      offline: false,
    };
  }

  if (status !== "authenticated" && !online && cached) {
    return { user: cached, status: "authenticated" as const, offline: true };
  }

  return { user: null, status, offline: !online };
}

export function clearCachedProfile() {
  localStorage.removeItem(CACHE_KEY);
}

/**
 * Simple session store using AsyncStorage.
 * No external auth library needed — staff login returns a short-lived token
 * the app holds in memory + storage.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import type { StaffSession } from "./api";

const SESSION_KEY = "chaap_staff_session";

export async function saveSession(session: StaffSession): Promise<void> {
  await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export async function loadSession(): Promise<StaffSession | null> {
  try {
    const raw = await AsyncStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as StaffSession;
  } catch {
    return null;
  }
}

export async function clearSession(): Promise<void> {
  await AsyncStorage.removeItem(SESSION_KEY);
}

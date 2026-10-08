import { useEffect, useState } from "react";
import { Stack, router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { loadSession } from "../lib/auth";

export default function RootLayout() {
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    loadSession().then((session) => {
      if (session) {
        router.replace("/(tabs)/scan");
      } else {
        router.replace("/login");
      }
      setChecked(true);
    });
  }, []);

  if (!checked) return null;

  return (
    <>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false }} />
    </>
  );
}

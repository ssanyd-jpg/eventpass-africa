/**
 * Gate Scanner — tap NFC wristband → instant pass/fail
 *
 * Uses expo-nfc to read the wristband UID, then hits /api/staff/scan.
 * Fullscreen green/red result with haptic feedback.
 */

import { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Vibration,
  ActivityIndicator,
} from "react-native";
import * as Haptics from "expo-haptics";
import { useFocusEffect } from "expo-router";
import { validateTicket } from "../../lib/api";
import { loadSession } from "../../lib/auth";
import type { StaffSession, ScanResult } from "../../lib/api";

type ScreenState =
  | { kind: "idle" }
  | { kind: "scanning" }
  | { kind: "result"; result: ScanResult }
  | { kind: "error"; message: string };

// expo-nfc is a community package — import defensively
let NfcManager: any = null;
let NfcTech: any = null;
try {
  const nfc = require("expo-nfc");
  NfcManager = nfc.default ?? nfc.NfcManager;
  NfcTech = nfc.NfcTech;
} catch {
  // NFC not available (simulator or web)
}

export default function ScanScreen() {
  const [session, setSession] = useState<StaffSession | null>(null);
  const [state, setState] = useState<ScreenState>({ kind: "idle" });
  const [nfcSupported, setNfcSupported] = useState<boolean | null>(null);

  useEffect(() => {
    loadSession().then(setSession);
    if (NfcManager) {
      NfcManager.isSupported().then((supported: boolean) => {
        setNfcSupported(supported);
        if (supported) NfcManager.start();
      });
      return () => {
        NfcManager?.cancelTechnologyRequest().catch(() => {});
      };
    } else {
      setNfcSupported(false);
    }
  }, []);

  // Cancel any pending NFC request when leaving screen
  useFocusEffect(
    useCallback(() => {
      return () => {
        NfcManager?.cancelTechnologyRequest().catch(() => {});
        setState({ kind: "idle" });
      };
    }, [])
  );

  async function startScan() {
    if (!session) return;
    setState({ kind: "scanning" });
    try {
      await NfcManager.requestTechnology(NfcTech.Ndef);
      const tag = await NfcManager.getTag();
      const uid = tag?.id
        ? Array.from(tag.id as number[])
            .map((b: number) => b.toString(16).padStart(2, "0"))
            .join(":")
        : null;

      if (!uid) throw new Error("Could not read wristband UID");

      const result = await validateTicket(uid, session.eventId, session.token);

      if (result.valid) {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } else {
        Vibration.vibrate([0, 200, 100, 200]);
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }

      setState({ kind: "result", result });

      // Auto-reset after 3s for fast flow at the gate
      setTimeout(() => setState({ kind: "idle" }), 3000);
    } catch (err: any) {
      if (err?.message?.includes("cancelled")) {
        setState({ kind: "idle" });
        return;
      }
      setState({ kind: "error", message: err?.message ?? "Scan failed" });
      setTimeout(() => setState({ kind: "idle" }), 3000);
    } finally {
      NfcManager?.cancelTechnologyRequest().catch(() => {});
    }
  }

  // ── Simulated scan for devices without NFC (dev/testing) ─────────────
  async function simulateScan() {
    if (!session) return;
    setState({ kind: "scanning" });
    await new Promise((r) => setTimeout(r, 800));
    const result: ScanResult = {
      valid: true,
      ticketCode: "TKT-DEMO-001",
      holderName: "Demo Attendee",
      ticketType: "General Admission",
      alreadyUsed: false,
      message: "DEMO MODE — NFC not available on this device",
    };
    setState({ kind: "result", result });
    setTimeout(() => setState({ kind: "idle" }), 3000);
  }

  const canScan = nfcSupported === true && NfcManager !== null;

  if (state.kind === "result") {
    const { result } = state;
    return (
      <View style={[styles.fullscreen, result.valid ? styles.bgGreen : styles.bgRed]}>
        <Text style={styles.resultIcon}>{result.valid ? "✓" : "✗"}</Text>
        <Text style={styles.resultTitle}>{result.valid ? "VALID" : "INVALID"}</Text>
        <Text style={styles.resultName}>{result.holderName}</Text>
        <Text style={styles.resultTicket}>{result.ticketType}</Text>
        {result.alreadyUsed && (
          <Text style={styles.resultWarning}>⚠ Already scanned</Text>
        )}
        <Text style={styles.resultMessage}>{result.message}</Text>
      </View>
    );
  }

  if (state.kind === "error") {
    return (
      <View style={[styles.fullscreen, styles.bgRed]}>
        <Text style={styles.resultIcon}>!</Text>
        <Text style={styles.resultTitle}>ERROR</Text>
        <Text style={styles.resultMessage}>{state.message}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>Gate Scanner</Text>
      {session && (
        <Text style={styles.eventName}>{session.eventName}</Text>
      )}

      <View style={styles.scanArea}>
        {state.kind === "scanning" ? (
          <>
            <ActivityIndicator size="large" color="#10b981" />
            <Text style={styles.scanningText}>Hold wristband to phone…</Text>
          </>
        ) : (
          <Text style={styles.nfcIcon}>📡</Text>
        )}
      </View>

      <TouchableOpacity
        style={[styles.scanButton, state.kind === "scanning" && styles.disabled]}
        onPress={canScan ? startScan : simulateScan}
        disabled={state.kind === "scanning"}
      >
        <Text style={styles.scanButtonText}>
          {state.kind === "scanning"
            ? "Scanning…"
            : canScan
            ? "Tap to Scan"
            : "Simulate Scan (no NFC)"}
        </Text>
      </TouchableOpacity>

      {nfcSupported === false && (
        <Text style={styles.noNfc}>NFC not available — running in demo mode</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#111827",
    alignItems: "center",
    paddingTop: 64,
    padding: 24,
  },
  heading: {
    fontSize: 28,
    fontWeight: "700",
    color: "#f9fafb",
    marginBottom: 4,
  },
  eventName: {
    fontSize: 15,
    color: "#9ca3af",
    marginBottom: 40,
  },
  scanArea: {
    width: 200,
    height: 200,
    borderRadius: 100,
    backgroundColor: "#1f2937",
    borderWidth: 3,
    borderColor: "#374151",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 40,
  },
  nfcIcon: { fontSize: 72 },
  scanningText: {
    color: "#9ca3af",
    fontSize: 14,
    marginTop: 16,
    textAlign: "center",
  },
  scanButton: {
    backgroundColor: "#10b981",
    paddingVertical: 18,
    paddingHorizontal: 48,
    borderRadius: 50,
    width: "100%",
    alignItems: "center",
  },
  disabled: { opacity: 0.5 },
  scanButtonText: {
    fontSize: 18,
    fontWeight: "700",
    color: "#111827",
  },
  noNfc: {
    color: "#6b7280",
    fontSize: 13,
    marginTop: 16,
    textAlign: "center",
  },
  // Fullscreen result
  fullscreen: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
  },
  bgGreen: { backgroundColor: "#065f46" },
  bgRed: { backgroundColor: "#7f1d1d" },
  resultIcon: {
    fontSize: 96,
    color: "#fff",
    fontWeight: "900",
    marginBottom: 16,
  },
  resultTitle: {
    fontSize: 48,
    fontWeight: "900",
    color: "#fff",
    letterSpacing: 4,
    marginBottom: 24,
  },
  resultName: {
    fontSize: 28,
    fontWeight: "700",
    color: "#fff",
    marginBottom: 8,
  },
  resultTicket: {
    fontSize: 18,
    color: "rgba(255,255,255,0.7)",
    marginBottom: 16,
  },
  resultWarning: {
    fontSize: 18,
    color: "#fbbf24",
    fontWeight: "700",
    marginBottom: 8,
  },
  resultMessage: {
    fontSize: 14,
    color: "rgba(255,255,255,0.5)",
    textAlign: "center",
  },
});

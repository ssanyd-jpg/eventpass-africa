/**
 * Gate Scanner — tap NFC wristband → instant pass/fail
 *
 * Uses expo-nfc to read the wristband UID, then hits /api/staff/scan.
 * Fullscreen Chaap Panther brand video for both grant and deny — the same
 * granted.mp4/denied.mp4 clips the web PWA gate scanner plays (see
 * src/components/ScanResultOverlay.tsx in the Next.js app), swapped in
 * here in place of this screen's old one-off Lottie animation so both
 * scanner surfaces look and sound the same.
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
import { useEventListener } from "expo";
import { useVideoPlayer, VideoView, type VideoSource } from "expo-video";
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

// Safety-net only — ResultVideo's onEnd normally fires first and resets the
// screen (see below); this just guarantees the scanner can never get stuck
// on a frozen result if a clip fails to load. Matches each clip's real
// length (public/scan-results/ in the web app) plus a small buffer.
const GRANTED_SAFETY_MS = 2600;
const DENIED_SAFETY_MS = 4600;

function ResultVideo({ source, onEnd }: { source: VideoSource; onEnd: () => void }) {
  const player = useVideoPlayer(source, (p) => {
    p.loop = false;
    p.play();
  });
  useEventListener(player, "playToEnd", onEnd);
  return (
    <VideoView
      style={StyleSheet.absoluteFill}
      player={player}
      contentFit="cover"
      nativeControls={false}
    />
  );
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

  // Safety-net reset — see GRANTED_SAFETY_MS/DENIED_SAFETY_MS above. Cleared
  // and re-armed on every new result so it only fires if ResultVideo's
  // onEnd genuinely never does.
  useEffect(() => {
    if (state.kind !== "result" && state.kind !== "error") return;
    const ms = state.kind === "result" && state.result.valid ? GRANTED_SAFETY_MS : DENIED_SAFETY_MS;
    const timer = setTimeout(() => setState({ kind: "idle" }), ms);
    return () => clearTimeout(timer);
  }, [state]);

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
      // Reset is driven by ResultVideo's onEnd below (both the granted and
      // denied clips play to completion) — see the safety-net effect above
      // for the fallback if a clip fails to load.
    } catch (err: any) {
      if (err?.message?.includes("cancelled")) {
        setState({ kind: "idle" });
        return;
      }
      setState({ kind: "error", message: err?.message ?? "Scan failed" });
      // Error state resets via the denied clip's onEnd, same as a real deny.
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
  }

  const canScan = nfcSupported === true && NfcManager !== null;

  if (state.kind === "result") {
    const { result } = state;
    const source: VideoSource = result.valid
      ? require("../../../assets/granted.mp4")
      : require("../../../assets/denied.mp4");

    return (
      <View style={styles.fullscreenVideo}>
        <ResultVideo source={source} onEnd={() => setState({ kind: "idle" })} />
        <View style={styles.infoBar}>
          <Text style={styles.resultTitle}>{result.valid ? "VALID" : "DENIED"}</Text>
          <Text style={styles.resultName}>{result.holderName}</Text>
          <Text style={styles.resultTicket}>{result.ticketType}</Text>
          {result.alreadyUsed && <Text style={styles.resultWarning}>⚠ Already scanned</Text>}
          <Text style={styles.resultMessage}>{result.message}</Text>
        </View>
      </View>
    );
  }

  if (state.kind === "error") {
    return (
      <View style={styles.fullscreenVideo}>
        <ResultVideo
          source={require("../../../assets/denied.mp4")}
          onEnd={() => setState({ kind: "idle" })}
        />
        <View style={styles.infoBar}>
          <Text style={styles.resultTitle}>ERROR</Text>
          <Text style={styles.resultMessage}>{state.message}</Text>
        </View>
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
  // Fullscreen video result (grant/deny/error) — video fills the screen,
  // the operational info (name, ticket type, code) sits in a translucent
  // bar up top so it never collides with the clip's own baked-in
  // "GRANTED"/"ACCESS DENIED" text, which sits lower in the frame.
  fullscreenVideo: {
    flex: 1,
    backgroundColor: "#000",
  },
  infoBar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: "rgba(0,0,0,0.6)",
    paddingTop: 56,
    paddingBottom: 16,
    paddingHorizontal: 24,
    alignItems: "center",
  },
  resultTitle: {
    fontSize: 32,
    fontWeight: "900",
    color: "#fff",
    letterSpacing: 3,
    marginBottom: 8,
  },
  resultName: {
    fontSize: 22,
    fontWeight: "700",
    color: "#fff",
    marginBottom: 4,
  },
  resultTicket: {
    fontSize: 15,
    color: "rgba(255,255,255,0.7)",
    marginBottom: 8,
  },
  resultWarning: {
    fontSize: 15,
    color: "#fbbf24",
    fontWeight: "700",
    marginBottom: 4,
  },
  resultMessage: {
    fontSize: 13,
    color: "rgba(255,255,255,0.6)",
    textAlign: "center",
  },
});

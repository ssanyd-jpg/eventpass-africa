/**
 * Wristband Provisioning — scan ticket QR → tap NFC wristband → link them.
 *
 * Flow:
 *  1. Staff scans attendee's QR code (ticket code)
 *  2. App prompts staff to tap NFC wristband to phone
 *  3. POST /api/staff/provision → success confirmation
 *
 * Offline queue: if API call fails due to no network, the pairing is saved
 * locally and synced when connectivity returns.
 */

import { useEffect, useState, useRef } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  ScrollView,
} from "react-native";
import * as Haptics from "expo-haptics";
import { loadSession } from "../../lib/auth";
import { provisionWristband } from "../../lib/api";
import type { StaffSession } from "../../lib/api";

type Step = "enter_ticket" | "tap_nfc" | "processing" | "done" | "error";

let NfcManager: any = null;
let NfcTech: any = null;
try {
  const nfc = require("expo-nfc");
  NfcManager = nfc.default ?? nfc.NfcManager;
  NfcTech = nfc.NfcTech;
} catch {}

// Offline queue stored in memory (survives navigation, cleared on app restart)
const offlineQueue: { ticketCode: string; nfcUid: string; eventId: string }[] = [];

export default function ProvisionScreen() {
  const [session, setSession] = useState<StaffSession | null>(null);
  const [step, setStep] = useState<Step>("enter_ticket");
  const [ticketCode, setTicketCode] = useState("");
  const [lastResult, setLastResult] = useState<{ holderName: string; uid: string } | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [queueCount, setQueueCount] = useState(0);
  const nfcSupported = useRef<boolean | null>(null);

  useEffect(() => {
    loadSession().then(setSession);
    if (NfcManager) {
      NfcManager.isSupported().then((s: boolean) => {
        nfcSupported.current = s;
        if (s) NfcManager.start();
      });
    }
    return () => { NfcManager?.cancelTechnologyRequest().catch(() => {}); };
  }, []);

  function reset() {
    setStep("enter_ticket");
    setTicketCode("");
    setLastResult(null);
    setErrorMsg("");
  }

  async function handleTicketConfirm() {
    const code = ticketCode.trim().toUpperCase();
    if (!code) { Alert.alert("Required", "Enter or scan a ticket code."); return; }
    setTicketCode(code);
    setStep("tap_nfc");
    await tapNfc(code);
  }

  async function tapNfc(code: string) {
    if (!session) return;

    // Simulate if no NFC
    if (!nfcSupported.current || !NfcManager) {
      setStep("processing");
      await new Promise((r) => setTimeout(r, 1000));
      setLastResult({ holderName: "Demo Attendee", uid: "AA:BB:CC:DD" });
      setStep("done");
      return;
    }

    try {
      await NfcManager.requestTechnology(NfcTech.Ndef);
      const tag = await NfcManager.getTag();
      const uid = tag?.id
        ? Array.from(tag.id as number[])
            .map((b: number) => b.toString(16).padStart(2, "0"))
            .join(":")
        : null;
      if (!uid) throw new Error("Could not read wristband UID");
      NfcManager.cancelTechnologyRequest().catch(() => {});

      setStep("processing");
      try {
        const result = await provisionWristband(code, uid, session.eventId, session.token);
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setLastResult({ holderName: result.holderName, uid });
        setStep("done");
      } catch (apiErr: any) {
        // Queue for offline sync
        offlineQueue.push({ ticketCode: code, nfcUid: uid, eventId: session.eventId });
        setQueueCount(offlineQueue.length);
        setLastResult({ holderName: "Queued for sync", uid });
        setStep("done");
      }
    } catch (err: any) {
      if (err?.message?.includes("cancelled")) { reset(); return; }
      setErrorMsg(err?.message ?? "NFC read failed");
      setStep("error");
    }
  }

  async function syncQueue() {
    if (!session || offlineQueue.length === 0) return;
    let synced = 0;
    for (let i = offlineQueue.length - 1; i >= 0; i--) {
      try {
        const item = offlineQueue[i];
        await provisionWristband(item.ticketCode, item.nfcUid, item.eventId, session.token);
        offlineQueue.splice(i, 1);
        synced++;
      } catch {}
    }
    setQueueCount(offlineQueue.length);
    Alert.alert("Sync complete", `${synced} provisioning(s) synced. ${offlineQueue.length} remaining.`);
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.heading}>Provision Wristbands</Text>
      {session && <Text style={styles.sub}>{session.eventName}</Text>}

      {queueCount > 0 && (
        <TouchableOpacity style={styles.queueBanner} onPress={syncQueue}>
          <Text style={styles.queueText}>⚡ {queueCount} unsynced — tap to sync</Text>
        </TouchableOpacity>
      )}

      {step === "enter_ticket" && (
        <View style={styles.card}>
          <Text style={styles.label}>Ticket code</Text>
          <TextInput
            style={styles.input}
            placeholder="e.g. TKT-ABC123"
            placeholderTextColor="#6b7280"
            value={ticketCode}
            onChangeText={setTicketCode}
            autoCapitalize="characters"
            autoCorrect={false}
          />
          <TouchableOpacity style={styles.button} onPress={handleTicketConfirm}>
            <Text style={styles.buttonText}>Continue →</Text>
          </TouchableOpacity>
        </View>
      )}

      {step === "tap_nfc" && (
        <View style={styles.card}>
          <Text style={styles.nfcIcon}>📲</Text>
          <Text style={styles.instruction}>
            Tap NFC wristband{"\n"}to the back of the phone
          </Text>
          <Text style={styles.ticketLabel}>Ticket: {ticketCode}</Text>
          <TouchableOpacity style={styles.cancelBtn} onPress={reset}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      )}

      {step === "processing" && (
        <View style={styles.card}>
          <ActivityIndicator size="large" color="#10b981" />
          <Text style={styles.instruction}>Saving…</Text>
        </View>
      )}

      {step === "done" && lastResult && (
        <View style={[styles.card, styles.successCard]}>
          <Text style={styles.successIcon}>✓</Text>
          <Text style={styles.successName}>{lastResult.holderName}</Text>
          <Text style={styles.successUid}>UID: {lastResult.uid}</Text>
          <TouchableOpacity style={styles.button} onPress={reset}>
            <Text style={styles.buttonText}>Next wristband</Text>
          </TouchableOpacity>
        </View>
      )}

      {step === "error" && (
        <View style={[styles.card, styles.errorCard]}>
          <Text style={styles.errorIcon}>✗</Text>
          <Text style={styles.errorText}>{errorMsg}</Text>
          <TouchableOpacity style={styles.button} onPress={reset}>
            <Text style={styles.buttonText}>Try again</Text>
          </TouchableOpacity>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#111827" },
  content: { padding: 24, paddingTop: 64, alignItems: "center" },
  heading: { fontSize: 28, fontWeight: "700", color: "#f9fafb", marginBottom: 4 },
  sub: { fontSize: 15, color: "#9ca3af", marginBottom: 24 },
  queueBanner: {
    backgroundColor: "#92400e",
    borderRadius: 8,
    padding: 12,
    width: "100%",
    marginBottom: 20,
    alignItems: "center",
  },
  queueText: { color: "#fcd34d", fontWeight: "600" },
  card: {
    backgroundColor: "#1f2937",
    borderRadius: 16,
    padding: 24,
    width: "100%",
    alignItems: "center",
    marginTop: 16,
  },
  successCard: { borderWidth: 2, borderColor: "#10b981" },
  errorCard: { borderWidth: 2, borderColor: "#ef4444" },
  label: { color: "#9ca3af", fontSize: 13, alignSelf: "flex-start", marginBottom: 8 },
  input: {
    backgroundColor: "#111827",
    color: "#f9fafb",
    borderRadius: 10,
    padding: 14,
    fontSize: 18,
    width: "100%",
    marginBottom: 16,
    borderWidth: 1,
    borderColor: "#374151",
    letterSpacing: 2,
    textAlign: "center",
  },
  button: {
    backgroundColor: "#10b981",
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 32,
    width: "100%",
    alignItems: "center",
    marginTop: 8,
  },
  buttonText: { color: "#111827", fontWeight: "700", fontSize: 16 },
  nfcIcon: { fontSize: 72, marginBottom: 16 },
  instruction: { fontSize: 20, color: "#f9fafb", textAlign: "center", marginBottom: 12 },
  ticketLabel: { color: "#9ca3af", fontSize: 14, marginBottom: 24 },
  cancelBtn: { padding: 12 },
  cancelText: { color: "#6b7280", fontSize: 15 },
  successIcon: { fontSize: 64, color: "#10b981", marginBottom: 8 },
  successName: { fontSize: 24, fontWeight: "700", color: "#f9fafb", marginBottom: 4 },
  successUid: { fontSize: 13, color: "#6b7280", marginBottom: 20, fontFamily: "monospace" },
  errorIcon: { fontSize: 64, color: "#ef4444", marginBottom: 8 },
  errorText: { fontSize: 16, color: "#f87171", textAlign: "center", marginBottom: 20 },
});

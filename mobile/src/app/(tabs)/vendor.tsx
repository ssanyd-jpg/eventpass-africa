/**
 * Vendor Tap-to-Pay — customer taps wristband to pay at a stall.
 *
 * Flow:
 *  1. Vendor enters amount (TZS)
 *  2. Customer taps wristband
 *  3. App hits /api/staff/debit → shows new balance + receipt
 */

import { useEffect, useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from "react-native";
import * as Haptics from "expo-haptics";
import { vendorDebit } from "../../lib/api";
import { loadSession } from "../../lib/auth";
import type { StaffSession, DebitResult } from "../../lib/api";

type Step = "enter_amount" | "tap_nfc" | "processing" | "done" | "error";

let NfcManager: any = null;
let NfcTech: any = null;
try {
  const nfc = require("expo-nfc");
  NfcManager = nfc.default ?? nfc.NfcManager;
  NfcTech = nfc.NfcTech;
} catch {}

function formatTzs(cents: number): string {
  return `TZS ${(cents / 100).toLocaleString("en-TZ", { minimumFractionDigits: 0 })}`;
}

export default function VendorScreen() {
  const [session, setSession] = useState<StaffSession | null>(null);
  const [step, setStep] = useState<Step>("enter_amount");
  const [amountInput, setAmountInput] = useState("");
  const [result, setResult] = useState<DebitResult | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [nfcSupported, setNfcSupported] = useState<boolean | null>(null);

  useEffect(() => {
    loadSession().then(setSession);
    if (NfcManager) {
      NfcManager.isSupported().then((s: boolean) => {
        setNfcSupported(s);
        if (s) NfcManager.start();
      });
    } else {
      setNfcSupported(false);
    }
    return () => { NfcManager?.cancelTechnologyRequest().catch(() => {}); };
  }, []);

  function reset() {
    setStep("enter_amount");
    setAmountInput("");
    setResult(null);
    setErrorMsg("");
  }

  async function handleAmountConfirm() {
    const amt = parseInt(amountInput.replace(/[^0-9]/g, ""), 10);
    if (!amt || amt < 100) {
      Alert.alert("Invalid amount", "Enter at least TZS 100.");
      return;
    }
    setStep("tap_nfc");
    await doNfcTap(amt * 100); // convert TZS to cents (×100)
  }

  async function doNfcTap(amountCents: number) {
    if (!session) return;

    // Simulate on non-NFC devices
    if (!nfcSupported || !NfcManager) {
      setStep("processing");
      await new Promise((r) => setTimeout(r, 800));
      setResult({
        success: true,
        amountDebitedCents: amountCents,
        newBalanceCents: 15000 * 100,
        holderName: "Demo Customer",
        transactionId: "TXN-DEMO-001",
      });
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

      if (!session.vendorId) throw new Error("No vendor account linked to your profile for this event.");
      setStep("processing");
      const debitResult = await vendorDebit(uid, amountCents, session.vendorId, session.eventId, session.token);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setResult(debitResult);
      setStep("done");
    } catch (err: any) {
      if (err?.message?.includes("cancelled")) { reset(); return; }
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setErrorMsg(err?.message ?? "Payment failed");
      setStep("error");
    }
  }

  const quickAmounts = [2000, 3000, 5000, 10000];

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>Tap to Pay</Text>
      {session && <Text style={styles.sub}>{session.eventName}</Text>}

      {step === "enter_amount" && (
        <View style={styles.card}>
          <Text style={styles.label}>Amount (TZS)</Text>
          <TextInput
            style={styles.amountInput}
            placeholder="0"
            placeholderTextColor="#4b5563"
            value={amountInput}
            onChangeText={(v) => setAmountInput(v.replace(/[^0-9]/g, ""))}
            keyboardType="number-pad"
            textAlign="center"
          />
          <View style={styles.quickRow}>
            {quickAmounts.map((amt) => (
              <TouchableOpacity
                key={amt}
                style={styles.quickBtn}
                onPress={() => setAmountInput(amt.toString())}
              >
                <Text style={styles.quickText}>{(amt / 1000).toFixed(0)}k</Text>
              </TouchableOpacity>
            ))}
          </View>
          <TouchableOpacity style={styles.button} onPress={handleAmountConfirm}>
            <Text style={styles.buttonText}>
              Charge {amountInput ? `TZS ${parseInt(amountInput).toLocaleString()}` : "—"}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {step === "tap_nfc" && (
        <View style={styles.card}>
          <Text style={styles.nfcIcon}>💳</Text>
          <Text style={styles.instruction}>Customer taps wristband</Text>
          <Text style={styles.chargeAmount}>
            {formatTzs(parseInt(amountInput || "0") * 100)}
          </Text>
          <TouchableOpacity style={styles.cancelBtn} onPress={reset}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      )}

      {step === "processing" && (
        <View style={styles.card}>
          <ActivityIndicator size="large" color="#10b981" />
          <Text style={styles.instruction}>Processing…</Text>
        </View>
      )}

      {step === "done" && result && (
        <View style={[styles.card, styles.successCard]}>
          <Text style={styles.successIcon}>✓</Text>
          <Text style={styles.successName}>{result.holderName}</Text>
          <Text style={styles.chargeAmount}>{formatTzs(result.amountDebitedCents)}</Text>
          <Text style={styles.balanceLabel}>
            New balance: <Text style={styles.balance}>{formatTzs(result.newBalanceCents)}</Text>
          </Text>
          <Text style={styles.txnId}>Ref: {result.transactionId}</Text>
          <TouchableOpacity style={styles.button} onPress={reset}>
            <Text style={styles.buttonText}>Next payment</Text>
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
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#111827", padding: 24, paddingTop: 64 },
  heading: { fontSize: 28, fontWeight: "700", color: "#f9fafb", marginBottom: 4, textAlign: "center" },
  sub: { fontSize: 15, color: "#9ca3af", marginBottom: 24, textAlign: "center" },
  card: {
    backgroundColor: "#1f2937",
    borderRadius: 16,
    padding: 24,
    alignItems: "center",
    marginTop: 8,
  },
  successCard: { borderWidth: 2, borderColor: "#10b981" },
  errorCard: { borderWidth: 2, borderColor: "#ef4444" },
  label: { color: "#9ca3af", fontSize: 13, alignSelf: "flex-start", marginBottom: 8 },
  amountInput: {
    fontSize: 56,
    fontWeight: "700",
    color: "#f9fafb",
    width: "100%",
    marginBottom: 16,
  },
  quickRow: { flexDirection: "row", gap: 8, marginBottom: 20 },
  quickBtn: {
    backgroundColor: "#374151",
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  quickText: { color: "#d1d5db", fontWeight: "600", fontSize: 15 },
  button: {
    backgroundColor: "#10b981",
    borderRadius: 10,
    paddingVertical: 16,
    width: "100%",
    alignItems: "center",
  },
  buttonText: { color: "#111827", fontWeight: "700", fontSize: 17 },
  nfcIcon: { fontSize: 72, marginBottom: 16 },
  instruction: { fontSize: 20, color: "#f9fafb", textAlign: "center", marginBottom: 8 },
  chargeAmount: { fontSize: 32, fontWeight: "700", color: "#10b981", marginBottom: 16 },
  cancelBtn: { padding: 12, marginTop: 8 },
  cancelText: { color: "#6b7280", fontSize: 15 },
  successIcon: { fontSize: 56, color: "#10b981", marginBottom: 8 },
  successName: { fontSize: 22, fontWeight: "700", color: "#f9fafb", marginBottom: 4 },
  balanceLabel: { fontSize: 16, color: "#9ca3af", marginBottom: 4 },
  balance: { color: "#f9fafb", fontWeight: "700" },
  txnId: { fontSize: 12, color: "#4b5563", marginBottom: 20, fontFamily: "monospace" },
  errorIcon: { fontSize: 56, color: "#ef4444", marginBottom: 8 },
  errorText: { fontSize: 16, color: "#f87171", textAlign: "center", marginBottom: 20 },
});

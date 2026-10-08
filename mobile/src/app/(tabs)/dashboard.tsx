/**
 * Organiser Dashboard — live event stats, auto-refreshes every 30s.
 */

import { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { useFocusEffect } from "expo-router";
import { getEventStats } from "../../lib/api";
import { loadSession, clearSession } from "../../lib/auth";
import { router } from "expo-router";
import type { StaffSession, EventStats } from "../../lib/api";

function formatTzs(cents: number): string {
  if (cents >= 100_000_00) return `TZS ${(cents / 100_000_00).toFixed(1)}M`;
  if (cents >= 100_000) return `TZS ${(cents / 100_000).toFixed(0)}k`;
  return `TZS ${(cents / 100).toLocaleString()}`;
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <View style={styles.statCard}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
      {sub && <Text style={styles.statSub}>{sub}</Text>}
    </View>
  );
}

export default function DashboardScreen() {
  const [session, setSession] = useState<StaffSession | null>(null);
  const [stats, setStats] = useState<EventStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = { current: null as ReturnType<typeof setInterval> | null };

  async function fetchStats(s?: StaffSession) {
    const sess = s ?? session;
    if (!sess) return;
    try {
      const data = await getEventStats(sess.eventId, sess.token);
      setStats(data);
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? "Failed to load stats");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useFocusEffect(
    useCallback(() => {
      loadSession().then((sess) => {
        setSession(sess);
        fetchStats(sess ?? undefined);
        if (intervalRef.current) clearInterval(intervalRef.current);
        intervalRef.current = setInterval(() => fetchStats(sess ?? undefined), 30_000);
      });
      return () => {
        if (intervalRef.current) clearInterval(intervalRef.current);
      };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
  );

  async function handleLogout() {
    await clearSession();
    router.replace("/login");
  }

  const attendancePct = stats
    ? Math.round((stats.checkedIn / Math.max(stats.totalTickets, 1)) * 100)
    : 0;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => { setRefreshing(true); fetchStats(); }}
          tintColor="#10b981"
        />
      }
    >
      <View style={styles.header}>
        <View>
          <Text style={styles.heading}>Dashboard</Text>
          {session && <Text style={styles.sub}>{session.eventName}</Text>}
        </View>
        <TouchableOpacity onPress={handleLogout} style={styles.logoutBtn}>
          <Text style={styles.logoutText}>Sign out</Text>
        </TouchableOpacity>
      </View>

      {loading && <ActivityIndicator size="large" color="#10b981" style={{ marginTop: 60 }} />}

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>⚠ {error}</Text>
          <TouchableOpacity onPress={() => fetchStats()}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}

      {stats && (
        <>
          {/* Attendance progress bar */}
          <View style={styles.attendanceCard}>
            <View style={styles.attendanceRow}>
              <Text style={styles.attendanceCount}>
                {stats.checkedIn.toLocaleString()}
                <Text style={styles.attendanceTotal}> / {stats.totalTickets.toLocaleString()}</Text>
              </Text>
              <Text style={styles.attendancePct}>{attendancePct}%</Text>
            </View>
            <Text style={styles.attendanceLabel}>Checked in</Text>
            <View style={styles.progressBg}>
              <View style={[styles.progressFill, { width: `${attendancePct}%` as any }]} />
            </View>
          </View>

          {/* Stat grid */}
          <View style={styles.statGrid}>
            <StatCard
              label="Cashless revenue"
              value={formatTzs(stats.cashlessRevenueCents)}
            />
            <StatCard
              label="Active vendors"
              value={stats.activeVendors.toString()}
            />
          </View>

          {/* Top vendors */}
          {stats.topVendors.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Top vendors</Text>
              {stats.topVendors.slice(0, 5).map((v, i) => (
                <View key={v.name} style={styles.vendorRow}>
                  <Text style={styles.vendorRank}>#{i + 1}</Text>
                  <Text style={styles.vendorName}>{v.name}</Text>
                  <Text style={styles.vendorRevenue}>{formatTzs(v.revenueCents)}</Text>
                </View>
              ))}
            </View>
          )}

          <Text style={styles.updated}>
            Updated {new Date(stats.lastUpdated).toLocaleTimeString()} · auto-refreshes every 30s
          </Text>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#111827" },
  content: { padding: 24, paddingTop: 64, paddingBottom: 40 },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 24,
  },
  heading: { fontSize: 28, fontWeight: "700", color: "#f9fafb" },
  sub: { fontSize: 15, color: "#9ca3af", marginTop: 2 },
  logoutBtn: { padding: 8 },
  logoutText: { color: "#6b7280", fontSize: 14 },
  errorBox: {
    backgroundColor: "#450a0a",
    borderRadius: 10,
    padding: 16,
    marginBottom: 16,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  errorText: { color: "#fca5a5", fontSize: 14, flex: 1 },
  retryText: { color: "#10b981", fontWeight: "600", marginLeft: 8 },
  attendanceCard: {
    backgroundColor: "#1f2937",
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
  },
  attendanceRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  attendanceCount: { fontSize: 40, fontWeight: "700", color: "#f9fafb" },
  attendanceTotal: { fontSize: 20, color: "#6b7280" },
  attendancePct: { fontSize: 24, fontWeight: "700", color: "#10b981" },
  attendanceLabel: { color: "#9ca3af", fontSize: 14, marginTop: 2, marginBottom: 12 },
  progressBg: {
    height: 8,
    backgroundColor: "#374151",
    borderRadius: 4,
    overflow: "hidden",
  },
  progressFill: {
    height: 8,
    backgroundColor: "#10b981",
    borderRadius: 4,
  },
  statGrid: { flexDirection: "row", gap: 12, marginBottom: 16 },
  statCard: {
    flex: 1,
    backgroundColor: "#1f2937",
    borderRadius: 16,
    padding: 20,
  },
  statValue: { fontSize: 26, fontWeight: "700", color: "#f9fafb", marginBottom: 4 },
  statLabel: { fontSize: 13, color: "#9ca3af" },
  statSub: { fontSize: 11, color: "#6b7280", marginTop: 2 },
  section: {
    backgroundColor: "#1f2937",
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
  },
  sectionTitle: { fontSize: 16, fontWeight: "700", color: "#f9fafb", marginBottom: 12 },
  vendorRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#374151",
  },
  vendorRank: { width: 28, color: "#6b7280", fontSize: 14 },
  vendorName: { flex: 1, color: "#d1d5db", fontSize: 15 },
  vendorRevenue: { color: "#10b981", fontWeight: "600", fontSize: 15 },
  updated: { color: "#4b5563", fontSize: 12, textAlign: "center", marginTop: 8 },
});

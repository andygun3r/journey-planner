import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { AppShell, Card, EmptyState, PrimaryButton, StatusChip, commonStyles } from "../components/shell";
import { apiBaseUrl, fetchHealth, HealthResponse } from "../lib/api";
import { colors, fonts, spacing, textStyles } from "../theme/tokens";

export default function StatusScreen() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      setHealth(await fetchHealth());
    } catch {
      setHealth(null);
      setError("Could not reach the backend configured for this app.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <AppShell>
      <Card>
        <Text style={textStyles.h1}>Backend status</Text>
        <Text style={styles.muted}>{apiBaseUrl}</Text>
        <PrimaryButton label={loading ? "Checking..." : "Refresh"} onPress={refresh} disabled={loading} />
      </Card>

      {error && <EmptyState title="No connection" body={error} />}

      {health && (
        <Card>
          <View style={commonStyles.row}>
            <Text style={textStyles.h2}>{health.service}</Text>
            <StatusChip label={health.ok ? "Serving" : "Degraded"} tone={health.ok ? "good" : "bad"} />
          </View>
          <StatusRow label="Postgres" ok={health.postgres} />
          <StatusRow label="Redis" ok={health.redis} />
          <StatusRow label="Schema" ok={health.schema === null ? undefined : health.schema} />
        </Card>
      )}
    </AppShell>
  );
}

function StatusRow({ label, ok }: { label: string; ok?: boolean }) {
  return (
    <View style={styles.statusRow}>
      <Text style={styles.statusLabel}>{label}</Text>
      <StatusChip
        label={ok === undefined ? "Not checked" : ok ? "OK" : "Down"}
        tone={ok === undefined ? "neutral" : ok ? "good" : "bad"}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  muted: {
    ...textStyles.body,
    color: colors.inkMuted,
  },
  statusRow: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.rule,
  },
  statusLabel: {
    fontFamily: fonts.inter.semibold,
    fontSize: 16,
    color: colors.ink,
  },
});

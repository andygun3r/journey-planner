import { useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { AppShell, Card, EmptyState, PrimaryButton, StatusChip, commonStyles } from "../components/shell";
import { Journey, JourneyResponse, planJourneys, timeLabel } from "../lib/api";
import { colors, fonts, radii, spacing, textStyles } from "../theme/tokens";

export default function PlanScreen() {
  const [from, setFrom] = useState("WAT");
  const [to, setTo] = useState("VIC");
  const [result, setResult] = useState<JourneyResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!from.trim() || !to.trim()) return;
    setLoading(true);
    setError(null);
    try {
      setResult(await planJourneys(from, to));
    } catch {
      setResult(null);
      setError("Could not reach the Signaller backend. Check EXPO_PUBLIC_API_URL and try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AppShell>
      <View style={styles.shiftStrip}>
        <Text style={textStyles.label}>Journey planner</Text>
        <Text style={styles.apiHint}>Native companion app</Text>
      </View>

      <Card>
        <Text style={textStyles.h1}>Plan a journey</Text>
        <Text style={styles.muted}>Use CRS station codes for this first mobile slice.</Text>
        <View style={styles.inputGrid}>
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>From</Text>
            <TextInput
              autoCapitalize="characters"
              autoCorrect={false}
              value={from}
              onChangeText={setFrom}
              placeholder="WAT"
              placeholderTextColor={colors.inkMuted}
              style={styles.input}
            />
          </View>
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>To</Text>
            <TextInput
              autoCapitalize="characters"
              autoCorrect={false}
              value={to}
              onChangeText={setTo}
              placeholder="VIC"
              placeholderTextColor={colors.inkMuted}
              style={styles.input}
            />
          </View>
        </View>
        <PrimaryButton label={loading ? "Planning..." : "Find trains"} onPress={submit} disabled={loading} />
      </Card>

      {error && <EmptyState title="Backend unavailable" body={error} />}

      {result?.ok === false && (
        <EmptyState
          title={failureTitle(result.reason)}
          body="The mobile app is wired correctly, but the backend could not return journeys for that request."
        />
      )}

      {result?.ok === true && (
        <View style={styles.results}>
          {result.journeys.map((journey) => (
            <JourneyCard key={journey.id} journey={journey} />
          ))}
        </View>
      )}
    </AppShell>
  );
}

function JourneyCard({ journey }: { journey: Journey }) {
  const tone =
    journey.status === "cancelled" ? "bad" : journey.status === "delayed" ? "warn" : "good";
  const firstLeg = journey.legs[0];
  const lastLeg = journey.legs[journey.legs.length - 1];
  return (
    <Card>
      <View style={commonStyles.row}>
        <View>
          <Text style={styles.time}>{timeLabel(journey.liveDeparts ?? journey.departs)}</Text>
          <Text style={styles.muted}>
            Arrives {timeLabel(journey.liveArrives ?? journey.arrives)}
          </Text>
        </View>
        <StatusChip label={statusLabel(journey)} tone={tone} />
      </View>
      <View style={styles.rule} />
      <Text style={styles.route}>
        {firstLeg?.originName ?? "Origin"} to {lastLeg?.destName ?? "destination"}
      </Text>
      <Text style={styles.muted}>
        {journey.durationMinutes} min · {journey.changes} change{journey.changes === 1 ? "" : "s"}
      </Text>
      {journey.legs.slice(0, 3).map((leg, index) => (
        <Text key={`${leg.originCrs}-${leg.destCrs}-${index}`} style={styles.leg}>
          {timeLabel(leg.departs)} {leg.originName} → {leg.destName}
        </Text>
      ))}
    </Card>
  );
}

function statusLabel(journey: Journey): string {
  if (journey.status === "cancelled") return "Cancelled";
  if (journey.delayMinutes) return `${journey.delayMinutes} min late`;
  if (journey.status === "on-time") return "On time";
  return "Scheduled";
}

function failureTitle(reason: string): string {
  if (reason === "engine-offline") return "Routing is offline";
  if (reason === "no-journeys") return "No journeys found";
  return "Check the station codes";
}

const styles = StyleSheet.create({
  shiftStrip: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.rule,
    paddingBottom: spacing.sm,
    gap: 2,
  },
  apiHint: {
    fontFamily: fonts.inter.medium,
    color: colors.inkMuted,
  },
  muted: {
    ...textStyles.body,
    color: colors.inkMuted,
  },
  inputGrid: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  field: {
    flex: 1,
    gap: spacing.xs,
  },
  fieldLabel: {
    ...textStyles.label,
  },
  input: {
    minHeight: 52,
    borderRadius: radii.control,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.rule,
    paddingHorizontal: spacing.md,
    fontFamily: fonts.inter.semibold,
    fontSize: 20,
    color: colors.ink,
  },
  results: {
    gap: spacing.md,
  },
  time: {
    ...textStyles.time,
    fontSize: 38,
  },
  rule: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.rule,
  },
  route: {
    ...textStyles.h2,
    fontSize: 20,
  },
  leg: {
    fontFamily: fonts.inter.medium,
    fontSize: 15,
    lineHeight: 21,
    color: colors.ink,
  },
});

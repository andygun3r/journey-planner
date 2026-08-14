import { useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { AppShell, Card, EmptyState, PrimaryButton, StatusChip, commonStyles } from "../components/shell";
import { BoardDeparture, BoardResponse, fetchBoard, timeLabel } from "../lib/api";
import { colors, fonts, radii, spacing, textStyles } from "../theme/tokens";

export default function BoardsScreen() {
  const [crs, setCrs] = useState("WAT");
  const [result, setResult] = useState<BoardResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!crs.trim()) return;
    setLoading(true);
    setError(null);
    try {
      setResult(await fetchBoard(crs));
    } catch {
      setResult(null);
      setError("Could not reach the Signaller backend. Check EXPO_PUBLIC_API_URL and try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AppShell>
      <Card>
        <Text style={textStyles.h1}>Departure board</Text>
        <Text style={styles.muted}>Live boards by CRS station code.</Text>
        <View style={styles.searchRow}>
          <TextInput
            autoCapitalize="characters"
            autoCorrect={false}
            value={crs}
            onChangeText={setCrs}
            placeholder="WAT"
            placeholderTextColor={colors.inkMuted}
            style={styles.input}
          />
          <View style={styles.buttonWrap}>
            <PrimaryButton label={loading ? "Loading..." : "Load"} onPress={submit} disabled={loading} />
          </View>
        </View>
      </Card>

      {error && <EmptyState title="Backend unavailable" body={error} />}

      {result?.ok === false && (
        <EmptyState
          title={boardFailureTitle(result.reason)}
          body="Signaller could not return a board for that station."
        />
      )}

      {result?.ok === true && (
        <View style={styles.results}>
          <View style={styles.boardHead}>
            <Text style={textStyles.h2}>{result.board.stationName}</Text>
            <StatusChip label={result.board.live ? "Live" : result.board.source} tone={result.board.live ? "good" : "neutral"} />
          </View>
          {result.board.departures.length === 0 ? (
            <EmptyState title="No departures" body="There are no departures in the current board window." />
          ) : (
            result.board.departures.map((departure, index) => (
              <DepartureRow key={departure.rid ?? departure.tripId ?? `${departure.scheduled}-${index}`} departure={departure} />
            ))
          )}
        </View>
      )}
    </AppShell>
  );
}

function DepartureRow({ departure }: { departure: BoardDeparture }) {
  const tone =
    departure.status === "cancelled" ? "bad" : departure.status === "delayed" ? "warn" : "good";
  return (
    <Card>
      <View style={commonStyles.row}>
        <View style={styles.departureMain}>
          <Text style={styles.time}>{timeLabel(departure.live ?? departure.scheduled)}</Text>
          <Text style={styles.destination}>{departure.destinationName}</Text>
          <Text style={styles.muted}>{departure.operator ?? "Operator unavailable"}</Text>
        </View>
        <View style={styles.platformBlock}>
          <Text style={styles.platformLabel}>Plat</Text>
          <Text style={styles.platform}>{departure.platform ?? "-"}</Text>
        </View>
      </View>
      <StatusChip label={departureStatus(departure)} tone={tone} />
    </Card>
  );
}

function departureStatus(departure: BoardDeparture): string {
  if (departure.status === "cancelled") return "Cancelled";
  if (departure.delayMinutes) return `${departure.delayMinutes} min late`;
  if (departure.status === "on-time") return "On time";
  return departure.hasLive ? "Expected" : "Scheduled";
}

function boardFailureTitle(reason: string): string {
  if (reason === "unknown-station") return "Unknown station";
  if (reason === "engine-offline") return "Board source offline";
  return "Check the station code";
}

const styles = StyleSheet.create({
  muted: {
    ...textStyles.body,
    color: colors.inkMuted,
  },
  searchRow: {
    flexDirection: "row",
    gap: spacing.sm,
    alignItems: "center",
  },
  input: {
    flex: 1,
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
  buttonWrap: {
    minWidth: 104,
  },
  results: {
    gap: spacing.md,
  },
  boardHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  departureMain: {
    flex: 1,
    gap: 2,
  },
  time: {
    ...textStyles.time,
    fontSize: 34,
  },
  destination: {
    fontFamily: fonts.archivo.bold,
    fontSize: 20,
    color: colors.ink,
  },
  platformBlock: {
    minWidth: 58,
    alignItems: "center",
    borderRadius: radii.control,
    backgroundColor: colors.railNavyTint,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  platformLabel: {
    ...textStyles.label,
    fontSize: 11,
  },
  platform: {
    fontFamily: fonts.inter.bold,
    fontSize: 24,
    color: colors.railNavy,
  },
});

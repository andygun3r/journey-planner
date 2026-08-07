import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors, radii, spacing, textStyles } from "../theme/tokens";

/**
 * Phase 0 scaffolding screen: exercises the design tokens (header band,
 * card, pill button, type hierarchy) end-to-end so the fonts -> tokens ->
 * render chain is actually proven on a device/simulator, not just
 * type-checked. Gets replaced by the real Plan screen in Phase 1.
 */
export default function PlanScreen() {
  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.wordmark}>Signaller</Text>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={textStyles.h1}>Plan a journey</Text>
        <Text style={[textStyles.body, styles.muted]}>
          apps/mobile scaffolding — Phase 0 validation screen.
        </Text>

        <View style={styles.card}>
          <Text style={textStyles.h2}>Next departure</Text>
          <Text style={[textStyles.time, styles.time]}>10:42</Text>
          <Text style={[textStyles.label, styles.label]}>On time</Text>
        </View>

        <SafeAreaView edges={["bottom"]}>
          <View style={styles.pillButton}>
            <Text style={styles.pillButtonText}>Search journeys</Text>
          </View>
        </SafeAreaView>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.platformWhite,
  },
  header: {
    backgroundColor: colors.railNavy,
    paddingTop: 56,
    paddingBottom: spacing.md,
    paddingHorizontal: spacing.md,
  },
  wordmark: {
    fontFamily: "Archivo_700Bold",
    fontSize: 22,
    color: colors.onNavy,
  },
  content: {
    padding: spacing.md,
    gap: spacing.md,
  },
  muted: {
    color: colors.inkMuted,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.card,
    padding: spacing.md,
    gap: spacing.xs,
    shadowColor: colors.railNavyDeep,
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  time: {
    fontSize: 40,
  },
  label: {
    color: colors.signalGreen,
  },
  pillButton: {
    backgroundColor: colors.railNavy,
    borderRadius: radii.pill,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.lg,
  },
  pillButtonText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 17,
    color: colors.onNavy,
  },
});

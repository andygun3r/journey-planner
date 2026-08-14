import { Link, usePathname } from "expo-router";
import { PropsWithChildren } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors, fonts, minTouchTarget, radii, spacing, textStyles } from "../theme/tokens";

const tabs = [
  { href: "/", label: "Plan" },
  { href: "/boards", label: "Boards" },
  { href: "/map", label: "Map" },
  { href: "/status", label: "Status" },
] as const;

export function AppShell({
  children,
  scroll = true,
}: PropsWithChildren<{ scroll?: boolean }>) {
  const content = scroll ? (
    <ScrollView contentContainerStyle={styles.content}>{children}</ScrollView>
  ) : (
    <View style={styles.fill}>{children}</View>
  );

  return (
    <View style={styles.root}>
      <SafeAreaView edges={["top"]} style={styles.header}>
        <Text style={styles.wordmark}>Signaller</Text>
        <Text style={styles.headerMeta}>Live rail kit for the next train decision</Text>
      </SafeAreaView>
      {content}
      <TabBar />
    </View>
  );
}

function TabBar() {
  const pathname = usePathname();
  return (
    <SafeAreaView edges={["bottom"]} style={styles.tabSafe}>
      <View style={styles.tabBar}>
        {tabs.map((tab) => {
          const active = tab.href === "/" ? pathname === "/" : pathname.startsWith(tab.href);
          return (
            <Link key={tab.href} href={tab.href} asChild>
              <Pressable style={[styles.tab, active && styles.tabActive]}>
                <Text style={[styles.tabText, active && styles.tabTextActive]}>{tab.label}</Text>
              </Pressable>
            </Link>
          );
        })}
      </View>
    </SafeAreaView>
  );
}

export function Card({ children }: PropsWithChildren) {
  return <View style={styles.card}>{children}</View>;
}

export function PrimaryButton({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, disabled && styles.buttonDisabled]}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

export function StatusChip({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: "neutral" | "good" | "warn" | "bad";
}) {
  return (
    <View style={[styles.chip, styles[`chip_${tone}`]]}>
      <Text style={[styles.chipText, styles[`chipText_${tone}`]]}>{label}</Text>
    </View>
  );
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <Card>
      <Text style={textStyles.h2}>{title}</Text>
      <Text style={styles.muted}>{body}</Text>
    </Card>
  );
}

export const commonStyles = StyleSheet.create({
  muted: {
    color: colors.inkMuted,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
  },
});

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.platformWhite,
  },
  header: {
    backgroundColor: colors.railNavy,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    gap: spacing.xs,
  },
  wordmark: {
    fontFamily: fonts.archivo.bold,
    fontSize: 24,
    color: colors.onNavy,
  },
  headerMeta: {
    fontFamily: fonts.inter.medium,
    fontSize: 13,
    color: "rgba(255,255,255,0.76)",
  },
  content: {
    padding: spacing.md,
    paddingBottom: 110,
    gap: spacing.md,
  },
  fill: {
    flex: 1,
  },
  tabSafe: {
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.rule,
  },
  tabBar: {
    flexDirection: "row",
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.sm,
    gap: spacing.xs,
  },
  tab: {
    flex: 1,
    minHeight: minTouchTarget,
    borderRadius: radii.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  tabActive: {
    backgroundColor: colors.railNavyTint,
  },
  tabText: {
    fontFamily: fonts.inter.semibold,
    fontSize: 12,
    color: colors.inkMuted,
  },
  tabTextActive: {
    color: colors.railNavy,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.card,
    padding: spacing.md,
    gap: spacing.sm,
    shadowColor: colors.railNavyDeep,
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  button: {
    backgroundColor: colors.railNavy,
    borderRadius: radii.pill,
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.lg,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonText: {
    fontFamily: fonts.inter.semibold,
    fontSize: 16,
    color: colors.onNavy,
  },
  chip: {
    alignSelf: "flex-start",
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  chip_neutral: {
    backgroundColor: colors.railNavyTint,
  },
  chip_good: {
    backgroundColor: "rgba(46,125,70,0.12)",
  },
  chip_warn: {
    backgroundColor: "rgba(160,85,0,0.12)",
  },
  chip_bad: {
    backgroundColor: "rgba(214,53,44,0.10)",
  },
  chipText: {
    fontFamily: fonts.inter.semibold,
    fontSize: 13,
  },
  chipText_neutral: {
    color: colors.railNavy,
  },
  chipText_good: {
    color: colors.signalGreen,
  },
  chipText_warn: {
    color: colors.signalAmber,
  },
  chipText_bad: {
    color: colors.signalRedDeep,
  },
  muted: {
    ...textStyles.body,
    color: colors.inkMuted,
  },
});

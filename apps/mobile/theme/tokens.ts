import { Platform, TextStyle } from "react-native";

/**
 * Design tokens mirroring DESIGN.md's frontmatter exactly. This is the one
 * source both the component kit (theme/components) and screens import
 * from — the RN equivalent of the CSS custom properties apps/web reads
 * from the same DESIGN.md values. Light only: DESIGN.md is explicit there
 * is no dark theme, so there is no second palette to branch on here.
 */

export const colors = {
  railNavy: "#1c2340",
  railNavyDeep: "#14161f",
  railNavyTint: "#e7e8ee",
  signalRed: "#d6352c",
  signalRedDeep: "#b23a2e",
  platformWhite: "#f6f4f0",
  surface: "#ffffff",
  ink: "#14161f",
  inkMuted: "#4a4e5c",
  rule: "rgba(20,22,31,0.08)",
  onNavy: "#ffffff",
  onRed: "#ffffff",
  signalGreen: "#2e7d46",
  signalAmber: "#a05500",
} as const;

export const radii = {
  control: 10,
  card: 18,
  pill: 999,
} as const;

export const spacing = {
  xs: 6,
  sm: 10,
  md: 16,
  lg: 24,
} as const;

/**
 * Font family names as registered with expo-font in theme/fonts.ts.
 * Falls back to the platform system font until useFonts() resolves —
 * see theme/fonts.ts.
 */
const archivo = {
  regular: "Archivo_500Medium",
  semibold: "Archivo_600SemiBold",
  bold: "Archivo_700Bold",
  extrabold: "Archivo_800ExtraBold",
};
const inter = {
  regular: "Inter_400Regular",
  medium: "Inter_500Medium",
  semibold: "Inter_600SemiBold",
  bold: "Inter_700Bold",
};

export const fonts = { archivo, inter };

/** Named text styles matching DESIGN.md's Display/H1/H2/Body/Time/Label hierarchy. */
export const textStyles: Record<string, TextStyle> = {
  display: {
    fontFamily: archivo.extrabold,
    fontSize: 48,
    lineHeight: 48 * 1.05,
    color: colors.ink,
  },
  h1: {
    fontFamily: archivo.bold,
    fontSize: 32,
    color: colors.ink,
  },
  h2: {
    fontFamily: archivo.bold,
    fontSize: 22,
    color: colors.ink,
  },
  body: {
    fontFamily: inter.regular,
    fontSize: 17,
    lineHeight: 17 * 1.5,
    color: colors.ink,
  },
  time: {
    fontFamily: inter.bold,
    // Tabular figures: RN honours this via fontVariant on iOS/Android.
    fontVariant: ["tabular-nums"],
    color: colors.ink,
  },
  label: {
    fontFamily: inter.semibold,
    fontSize: 13,
    letterSpacing: Platform.select({ ios: 1.3, android: 1.3, default: 1.3 }), // ~0.1em at 13px
    textTransform: "uppercase",
    color: colors.inkMuted,
  },
};

/** Minimum touch target size per PRODUCT.md's accessibility rules (WCAG 2.2 AA / iOS HIG). */
export const minTouchTarget = 44;

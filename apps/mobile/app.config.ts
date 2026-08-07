import type { ExpoConfig } from "expo/config";

/**
 * Env-driven Expo config. EXPO_PUBLIC_API_URL points the app at the
 * apps/web backend (see CLAUDE.md's "Common commands" for the local
 * default). Falls back to localhost:3000 for `pnpm --filter mobile dev`
 * against a locally running `pnpm --filter web dev`.
 */
const config: ExpoConfig = {
  name: "Signaller",
  slug: "signaller",
  version: "0.1.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  scheme: "signaller",
  userInterfaceStyle: "light",
  ios: {
    supportsTablet: true,
    bundleIdentifier: "uk.signaller.app",
  },
  android: {
    package: "uk.signaller.app",
    adaptiveIcon: {
      backgroundColor: "#1c2340",
      foregroundImage: "./assets/android-icon-foreground.png",
      backgroundImage: "./assets/android-icon-background.png",
      monochromeImage: "./assets/android-icon-monochrome.png",
    },
    predictiveBackGestureEnabled: false,
  },
  web: {
    favicon: "./assets/favicon.png",
  },
  plugins: ["expo-router", "@maplibre/maplibre-react-native"],
  extra: {
    apiUrl: process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:3000",
  },
};

export default config;

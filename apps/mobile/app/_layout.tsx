import { useEffect } from "react";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useSignallerFonts } from "../theme/fonts";

SplashScreen.preventAutoHideAsync();

/**
 * Root layout: holds the splash screen open until fonts are loaded, then
 * hands off to the route tree. Auth/theme providers land here in Phase 2
 * once @better-auth/expo is wired up (see plan Section 3) — kept minimal
 * for the Phase 0 scaffolding spike.
 */
export default function RootLayout() {
  const fontsLoaded = useSignallerFonts();

  useEffect(() => {
    if (fontsLoaded) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded]);

  if (!fontsLoaded) {
    return null;
  }

  return <Stack screenOptions={{ headerShown: false }} />;
}

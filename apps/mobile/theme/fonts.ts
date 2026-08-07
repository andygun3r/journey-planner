import {
  useFonts as useArchivoFonts,
  Archivo_500Medium,
  Archivo_600SemiBold,
  Archivo_700Bold,
  Archivo_800ExtraBold,
} from "@expo-google-fonts/archivo";
import {
  useFonts as useInterFonts,
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from "@expo-google-fonts/inter";

/**
 * Loads exactly the Archivo/Inter weights DESIGN.md's typography table
 * specifies (Archivo 500-800, Inter 400-600 + 700 for tabular time text).
 * Matches the weight list apps/web/app/layout.tsx pulls via next/font/google.
 * Returns false until both families are ready — callers should hold the
 * splash screen open until this resolves (see app/_layout.tsx).
 */
export function useSignallerFonts(): boolean {
  const [archivoLoaded] = useArchivoFonts({
    Archivo_500Medium,
    Archivo_600SemiBold,
    Archivo_700Bold,
    Archivo_800ExtraBold,
  });
  const [interLoaded] = useInterFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });
  return archivoLoaded && interLoaded;
}

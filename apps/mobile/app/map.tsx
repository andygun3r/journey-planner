import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Camera, Map, type StyleSpecification } from "@maplibre/maplibre-react-native";
import { colors, textStyles } from "../theme/tokens";
import { loadAbsoluteStyle } from "../lib/orm-style";

/**
 * Phase 0 map spike: proves the OpenRailwayMap-vector style (same source
 * apps/web/components/live-map.tsx uses) renders through MapLibre RN
 * Native rather than MapLibre GL JS. Read-only, no live train overlay yet
 * — that's Phase 1/4 per the plan.
 */
export default function MapScreen() {
  const [style, setStyle] = useState<StyleSpecification | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadAbsoluteStyle()
      .then((loaded) => {
        if (!cancelled) setStyle(loaded);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={textStyles.body}>Map failed to load: {error}</Text>
      </View>
    );
  }

  if (!style) {
    return (
      <View style={styles.center}>
        <Text style={textStyles.body}>Loading map…</Text>
      </View>
    );
  }

  return (
    <Map style={styles.map} mapStyle={style}>
      {/* Waterloo — arbitrary starting view for the spike; real default
          comes from geolocation-with-London-fallback in Phase 1/4, mirroring
          apps/web/components/live-map.tsx. */}
      <Camera initialViewState={{ center: [-0.1195, 51.5033], zoom: 12 }} />
    </Map>
  );
}

const styles = StyleSheet.create({
  map: {
    flex: 1,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.platformWhite,
    padding: 16,
  },
});

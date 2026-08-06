import type { MetadataRoute } from "next";

/** PWA manifest — makes Signaller installable as a platform tool. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Signaller — UK rail planner",
    short_name: "Signaller",
    description: "UK rail journey and commute planning, live from Darwin.",
    start_url: "/",
    display: "standalone",
    background_color: "#f4f5f8",
    theme_color: "#0033a0",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}

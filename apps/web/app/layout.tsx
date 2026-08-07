import type { Metadata, Viewport } from "next";
import { Archivo, Inter } from "next/font/google";
import Link from "next/link";
import { FocusOnNavigate } from "@/components/focus-on-navigate";
import { RegisterSW } from "@/components/register-sw";
import { TopNav } from "@/components/top-nav";
import { TabBar } from "@/components/tab-bar";
import { SignalMark } from "@/components/signal-mark";
import { getSessionUser } from "@/lib/current-user";
import { getAccessibilityPrefs } from "@/lib/accessibility-prefs";
import "./globals.css";

// Archivo: headlines, the logotype, section labels — any signage-like UI
// moment. Inter: body copy, UI labels, timetables, long-form text.
const archivo = Archivo({
  subsets: ["latin"],
  weight: ["500", "600", "700", "800"],
  variable: "--font-archivo",
  display: "swap",
});
const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Signaller",
  description: "UK rail journey and commute planning, live from Darwin.",
  applicationName: "Signaller",
  appleWebApp: { capable: true, title: "Signaller", statusBarStyle: "default" },
  icons: {
    icon: "/icon.png",
    apple: "/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#1c2340",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const sessionUser = await getSessionUser();
  const prefs = sessionUser ? await getAccessibilityPrefs(sessionUser.id) : null;
  const isAdmin = sessionUser?.role === "admin";

  return (
    <html
      lang="en-GB"
      className={`${archivo.variable} ${inter.variable}`}
      data-reduced-motion={prefs?.reducedMotion ? "true" : undefined}
      data-text-size={prefs && prefs.textSize !== "normal" ? prefs.textSize : undefined}
      data-high-contrast={prefs?.highContrast ? "true" : undefined}
      data-strengthen-cues={prefs?.strengthenCues ? "true" : undefined}
    >
      <body>
        {/*
          DIRECTION CONTRACT (Impeccable, home dashboard — apps/web/app/page.tsx)
          THESIS: a signaller's shift sheet, not a card grid — your commute
          leads at full weight, the network is a quiet log beneath it, never
          competing for attention.
          OWN-WORLD: Signaller navy/red/Archivo system, unchanged; new here is
          the log-strip rhythm (tracked labels, hairline rules, tabular rows)
          that turns "network status" from stacked cards into one scannable
          log, echoing the personal commute card's own label above it.
          STORY: glance in five seconds — is my train running; if not, what
          else; only then, is anything else on the network worth knowing.
          FIRST VIEWPORT: shift-date strip, then the full-navy commute card
          at its existing scale, unshrunk, uncompeted-with.
          FORM: dashboard-as-shift-report, candidate 7/7, seed c0916f4e.
          FINISH: unreviewed and undocumented is unfinished; this build ends
          with the finish review, the verdict, and DESIGN.md.
        */}
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <header className="topbar">
          <div className="topbar-inner">
            <Link href="/" className="wordmark" aria-label="Signaller — home">
              <SignalMark className="wordmark-mark" />
              <span className="wordmark-text">Signaller</span>
            </Link>
            <TopNav isSignedIn={sessionUser != null} isAdmin={isAdmin} />
          </div>
        </header>
        <div className="shell">
          <div id="main">{children}</div>
        </div>
        <TabBar />
        <FocusOnNavigate />
        <RegisterSW />
      </body>
    </html>
  );
}

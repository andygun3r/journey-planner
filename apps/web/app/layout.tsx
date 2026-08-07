import type { Metadata, Viewport } from "next";
import { Archivo, Inter } from "next/font/google";
import Link from "next/link";
import { FocusOnNavigate } from "@/components/focus-on-navigate";
import { RegisterSW } from "@/components/register-sw";
import { TopNav } from "@/components/top-nav";
import { TabBar } from "@/components/tab-bar";
import { SignalMark } from "@/components/signal-mark";
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB" className={`${archivo.variable} ${inter.variable}`}>
      <body>
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <header className="topbar">
          <div className="topbar-inner">
            <Link href="/" className="wordmark" aria-label="Signaller — home">
              <SignalMark className="wordmark-mark" />
              <span className="wordmark-text">Signaller</span>
            </Link>
            <TopNav />
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

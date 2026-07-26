import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import Link from "next/link";
import { FocusOnNavigate } from "@/components/focus-on-navigate";
import { RegisterSW } from "@/components/register-sw";
import { TopNav } from "@/components/top-nav";
import { TabBar } from "@/components/tab-bar";
import { ThemeToggle } from "@/components/theme-toggle";
import { DoubleArrow } from "@/components/double-arrow";
import "./globals.css";

/* Applies a saved dark-theme choice before first paint, so a returning visitor
   who picked dark never sees a light flash. Light is the default; this only
   ever adds data-theme="dark", never removes the (default) light state. */
const THEME_INIT_SCRIPT = `try{if(localStorage.getItem("mainline-theme")==="dark"){document.documentElement.dataset.theme="dark"}}catch(e){}`;

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "Mainline",
  description: "UK rail journey and commute planning, live from Darwin.",
  applicationName: "Mainline",
  appleWebApp: { capable: true, title: "Mainline", statusBarStyle: "default" },
  icons: {
    icon: "/icon.png",
    apple: "/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB" className={inter.variable}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <div className="shell">
          <header className="topbar">
            <Link href="/" className="wordmark" aria-label="Mainline — home">
              <DoubleArrow className="wordmark-mark" />
              <span className="wordmark-text">Mainline</span>
            </Link>
            <TopNav />
            <ThemeToggle />
          </header>
          <div id="main">{children}</div>
        </div>
        <TabBar />
        <FocusOnNavigate />
        <RegisterSW />
      </body>
    </html>
  );
}

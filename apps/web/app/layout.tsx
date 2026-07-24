import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Mainline",
  description: "UK rail journey and commute planning, live from Darwin.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB">
      <body>
        <div className="shell">
          <header className="topbar">
            <Link href="/" className="wordmark">
              <span className="glyph" aria-hidden="true">
                ››
              </span>
              Mainline
            </Link>
            <nav className="topnav" aria-label="Primary">
              <Link href="/">Plan a journey</Link>
              <Link href="/boards">Live departures</Link>
              <Link href="/commute">My commute</Link>
            </nav>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}

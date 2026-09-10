import type { Metadata } from "next";
import { SiteHeader } from "@/components/site-header";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Learning Guide Live",
    template: "%s · Learning Guide Live",
  },
  description:
    "Small-group discussions around philosophy, mathematical biology, and German history.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <SiteHeader />
        {children}
        <footer className="site-footer">
          <span>Learning Guide Live</span>
          <span>A place to think together.</span>
        </footer>
      </body>
    </html>
  );
}

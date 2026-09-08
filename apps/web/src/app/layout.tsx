import "@/app/globals.css";

import type { Metadata, Viewport } from "next";
import {
  DM_Mono,
  Instrument_Serif,
  Inter,
  Noto_Sans_Thai,
} from "next/font/google";
import NextTopLoader from "nextjs-toploader";

import { ServiceWorkerManager } from "@/components/pwa/service-worker-manager";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { AuthProvider } from "@/providers/auth-provider";
import { I18nProvider } from "@/providers/i18n-provider";
import { ThemeProvider } from "@/providers/theme-provider";

// Manut Brand CI §8: Inter is the product UI face; Instrument Serif is the
// brand/editorial voice (brand statements, empty-state headlines) and must
// stay out of buttons and form controls.
//
// `Inter` is the body font on every page so it stays preloaded.
// `Instrument_Serif` (brand statements on a handful of pages) and `DM_Mono`
// (small tabular cells, code) only render on a subset of routes —
// keeping them in the preload list triggered the "preloaded using
// link preload but not used within a few seconds" console warning on
// pages that don't render them (e.g. /hr-crm). Next.js still loads
// the font when its CSS variable is used; `preload: false` only
// suppresses the `<link rel="preload">` hint.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

// Noto Sans Thai covers the Thai script (Inter does not). It is composed into
// the sans stack in globals.css so Thai glyphs render in a designed face rather
// than an inconsistent per-glyph system fallback. `preload: false` keeps it off
// the critical path for English sessions.
const notoSansThai = Noto_Sans_Thai({
  subsets: ["thai"],
  variable: "--font-thai",
  weight: ["400", "500", "600", "700"],
  preload: false,
});

const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  variable: "--font-serif",
  weight: "400",
  preload: false,
});

const dmMono = DM_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  weight: "400",
  preload: false,
});

export const metadata: Metadata = {
  title: "Manut — Think better with AI",
  description: "AI-driven intelligence workspace",
  applicationName: "Manut",
  // Declared once, here, for every route — Next merges metadata down the tree,
  // so repeating any of this in a nested layout would only risk divergence.
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [{ url: "/favicon.ico", type: "image/x-icon" }],
    // iOS ignores the manifest's icon list and reads this instead.
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
  appleWebApp: {
    capable: true,
    title: "Manut",
    // `default` keeps the iOS status bar readable against the paper/white
    // surface. `black-translucent` would paint the page under the status bar,
    // which needs a per-page safe-area treatment the app does not have yet.
    statusBarStyle: "default",
  },
  // An installed app is not a web page to be indexed, and this is an internal
  // tool on a private URL regardless.
  formatDetection: { telephone: false },
  other: {
    // `appleWebApp.capable` above makes Next emit the standardised
    // `mobile-web-app-capable`, which iOS honours from 17.4. Below that it only
    // reads the vendor-prefixed tag, and without it an older iPhone installs
    // the app but opens it inside Safari chrome instead of standalone. Emitted
    // explicitly because Next no longer does.
    "apple-mobile-web-app-capable": "yes",
  },
};

/**
 * Until this existed, no viewport meta tag was emitted at all, so mobile
 * browsers laid the app out in a ~980px virtual viewport and then scaled it
 * down. Every `sm:`/`md:` breakpoint in the codebase was therefore evaluated
 * against the wrong width — the app was not "not responsive", it was being
 * measured wrongly.
 *
 * `viewportFit: "cover"` lets the page paint into the display cutout area and
 * is what makes `env(safe-area-inset-*)` return non-zero, which the shell and
 * the sticky action bars rely on.
 *
 * `maximumScale` and `userScalable` are deliberately left at their defaults:
 * blocking pinch-zoom is an accessibility failure (WCAG 1.4.4).
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  /**
   * Colours the Android browser UI and the installed app's title bar. Two
   * entries so it tracks the theme: the manifest can only carry one value, but
   * the meta tag accepts a media query, and a light status bar over the dark
   * theme looks broken.
   *
   * Values are the resolved `--surface` token for each theme — the topbar sits
   * on that surface, so the browser chrome continues it.
   */
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#181817" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn(
        instrumentSerif.variable,
        dmMono.variable,
        "font-sans",
        inter.variable,
        notoSansThai.variable,
      )}
    >
      <body>
        <NextTopLoader
          color="#5B5BD6"
          initialPosition={0.08}
          crawlSpeed={200}
          height={3}
          crawl={true}
          showSpinner={false}
          easing="ease"
          speed={200}
          shadow="0 0 10px rgba(91, 91, 214, 0.5), 0 0 5px rgba(91, 91, 214, 0.5)"
        />
        <ThemeProvider>
          <TooltipProvider>
            <I18nProvider>
              <AuthProvider>{children}</AuthProvider>
            </I18nProvider>
            <ServiceWorkerManager />
            <Toaster richColors />
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}

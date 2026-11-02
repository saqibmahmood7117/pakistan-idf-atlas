import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

const geistSans = localFont({
  src: "./fonts/Geist-Latin.woff2",
  variable: "--font-geist-sans",
  weight: "100 900",
  display: "swap",
});

const geistMono = localFont({
  src: "./fonts/GeistMono-Latin.woff2",
  variable: "--font-geist-mono",
  weight: "100 900",
  display: "swap",
});

const deploymentHost =
  process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;

export const metadata: Metadata = {
  metadataBase: new URL(
    deploymentHost ? `https://${deploymentHost}` : "http://localhost:3000",
  ),
  title: "Pakistan IDF Atlas",
  description: "Observed and live online precipitation extraction, stationary and nonstationary IDF curves, uncertainty, and source metadata for Pakistan.",
  openGraph: {
    type: "website",
    title: "Pakistan IDF Atlas",
    description:
      "Observed, online and CMIP6 rainfall analysis for stationary and nonstationary IDF curves across Pakistan.",
    images: [{ url: "/og.png", width: 1672, height: 941, alt: "Pakistan IDF Atlas" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Pakistan IDF Atlas",
    description:
      "Observed, online and CMIP6 rainfall analysis for stationary and nonstationary IDF curves across Pakistan.",
    images: ["/og.png"],
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}

import type { Metadata, Viewport } from "next";
import Script from "next/script";
import "./globals.css";
import WalletProvider from "@/components/WalletProvider";
import TelegramProvider from "@/components/TelegramProvider";

export const metadata: Metadata = {
  title: "AI Asset Manager | Solana",
  description: "Autonomous AI agent managing assets on Solana blockchain",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet" />
        <Script
          src="https://telegram.org/js/telegram-web-app.js"
          strategy="beforeInteractive"
        />
      </head>
      <body>
        <TelegramProvider>
          <WalletProvider>{children}</WalletProvider>
        </TelegramProvider>
      </body>
    </html>
  );
}

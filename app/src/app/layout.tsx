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

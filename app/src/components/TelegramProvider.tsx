"use client";

import React, { createContext, useContext, useEffect, useState, useCallback } from "react";

// ==================== TELEGRAM WEBAPP TYPES ====================

interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
}

interface TelegramThemeParams {
  bg_color?: string;
  text_color?: string;
  hint_color?: string;
  link_color?: string;
  button_color?: string;
  button_text_color?: string;
  secondary_bg_color?: string;
  header_bg_color?: string;
  accent_text_color?: string;
  section_bg_color?: string;
  section_header_text_color?: string;
  subtitle_text_color?: string;
  destructive_text_color?: string;
}

interface MainButton {
  text: string;
  color: string;
  textColor: string;
  isVisible: boolean;
  isActive: boolean;
  isProgressVisible: boolean;
  setText: (text: string) => void;
  onClick: (cb: () => void) => void;
  offClick: (cb: () => void) => void;
  show: () => void;
  hide: () => void;
  enable: () => void;
  disable: () => void;
  showProgress: (leaveActive?: boolean) => void;
  hideProgress: () => void;
  setParams: (params: { text?: string; color?: string; text_color?: string; is_active?: boolean; is_visible?: boolean }) => void;
}

interface BackButton {
  isVisible: boolean;
  onClick: (cb: () => void) => void;
  offClick: (cb: () => void) => void;
  show: () => void;
  hide: () => void;
}

interface HapticFeedback {
  impactOccurred: (style: "light" | "medium" | "heavy" | "rigid" | "soft") => void;
  notificationOccurred: (type: "error" | "success" | "warning") => void;
  selectionChanged: () => void;
}

interface TelegramWebApp {
  initData: string;
  initDataUnsafe: {
    query_id?: string;
    user?: TelegramUser;
    auth_date?: number;
    hash?: string;
    start_param?: string;
  };
  version: string;
  platform: string;
  colorScheme: "light" | "dark";
  themeParams: TelegramThemeParams;
  isExpanded: boolean;
  viewportHeight: number;
  viewportStableHeight: number;
  headerColor: string;
  backgroundColor: string;
  isClosingConfirmationEnabled: boolean;
  MainButton: MainButton;
  BackButton: BackButton;
  HapticFeedback: HapticFeedback;
  ready: () => void;
  expand: () => void;
  close: () => void;
  enableClosingConfirmation: () => void;
  disableClosingConfirmation: () => void;
  setHeaderColor: (color: string) => void;
  setBackgroundColor: (color: string) => void;
  onEvent: (event: string, cb: () => void) => void;
  offEvent: (event: string, cb: () => void) => void;
  sendData: (data: string) => void;
  openLink: (url: string, options?: { try_instant_view?: boolean }) => void;
  openTelegramLink: (url: string) => void;
  showAlert: (message: string, cb?: () => void) => void;
  showConfirm: (message: string, cb?: (confirmed: boolean) => void) => void;
  showPopup: (params: { title?: string; message: string; buttons?: { id?: string; type?: string; text?: string }[] }, cb?: (id: string) => void) => void;
}

declare global {
  interface Window {
    Telegram?: {
      WebApp: TelegramWebApp;
    };
  }
}

// ==================== CONTEXT ====================

interface TelegramContextType {
  webApp: TelegramWebApp | null;
  user: TelegramUser | null;
  isTelegram: boolean;
  isReady: boolean;
  colorScheme: "light" | "dark";
  haptic: HapticFeedback | null;
  mainButton: MainButton | null;
  backButton: BackButton | null;
  platform: string;
  viewportHeight: number;
  expand: () => void;
  close: () => void;
  showAlert: (message: string) => void;
  showConfirm: (message: string) => Promise<boolean>;
  openLink: (url: string) => void;
}

const TelegramContext = createContext<TelegramContextType>({
  webApp: null,
  user: null,
  isTelegram: false,
  isReady: false,
  colorScheme: "dark",
  haptic: null,
  mainButton: null,
  backButton: null,
  platform: "unknown",
  viewportHeight: 0,
  expand: () => {},
  close: () => {},
  showAlert: () => {},
  showConfirm: async () => false,
  openLink: () => {},
});

export const useTelegram = () => useContext(TelegramContext);

// ==================== PROVIDER ====================

export default function TelegramProvider({ children }: { children: React.ReactNode }) {
  const [webApp, setWebApp] = useState<TelegramWebApp | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [viewportHeight, setViewportHeight] = useState(0);

  useEffect(() => {
    // Check if running inside Telegram WebApp
    const tg = window.Telegram?.WebApp;
    if (tg) {
      setWebApp(tg);

      // Tell Telegram the app is ready
      tg.ready();

      // Expand to full height
      tg.expand();

      // Set dark theme colors
      tg.setHeaderColor("#0f1117");
      tg.setBackgroundColor("#0f1117");

      // Enable closing confirmation (prevent accidental close)
      tg.enableClosingConfirmation();

      // Track viewport height
      setViewportHeight(tg.viewportStableHeight || tg.viewportHeight || window.innerHeight);

      const handleViewportChange = () => {
        setViewportHeight(tg.viewportStableHeight || tg.viewportHeight);
      };
      tg.onEvent("viewportChanged", handleViewportChange);

      setIsReady(true);

      return () => {
        tg.offEvent("viewportChanged", handleViewportChange);
      };
    } else {
      // Not in Telegram — still mark as ready for regular browser use
      setIsReady(true);
      setViewportHeight(window.innerHeight);
    }
  }, []);

  const isTelegram = !!webApp;
  const user = webApp?.initDataUnsafe?.user || null;

  const expand = useCallback(() => { webApp?.expand(); }, [webApp]);
  const close = useCallback(() => { webApp?.close(); }, [webApp]);

  const showAlert = useCallback((message: string) => {
    if (webApp) {
      webApp.showAlert(message);
    } else {
      alert(message);
    }
  }, [webApp]);

  const showConfirm = useCallback((message: string): Promise<boolean> => {
    return new Promise((resolve) => {
      if (webApp) {
        webApp.showConfirm(message, (confirmed) => resolve(!!confirmed));
      } else {
        resolve(confirm(message));
      }
    });
  }, [webApp]);

  const openLink = useCallback((url: string) => {
    if (webApp) {
      webApp.openLink(url);
    } else {
      window.open(url, "_blank");
    }
  }, [webApp]);

  return (
    <TelegramContext.Provider
      value={{
        webApp,
        user,
        isTelegram,
        isReady,
        colorScheme: webApp?.colorScheme || "dark",
        haptic: webApp?.HapticFeedback || null,
        mainButton: webApp?.MainButton || null,
        backButton: webApp?.BackButton || null,
        platform: webApp?.platform || "browser",
        viewportHeight,
        expand,
        close,
        showAlert,
        showConfirm,
        openLink,
      }}
    >
      {children}
    </TelegramContext.Provider>
  );
}

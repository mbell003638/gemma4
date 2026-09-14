// Must be first: Hermes has no Web Crypto, and every sync key, nonce and
// pairing secret is generated through crypto.getRandomValues.
import "@/src/utils/cryptoPolyfill";
import { Stack, useRouter } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect, useState } from "react";
import { AppState, LogBox, View, Platform, useWindowDimensions, Text, ScrollView, FlatList, SectionList, Pressable , Image, Animated } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";


import { ThemeProvider, useTheme, useThemeMode } from "@/src/context/ThemeContext";
import { OnboardingGateProvider, useOnboardingGate } from "@/src/context/OnboardingContext";
import { initStorage } from "@/src/db/backend";
import { requireAuth } from "@/src/utils/lock";
import { scheduleBackgroundLock } from "@/src/utils/systemPrompt";
import { api } from "@/src/api";
import { installAssistantLinkingHandlers } from "@/src/utils/assistantLinking";
import { setAssistantSessionState } from "@/src/utils/assistantSessionState";


// Keep scrolling functional while removing platform scrollbar chrome globally.
// Individual screens can still opt in explicitly if a visible indicator is needed.
[ScrollView, FlatList, SectionList].forEach((ScrollComponent) => {
  const component = ScrollComponent as any;
  component.defaultProps = {
    ...component.defaultProps,
    showsVerticalScrollIndicator: false,
    showsHorizontalScrollIndicator: false,
  };
});
// Only touch LogBox in development. `ignoreAllLogs(true)` previously ran in
// release too, hiding every warning from real users. In dev we suppress
// nothing by default; add targeted strings below when a known-benign warning
// is too noisy, e.g. LogBox.ignoreLogs(["Require cycle:", "Setting a timer"]).
// Never ignore all logs, and never call LogBox outside this __DEV__ guard.
if (__DEV__) {
  LogBox.ignoreLogs([]);
}
SplashScreen.preventAutoHideAsync().catch(() => {});

// ---------- Error Boundary ----------
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <View style={{ flex: 1, backgroundColor: "#1C4030", justifyContent: "center", padding: 24 }}>
          <Text style={{ color: "#fff", fontSize: 20, fontWeight: "700", marginBottom: 12 }}>
            Ledgr crashed on startup
          </Text>
          <ScrollView style={{ maxHeight: 300, backgroundColor: "rgba(0,0,0,0.3)", borderRadius: 8, padding: 12 }}>
            <Text style={{ color: "#EE7C6E", fontSize: 13, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" }}>
              {this.state.error.message}
            </Text>
            {__DEV__ ? (
              <Text style={{ color: "#ccc", fontSize: 11, marginTop: 8, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" }}>
                {this.state.error.stack?.slice(0, 800)}
              </Text>
            ) : null}
          </ScrollView>
          <Pressable
            onPress={() => this.setState({ error: null })}
            style={{ marginTop: 16, padding: 14, backgroundColor: "#4A6E5C", borderRadius: 8, alignItems: "center" }}
          >
            <Text style={{ color: "#fff", fontWeight: "600" }}>Try Again</Text>
          </Pressable>
        </View>
      );
    }
    return this.props.children;
  }
}

// ---------- Themed Stack ----------
function ThemedStack() {
  const theme = useTheme();
  const { effective } = useThemeMode();
  const { ready: onboardingReady, hasOnboarded } = useOnboardingGate();
  const { width } = useWindowDimensions();
  const isWideWeb = Platform.OS === "web" && width >= 768;
  if (!onboardingReady) return <AppOpeningSplashScreen />;
  return (
    <View style={{ flex: 1, backgroundColor: isWideWeb ? theme.color.surfaceTertiary : theme.color.surface, alignItems: "center" }}>
      <StatusBar style={effective === "dark" ? "light" : "dark"} />
      <View
        style={{
          flex: 1,
          width: "100%",
          maxWidth: isWideWeb ? 440 : undefined,
          backgroundColor: theme.color.surface,
          shadowColor: "#000",
          shadowOffset: { width: 0, height: 0 },
          shadowOpacity: isWideWeb ? 0.08 : 0,
          shadowRadius: isWideWeb ? 24 : 0,
          elevation: isWideWeb ? 8 : 0,
        }}
        >
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.color.surface } }}>
        <Stack.Protected guard={hasOnboarded}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="supplier/[id]" options={{ presentation: "card" }} />
        <Stack.Screen name="investor/[id]" options={{ presentation: "card" }} />
        <Stack.Screen name="bill-form" options={{ presentation: "modal" }} />
        <Stack.Screen name="party-form" options={{ presentation: "modal" }} />
        <Stack.Screen name="sale-form" options={{ presentation: "modal" }} />
        <Stack.Screen name="sales" options={{ presentation: "card" }} />
        <Stack.Screen name="cashbook" options={{ presentation: "card" }} />
        <Stack.Screen name="assets" options={{ presentation: "card" }} />
        <Stack.Screen name="payment-form" options={{ presentation: "modal" }} />
        <Stack.Screen name="receipt-form" options={{ presentation: "modal" }} />
        <Stack.Screen name="payments" options={{ presentation: "card" }} />
        <Stack.Screen name="inventory-form" options={{ presentation: "modal" }} />
        <Stack.Screen name="voice" options={{ presentation: "modal", animation: "slide_from_bottom" }} />
        <Stack.Screen name="monthly-summary" options={{ presentation: "card" }} />
        <Stack.Screen name="custom-report" options={{ presentation: "card" }} />
        <Stack.Screen name="reconcile" options={{ presentation: "card" }} />
        <Stack.Screen name="scan-import" options={{ presentation: "card" }} />
        <Stack.Screen name="invoices" options={{ presentation: "card" }} />
        <Stack.Screen name="quotes" options={{ presentation: "card" }} />
        <Stack.Screen name="delivery-notes" options={{ presentation: "card" }} />
        <Stack.Screen name="receipts" options={{ presentation: "card" }} />
        <Stack.Screen name="expenses" options={{ presentation: "card" }} />
        <Stack.Screen name="customer/[id]" options={{ presentation: "card" }} />
        <Stack.Screen name="debtors" options={{ presentation: "card" }} />
        <Stack.Screen name="daybook" options={{ presentation: "card" }} />
        <Stack.Screen name="ask" options={{ presentation: "card" }} />
        <Stack.Screen name="customize-features" options={{ presentation: "card" }} />
        <Stack.Screen name="workflows" options={{ presentation: "card" }} />
        <Stack.Screen name="book-health" options={{ presentation: "card" }} />
        <Stack.Screen name="backup-recovery" options={{ presentation: "card" }} />
        <Stack.Screen name="experimental-modules" options={{ presentation: "card" }} />
        <Stack.Screen name="bank-import-preview" options={{ presentation: "card" }} />
        <Stack.Screen name="sync-settings" options={{ presentation: "card" }} />
        <Stack.Screen name="self-host-guide" options={{ presentation: "card" }} />
        <Stack.Screen name="sync-conflicts" options={{ presentation: "card" }} />
        <Stack.Screen name="sync-conflict-correction" options={{ presentation: "card" }} />
        <Stack.Screen name="privacy-data" options={{ presentation: "card" }} />
        <Stack.Screen name="payroll" options={{ presentation: "card" }} />
        <Stack.Screen name="products" options={{ presentation: "card" }} />
        <Stack.Screen name="locations" options={{ presentation: "card" }} />
        </Stack.Protected>
        <Stack.Protected guard={!hasOnboarded}>
          <Stack.Screen name="onboarding" options={{ presentation: "card", gestureEnabled: false }} />
        </Stack.Protected>
        </Stack>
      </View>
    </View>
  );
}

function AppOpeningSplashScreen() {
  const scaleAnim = React.useRef(new Animated.Value(0.92)).current;
  const opacityAnim = React.useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacityAnim, { toValue: 1, duration: 350, useNativeDriver: true }),
      Animated.spring(scaleAnim, { toValue: 1, friction: 7, tension: 50, useNativeDriver: true }),
    ]).start();
  }, [opacityAnim, scaleAnim]);

  return (
    <View style={{ flex: 1, backgroundColor: "#0A0A0C", justifyContent: "center", alignItems: "center", paddingHorizontal: 24 }}>
      <Animated.View style={{ alignItems: "center", opacity: opacityAnim, transform: [{ scale: scaleAnim }] }}>
        {/* Official App Icon (Green Neon Dollar Emblem) */}
        <View
          style={{
            width: 100,
            height: 100,
            borderRadius: 24,
            overflow: "hidden",
            marginBottom: 24,
            shadowColor: "#22c55e",
            shadowOffset: { width: 0, height: 6 },
            shadowOpacity: 0.45,
            shadowRadius: 16,
            elevation: 10,
            borderWidth: 1,
            borderColor: "rgba(34, 197, 94, 0.3)",
          }}
        >
          <Image
            source={require("@/assets/images/icon.png")}
            style={{ width: 100, height: 100, borderRadius: 24 }}
            resizeMode="cover"
          />
        </View>

        {/* Title matching Image 1: Ledgr */}
        <Text style={{ fontSize: 34, fontWeight: "800", color: "#FFFFFF", letterSpacing: -0.5 }}>
          Ledgr
        </Text>

        {/* Subtitle matching Image 1: Your business finances, simplified */}
        <Text style={{ fontSize: 14, fontWeight: "400", color: "#94A3B8", marginTop: 6, letterSpacing: 0.2 }}>
          Your business finances, simplified
        </Text>
      </Animated.View>
    </View>
  );
}

// ---------- Root Layout ----------
function WebScrollbarStyles() {
  if (Platform.OS !== "web") return null;
  return React.createElement("style", {
    dangerouslySetInnerHTML: {
      __html: `
        html, body, #root, #root *, body > div, body > div * {
          scrollbar-width: none !important;
          -ms-overflow-style: none !important;
        }
        html::-webkit-scrollbar, body::-webkit-scrollbar,
        #root::-webkit-scrollbar, #root *::-webkit-scrollbar,
        body > div::-webkit-scrollbar, body > div *::-webkit-scrollbar {
          width: 0 !important;
          height: 0 !important;
          display: none !important;
          background: transparent !important;
        }
      `,
    },
  } as any);
}

export default function RootLayout() {

  const router = useRouter();
  const [storageReady, setStorageReady] = useState(false);
  const [unlocked, setUnlocked] = useState(Platform.OS === "web");
  const [unlocking, setUnlocking] = useState(false);
  const shouldUnlockOnActive = React.useRef(false);
  const backgroundLockTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setAssistantSessionState({ storageReady, unlocked });
    return () => setAssistantSessionState({ storageReady: false, unlocked: false });
  }, [storageReady, unlocked]);

  const attemptUnlock = React.useCallback(async () => {
    if (Platform.OS === "web") {
      setUnlocked(true);
      return;
    }
    setUnlocking(true);
    const ok = await requireAuth("Unlock Ledgr");
    setUnlocked(ok);
    setUnlocking(false);
  }, []);

  useEffect(() => {
    let cancelled = false;

    // Replace the native splash immediately with the in-app opening screen.
    SplashScreen.hideAsync().catch(() => {});

    // Do not mount the router until the persisted active book and SQLite
    // backend are ready. Otherwise the onboarding gate can read the temporary
    // AsyncStorage fallback and incorrectly treat a returning user as new.
    initStorage()
      .catch(() => {})
      .finally(() => {
        if (!cancelled) {
          setStorageReady(true);
          // Sync is strictly best-effort: startup and offline-only use never
          // wait on a server or fail because the endpoint is unavailable.
          void api.syncNow().catch(() => {});
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!storageReady || !unlocked) return;
    return installAssistantLinkingHandlers({
      onResult: (result) => {
        if (result.kind === 'navigation') { router.push(result.target === 'scanner' ? '/scan-import' : result.target === 'voice' ? '/voice' : '/ask'); return; }
        if (result.kind === 'draft') { router.push({ pathname: '/ask', params: { assistantDraft: JSON.stringify(result.draft) } }); }
      },
      onError: (error) => console.warn('Assistant link handling failed', error),
    });
  }, [router, storageReady, unlocked]);

  useEffect(() => {
    if (!storageReady) return;
    attemptUnlock();
    if (Platform.OS === "web") return;

    const cancelPendingBackgroundLock = () => {
      if (backgroundLockTimer.current) {
        clearTimeout(backgroundLockTimer.current);
        backgroundLockTimer.current = null;
      }
    };

    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "background") {
        // Permission, picker, and biometric sheets are owned by Android and
        // can briefly background the activity. Debounce the lock so their
        // immediate matching `active` event can cancel it.
        cancelPendingBackgroundLock();
        backgroundLockTimer.current = scheduleBackgroundLock(
          () => AppState.currentState,
          () => {
            backgroundLockTimer.current = null;
            shouldUnlockOnActive.current = true;
            setUnlocked(false);
          },
        );
        return;
      }
      if (state === "active") {
        cancelPendingBackgroundLock();
        void api.syncNow().catch(() => {});
        if (shouldUnlockOnActive.current) {
          shouldUnlockOnActive.current = false;
          attemptUnlock();
        }
      }
    });
    return () => {
      cancelPendingBackgroundLock();
      subscription.remove();
    };
  }, [attemptUnlock, storageReady]);

  if (!storageReady) {
    return <AppOpeningSplashScreen />;
  }
  if (!unlocked) {
    return (
      <View style={{ flex: 1, backgroundColor: "#0A0A0C", justifyContent: "center", alignItems: "center", padding: 32 }}>
        <Image source={require("@/assets/images/icon.png")} style={{ width: 88, height: 88, borderRadius: 22, marginBottom: 24 }} />
        <Text style={{ color: "#FFFFFF", fontSize: 28, fontWeight: "800", marginBottom: 8 }}>Ledgr is locked</Text>
        <Text style={{ color: "#94A3B8", fontSize: 14, textAlign: "center", marginBottom: 24 }}>
          Use your device lock to access your accounting data.
        </Text>
        <Pressable
          disabled={unlocking}
          onPress={attemptUnlock}
          style={{ minWidth: 180, padding: 14, borderRadius: 12, alignItems: "center", backgroundColor: "#98C7A9", opacity: unlocking ? 0.65 : 1 }}
        >
          <Text style={{ color: "#102018", fontSize: 16, fontWeight: "700" }}>{unlocking ? "Unlocking…" : "Unlock Ledgr"}</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <ErrorBoundary>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider>
          <ThemeProvider>
            <OnboardingGateProvider>
              <WebScrollbarStyles />
              <ThemedStack />
            </OnboardingGateProvider>
          </ThemeProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </ErrorBoundary>
  );
}

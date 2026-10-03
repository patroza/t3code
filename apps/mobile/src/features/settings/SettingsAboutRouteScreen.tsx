import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import Constants from "expo-constants";
import * as Updates from "expo-updates";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import {
  type AppUpdateCheckState,
  isAppUpdateCheckAvailable,
  registerHiddenUpdateTap,
  runAppUpdateCheck,
} from "../updates/app-updates";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsScreen } from "./components/SettingsScreen";

export function SettingsAboutRouteScreen() {
  const insets = useSafeAreaInsets();

  return (
    <SettingsScreen title="About T3 Code">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <AppSettingsSection />
      </ScrollView>
    </SettingsScreen>
  );
}

function AppSettingsSection() {
  const [updateState, setUpdateState] = useState<AppUpdateCheckState>("idle");
  const updateInFlight = useRef(false);
  const hiddenUpdateTapCount = useRef(0);

  const version = Constants.expoConfig?.version ?? "0.0.0";
  // Fall back to "production" to match resolveAppVariant in app.config.ts, so a
  // missing variant never mislabels a production build as development.
  const variant = (Constants.expoConfig?.extra?.appVariant as string | undefined) ?? "production";
  const variantLabel = variant === "production" ? "" : capitalize(variant);
  const versionLabel = variantLabel ? `${version} · ${variantLabel}` : version;
  // Which JS is actually running: the bundle shipped in the binary, or an OTA
  // update downloaded on top of it. Surfacing this makes "am I even on the
  // right build?" answerable at a glance.
  const bundleLabel = Updates.isEnabled
    ? Updates.isEmbeddedLaunch
      ? "Embedded"
      : Updates.updateId
        ? `OTA ${Updates.updateId.slice(0, 7)}`
        : null
    : null;
  const updateCheckAvailable = isAppUpdateCheckAvailable();
  const busy =
    updateState === "checking" || updateState === "downloading" || updateState === "restarting";

  // "Up to date" is a transient acknowledgement, not a state worth persisting —
  // drop back to the bundle label so the row keeps answering "what am I running?".
  useEffect(() => {
    if (updateState !== "current") return;
    const timer = setTimeout(() => setUpdateState("idle"), 3000);
    return () => clearTimeout(timer);
  }, [updateState]);

  const checkForUpdate = useCallback(async () => {
    // `disabled={busy}` only takes effect on the next render, so two taps in the
    // same frame would both get through. The ref closes that window.
    if (updateInFlight.current) return;
    updateInFlight.current = true;
    try {
      // The user asked for this restart by tapping the version row, so it may
      // apply immediately instead of prompting.
      await runAppUpdateCheck({
        applyMode: "immediate",
        onFailure: (message) => Alert.alert("Update failed", message),
        onStateChange: setUpdateState,
      });
    } finally {
      updateInFlight.current = false;
    }
  }, []);

  const handleVersionPress = useCallback(() => {
    if (!updateCheckAvailable || updateInFlight.current) return;
    const tap = registerHiddenUpdateTap(hiddenUpdateTapCount.current);
    hiddenUpdateTapCount.current = tap.nextCount;
    if (tap.shouldCheck) {
      void checkForUpdate();
    }
  }, [checkForUpdate, updateCheckAvailable]);

  const statusLabel =
    updateState === "checking"
      ? "Checking…"
      : updateState === "downloading"
        ? "Downloading…"
        : // "ready" appears only when this check joined an in-flight background-mode
          // check; that download installs at the next backgrounding.
          updateState === "ready"
          ? "Update ready"
          : updateState === "restarting"
            ? "Restarting…"
            : updateState === "current"
              ? "Up to date"
              : bundleLabel;

  const versionRow = (
    <View className="flex-row items-center gap-4 p-4">
      <SymbolView
        name="info.circle"
        size={22}
        tintColorClassName="accent-icon"
        type="monochrome"
        weight="regular"
      />
      <Text className="flex-1 text-lg text-foreground">Version</Text>
      <View className="items-end">
        <Text className="text-lg text-foreground-muted">{versionLabel}</Text>
        {statusLabel ? (
          <Text className="text-xs text-foreground-muted/70">{statusLabel}</Text>
        ) : null}
      </View>
      {Updates.isEnabled ? (
        <View className="w-[22px] items-center">
          {busy ? (
            <ActivityIndicator colorClassName="accent-icon" size="small" />
          ) : (
            <SymbolView
              name="arrow.clockwise"
              size={18}
              tintColorClassName="accent-icon"
              type="monochrome"
              weight="semibold"
            />
          )}
        </View>
      ) : null}
    </View>
  );

  return (
    <SettingsSection title="App">
      <SettingsRow icon="internaldrive" label="Client Storage" target="SettingsClientStorage" />
      <SettingsRow icon="stethoscope" label="Diagnostics" target="SettingsDiagnostics" />
      <SettingsRow
        icon="doc.on.doc"
        label="Open source licenses"
        target="SettingsOpenSourceLicenses"
      />
      <SettingsRow icon="doc.text" label="Legal" fullScreenTarget="SettingsLegal" />
      {updateCheckAvailable ? (
        <Pressable
          accessibilityLabel={`Version ${versionLabel}`}
          accessibilityRole="text"
          disabled={busy}
          onPress={handleVersionPress}
        >
          {versionRow}
        </Pressable>
      ) : (
        versionRow
      )}
    </SettingsSection>
  );
}

function capitalize(value: string): string {
  return value.length > 0 ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

import { useRecyclingState } from "@legendapp/list/react-native";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentThreadSearchMatch } from "@t3tools/client-runtime/state/thread-search";
import type { MenuAction } from "@react-native-menu/menu";
import { SymbolView } from "../../components/AppSymbol";
import { memo, useCallback, useMemo, type ComponentProps } from "react";
import { Platform, Pressable, useWindowDimensions, View } from "react-native";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import Svg, { Circle, Path } from "react-native-svg";

import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { ProviderUsageIcon } from "../../components/ProviderUsageIcon";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/time";
import { themeColorWithAlpha } from "../../lib/mobileTheme";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useEnvironmentServerConfig } from "../../state/entities";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { prefetchEnvironmentThread } from "../../state/threads";
import { useAiUsageSnapshot } from "../../state/useAiUsageSnapshot";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import { useThreadPr, type ThreadPr } from "../../state/use-thread-pr";
import { composerDraftsAtom, hasComposerDraftMessage } from "../../state/use-composer-drafts";
import type { HomeGroupDisplayAction } from "../home/homeListItems";
import { ThreadSwipeable } from "../home/thread-swipe-actions";
import { buildThreadTitleRegenerationMenuItems } from "./thread-title-regeneration-menu";
import { ThreadIdentityMark } from "../identity/ParticipantStack";
import { resolveSettledRowTimestamp, resolveThreadStatus } from "./threadPresentation";
import { ThreadSearchMatchExcerpt } from "./thread-search-match";
import {
  hasUsageMarker,
  resolveDriverUsage,
} from "@t3tools/client-runtime/state/aiUsagePresentation";
import type { ProviderDriverKind } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";

/**
 * Shared presentation for the thread lists: the compact (phone) Home list and
 * the iPad sidebar render the SAME items — group headers with collapse,
 * thread rows with status/PR/subtitle, and show-more rows — differing only in
 * metrics and chrome via `variant`.
 */
export type ThreadListVariant = "compact" | "sidebar";

/** Left inset that aligns compact secondary rows with the title column. */
export const THREAD_LIST_COMPACT_INSET = 20;
const SIDEBAR_ROW_RADIUS = 12;

const MONO_FONT = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "monospace",
});

function pullRequestTintColor(state: ThreadPr["state"], colorScheme: "light" | "dark") {
  const dark = colorScheme === "dark";
  switch (state) {
    case "open":
      return dark ? "#34d399" : "#059669";
    case "merged":
      return dark ? "#a78bfa" : "#7c3aed";
    case "closed":
      return dark ? "#a1a1aa" : "#71717a";
  }
}

function PullRequestIcon(props: { readonly size: number; readonly color: string }) {
  return (
    <Svg
      width={props.size}
      height={props.size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={props.color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <Circle cx={18} cy={18} r={3} />
      <Circle cx={6} cy={6} r={3} />
      <Path d="M13 6h3a2 2 0 0 1 2 2v7" />
      <Path d="M6 9v12" />
    </Svg>
  );
}

/* ─── Section header (Needs attention) ───────────────────────────────── */

/**
 * Non-collapsible section label for the cross-project Needs attention block.
 */
export const ThreadListSectionHeader = memo(function ThreadListSectionHeader(props: {
  readonly variant: ThreadListVariant;
  readonly title: string;
}) {
  const compact = props.variant === "compact";
  return (
    <View
      className={compact ? "bg-screen" : undefined}
      style={{
        paddingLeft: compact ? THREAD_LIST_COMPACT_INSET : 12,
        paddingRight: compact ? 18 : 12,
        paddingTop: compact ? 8 : 4,
        paddingBottom: compact ? 6 : 4,
      }}
    >
      <Text
        className={
          compact
            ? "text-xs font-t3-bold uppercase tracking-wider text-foreground-tertiary"
            : "text-3xs font-t3-bold uppercase tracking-wider text-foreground-tertiary"
        }
      >
        {props.title}
      </Text>
    </View>
  );
});

/* ─── Project group header ───────────────────────────────────────────── */

export const ThreadListGroupHeader = memo(function ThreadListGroupHeader(props: {
  readonly variant: ThreadListVariant;
  readonly project: EnvironmentProject;
  readonly title: string;
  readonly threadCount: number;
  readonly collapsed: boolean;
  readonly isFirst: boolean;
  readonly groupKey: string;
  readonly onGroupAction: (key: string, action: HomeGroupDisplayAction) => void;
  /** Project a quick new thread should target; null hides the button. */
  readonly newThreadTarget?: EnvironmentProject | null;
  readonly onNewThread?: (project: EnvironmentProject) => void;
}) {
  const { groupKey, onGroupAction, onNewThread } = props;
  const newThreadTarget = props.newThreadTarget ?? null;
  const compact = props.variant === "compact";
  const handleToggle = useCallback(
    () => onGroupAction(groupKey, "toggle-collapsed"),
    [groupKey, onGroupAction],
  );
  const handleNewThread = useCallback(() => {
    if (newThreadTarget) {
      onNewThread?.(newThreadTarget);
    }
  }, [newThreadTarget, onNewThread]);
  const showNewThreadButton = onNewThread !== undefined && newThreadTarget !== null;

  // The new-thread button is a SIBLING of the collapse toggle, not a child:
  // nested touchables are unreachable to VoiceOver/TalkBack (the parent
  // swallows focus). Row padding lives on the container (explicit styles —
  // dynamic padding classes on Pressable did not apply reliably) so both
  // children share one centerline; hitSlop restores the padded tap area.
  const verticalHitSlop = { top: props.isFirst ? 8 : 24, bottom: 12 };
  return (
    <View
      className={compact ? "flex-row items-center bg-screen" : "flex-row items-center"}
      style={{
        minHeight: compact ? 44 : 36,
        paddingLeft: compact ? 20 : 12,
        // Compact right padding centers the 20pt plus glyph on the thread
        // rows' trailing chevron column (18 + 13/2 ≈ 24.5 from the edge).
        paddingRight: compact ? 14 : 12,
        paddingBottom: compact ? 12 : 8,
        paddingTop: props.isFirst ? (compact ? 8 : 4) : compact ? 24 : 20,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: !props.collapsed }}
        accessibilityLabel={`${props.title}, ${props.threadCount} threads`}
        accessibilityHint={props.collapsed ? "Expands the project" : "Collapses the project"}
        className={
          compact ? "flex-1 flex-row items-center gap-2.5" : "flex-1 flex-row items-center gap-2"
        }
        hitSlop={{ ...verticalHitSlop, left: compact ? 20 : 12 }}
        onPress={handleToggle}
      >
        <ProjectFavicon
          environmentId={props.project.environmentId}
          faviconPath={props.project.faviconPath}
          open={!props.collapsed}
          size={compact ? 22 : 18}
          projectTitle={props.project.title}
          workspaceRoot={props.project.workspaceRoot}
        />
        <Text
          className={
            compact
              ? "flex-shrink text-base font-t3-bold tracking-[0.2px] text-foreground-muted"
              : "flex-shrink text-sm font-t3-bold tracking-[0.2px] text-foreground-muted"
          }
          numberOfLines={1}
        >
          {props.title}
        </Text>
        <Text
          className={
            compact
              ? "flex-1 text-sm font-t3-medium text-foreground-tertiary"
              : "flex-1 text-xs font-t3-medium text-foreground-tertiary"
          }
        >
          {props.threadCount}
        </Text>
      </Pressable>
      {showNewThreadButton ? (
        <Pressable
          accessibilityLabel={`Create new thread in ${props.title}`}
          accessibilityRole="button"
          hitSlop={{ ...verticalHitSlop, left: 10, right: 14 }}
          onPress={handleNewThread}
          style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1, paddingLeft: 12 })}
        >
          <SymbolView
            name="plus"
            size={compact ? 20 : 16}
            tintColorClassName={"accent-icon-muted"}
            type="monochrome"
            weight="medium"
          />
        </Pressable>
      ) : null}
    </View>
  );
});

/* ─── Show more / show less row ──────────────────────────────────────── */

export const ThreadListShowMoreRow = memo(function ThreadListShowMoreRow(props: {
  readonly variant: ThreadListVariant;
  readonly hiddenCount: number;
  readonly canShowLess: boolean;
  /** When set with `onGroupAction`, show-more / show-less dispatch group actions. */
  readonly groupKey?: string;
  readonly onGroupAction?: (key: string, action: HomeGroupDisplayAction) => void;
  /**
   * Binary expand/collapse for Needs attention (preview ↔ all). When provided,
   * overrides group-key based actions.
   */
  readonly onToggleExpanded?: () => void;
}) {
  const showsMore = props.hiddenCount > 0;
  const compact = props.variant === "compact";
  const { groupKey, onGroupAction, onToggleExpanded } = props;
  const handleShowMore = useCallback(() => {
    if (onToggleExpanded) {
      onToggleExpanded();
      return;
    }
    if (groupKey && onGroupAction) onGroupAction(groupKey, "show-more");
  }, [groupKey, onGroupAction, onToggleExpanded]);
  const handleShowLess = useCallback(() => {
    if (onToggleExpanded) {
      onToggleExpanded();
      return;
    }
    if (groupKey && onGroupAction) onGroupAction(groupKey, "show-less");
  }, [groupKey, onGroupAction, onToggleExpanded]);

  const button = (label: string, icon: "chevron.down" | "chevron.up", onPress: () => void) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label === "Show more" ? "Show more threads" : "Show fewer threads"}
      className="rounded-full bg-subtle"
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => ({
        opacity: pressed ? 0.6 : 1,
        paddingHorizontal: compact ? 14 : 12,
        paddingVertical: compact ? 7 : 6,
        borderCurve: "continuous",
      })}
    >
      <View className="flex-row items-center gap-1.5">
        <SymbolView
          name={icon}
          size={10}
          tintColorClassName={"accent-icon-subtle"}
          type="monochrome"
          weight="semibold"
        />
        <Text
          className={
            compact
              ? "text-sm font-t3-medium text-foreground-muted"
              : "text-xs font-t3-medium text-foreground-muted"
          }
        >
          {label}
        </Text>
      </View>
    </Pressable>
  );

  return (
    <View
      className={
        compact ? "flex-row items-center gap-2.5 bg-screen" : "flex-row items-center gap-2"
      }
      style={{
        paddingLeft: compact ? THREAD_LIST_COMPACT_INSET : 12,
        paddingRight: compact ? 18 : 12,
        paddingVertical: compact ? 12 : 8,
      }}
    >
      {showsMore ? button("Show more", "chevron.down", handleShowMore) : null}
      {props.canShowLess ? button("Show less", "chevron.up", handleShowLess) : null}
    </View>
  );
});

/* ─── Pending task row ───────────────────────────────────────────────── */

const PENDING_TASK_MENU_ACTIONS: MenuAction[] = [
  { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
];

/**
 * A queued new task waiting in the outbox for its environment to reconnect.
 * Tapping reopens the new-task composer with everything prefilled; the row
 * disappears once the task is delivered and the real thread arrives.
 */
export const PendingTaskListRow = memo(function PendingTaskListRow(props: {
  readonly variant: ThreadListVariant;
  readonly pendingTask: PendingNewTask;
  readonly environmentLabel: string | null;
  readonly isLast: boolean;
  readonly onSelectPendingTask: (pendingTask: PendingNewTask) => void;
  readonly onDeletePendingTask: (pendingTask: PendingNewTask) => void;
}) {
  const compact = props.variant === "compact";
  const theme = useUniwindTheme();
  const separatorColor = theme["--color-separator"];
  const pressedBackgroundColor = theme["--color-subtle"];

  const { pendingTask, onSelectPendingTask, onDeletePendingTask } = props;
  const timestamp = relativeTime(pendingTask.message.createdAt);
  const subtitleParts = [props.environmentLabel, pendingTask.creation.branch].filter(
    (part): part is string => Boolean(part),
  );

  const handleMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      if (nativeEvent.event === "delete") onDeletePendingTask(pendingTask);
    },
    [onDeletePendingTask, pendingTask],
  );

  const statusPill = (
    <View className="rounded-full bg-adaptive-zinc-500-a12-a16 px-1.5 py-0.5">
      <Text className="text-3xs font-t3-bold text-adaptive-zinc-600-300">Pending</Text>
    </View>
  );

  const subtitleRow =
    subtitleParts.length > 0 ? (
      <View className="mt-px flex-row items-center gap-1.5">
        <SymbolView
          name="tray.and.arrow.up"
          size={10}
          tintColorClassName={compact ? "accent-icon-subtle" : "accent-foreground-muted"}
          type="monochrome"
        />
        <Text
          className={
            compact
              ? "shrink text-sm text-foreground-muted"
              : "shrink text-xs text-foreground-muted"
          }
          numberOfLines={1}
        >
          {subtitleParts.join(" · ")}
        </Text>
      </View>
    ) : null;

  const rowContent = compact ? (
    <Pressable
      accessibilityHint="Opens the queued task for editing"
      accessibilityLabel={pendingTask.title}
      accessibilityRole="button"
      className="bg-screen"
      onPress={() => onSelectPendingTask(pendingTask)}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
    >
      <View
        style={{
          paddingLeft: THREAD_LIST_COMPACT_INSET,
          paddingRight: 18,
          paddingTop: 10,
        }}
      >
        <View
          style={{
            gap: 3,
            borderBottomWidth: props.isLast ? 0 : 1,
            borderBottomColor: separatorColor,
            paddingBottom: 10,
          }}
        >
          <View className="flex-row items-center justify-between gap-2">
            <Text className="flex-1 text-lg font-t3-bold text-foreground" numberOfLines={1}>
              {pendingTask.title}
            </Text>
            <View className="flex-row items-center gap-2">
              {statusPill}
              <Text className="text-base tabular-nums text-foreground-tertiary">{timestamp}</Text>
              <SymbolView
                name="chevron.right"
                size={13}
                tintColorClassName={"accent-icon-subtle"}
                type="monochrome"
              />
            </View>
          </View>
          {subtitleRow}
        </View>
      </View>
    </Pressable>
  ) : (
    <Pressable
      accessibilityHint="Opens the queued task for editing"
      accessibilityLabel={pendingTask.title}
      accessibilityRole="button"
      onPress={() => onSelectPendingTask(pendingTask)}
      style={({ pressed }) => ({
        backgroundColor: pressed ? pressedBackgroundColor : "transparent",
        borderRadius: SIDEBAR_ROW_RADIUS,
        cursor: "pointer",
        minHeight: 64,
        justifyContent: "center",
        paddingHorizontal: 12,
        paddingVertical: 10,
      })}
    >
      <View className="gap-[3px]">
        <View className="flex-row items-center justify-between gap-2">
          <Text className="flex-1 text-base font-t3-medium text-foreground" numberOfLines={1}>
            {pendingTask.title}
          </Text>
          <View className="flex-row items-center gap-2">
            {statusPill}
            <Text className="text-xs tabular-nums text-foreground-muted" numberOfLines={1}>
              {timestamp}
            </Text>
          </View>
        </View>
        {subtitleRow}
      </View>
    </Pressable>
  );

  return (
    <ControlPillMenu
      actions={PENDING_TASK_MENU_ACTIONS}
      onPressAction={handleMenuAction}
      shouldOpenOnLongPress
    >
      {rowContent}
    </ControlPillMenu>
  );
});

/* ─── Thread row ─────────────────────────────────────────────────────── */

const THREAD_ROW_LEGACY_MENU_ACTIONS: MenuAction[] = [
  { id: "archive", title: "Archive", image: "archivebox" },
  { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
];

function buildThreadRowMenuActions(input: {
  readonly settlementSupported: boolean;
  readonly isSettled: boolean;
  /** Upstream's regenerate entry (#6253), sat above Archive as it is there. */
  readonly titleRegeneration: readonly MenuAction[];
}): MenuAction[] {
  if (!input.settlementSupported) {
    return [
      THREAD_ROW_LEGACY_MENU_ACTIONS[0]!,
      ...input.titleRegeneration,
      ...THREAD_ROW_LEGACY_MENU_ACTIONS.slice(1),
    ];
  }
  return [
    input.isSettled
      ? { id: "unsettle", title: "Unsettle", image: "pin" }
      : { id: "settle", title: "Settle", image: "checkmark.circle" },
    ...input.titleRegeneration,
    { id: "archive", title: "Archive", image: "archivebox" },
    { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
  ];
}

export const ThreadListRow = memo(function ThreadListRow(props: {
  readonly variant: ThreadListVariant;
  readonly thread: EnvironmentThreadShell;
  readonly environmentLabel: string | null;
  readonly projectCwd: string | null;
  /**
   * Optional project title for cross-project contexts (Needs attention).
   * Shown ahead of environment / branch in the subtitle.
   */
  readonly projectTitle?: string | null;
  readonly searchMatch?: EnvironmentThreadSearchMatch;
  readonly searchQuery?: string;
  readonly isLast: boolean;
  /** Sidebar only: the thread currently open in the detail pane. */
  readonly selected?: boolean;
  /** Defaults to window width minus compact margins. */
  readonly fullSwipeWidth?: number;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onArchiveThread: (thread: EnvironmentThreadShell) => void;
  readonly onDeleteThread: (thread: EnvironmentThreadShell) => void;
  /** When set with settlementSupported, long-press can settle/unsettle. */
  readonly settlementSupported?: boolean;
  readonly isSettled?: boolean;
  readonly onSettleThread?: (thread: EnvironmentThreadShell) => void;
  readonly onUnsettleThread?: (thread: EnvironmentThreadShell) => void;
  readonly onRegenerateThreadTitle: (thread: EnvironmentThreadShell) => void;
  readonly titleRegenerationSupported: boolean;
  readonly onSwipeableWillOpen: (methods: SwipeableMethods) => void;
  readonly onSwipeableClose: (methods: SwipeableMethods) => void;
  readonly simultaneousSwipeGesture?: ComponentProps<
    typeof ThreadSwipeable
  >["simultaneousWithExternalGesture"];
}) {
  const { width: windowWidth } = useWindowDimensions();
  const { themeAppearance: colorScheme } = useAppearancePreferences();
  const compact = props.variant === "compact";
  const selected = props.selected === true;
  // Recycling-safe: resets when the list container is reused for another
  // thread, so a hover highlight can't leak across rows.
  const [hovered, setHovered] = useRecyclingState(false);

  const theme = useUniwindTheme();
  const separatorColor = theme["--color-separator"];
  const screenColor = theme["--color-screen"];
  const drawerColor = theme["--color-drawer"];
  const pressedBackgroundColor = theme["--color-subtle"];
  const selectedBackgroundColor = theme["--color-user-bubble"];
  const selectedForegroundColor = theme["--color-user-bubble-foreground"];

  const {
    thread,
    onSelectThread,
    onArchiveThread,
    onDeleteThread,
    onSettleThread,
    onUnsettleThread,
    onRegenerateThreadTitle,
  } = props;
  const settlementSupported = props.settlementSupported === true;
  const isSettled = props.isSettled === true;
  const status = resolveThreadStatus(thread);
  const threadKey = scopedThreadKey(thread.environmentId, thread.id);
  const composerDrafts = useAtomValue(composerDraftsAtom);
  const hasDraft = hasComposerDraftMessage(composerDrafts[threadKey]);
  const pr = useThreadPr(thread, props.projectCwd);
  const timestamp = relativeTime(
    thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt,
  );
  // Settled rows label by when the work ENDED, matching the shelf sort.
  const settledTimestamp = relativeTime(resolveSettledRowTimestamp(thread));
  const threadAccessibilityLabel = pr ? `${thread.title}, ${pr.accessibilityLabel}` : thread.title;
  const subtitleParts = [props.projectTitle, props.environmentLabel, thread.branch].filter(
    (part): part is string => Boolean(part),
  );

  const serverConfig = useEnvironmentServerConfig(thread.environmentId);
  const aiUsageSnapshot = useAiUsageSnapshot(thread.environmentId);
  const threadUsage = useMemo(() => {
    if (!serverConfig) return null;
    const providerEntry = serverConfig.providers.find(
      (p) => p.instanceId === thread.modelSelection.instanceId,
    );
    if (!providerEntry) return null;
    return resolveDriverUsage(
      aiUsageSnapshot,
      providerEntry.driver as ProviderDriverKind,
      thread.modelSelection.model,
    );
  }, [serverConfig, aiUsageSnapshot, thread.modelSelection]);
  const showUsageDot = threadUsage ? hasUsageMarker(threadUsage.marker) : false;
  const providerDriverForIcon = serverConfig
    ? (serverConfig.providers.find((p) => p.instanceId === thread.modelSelection.instanceId)
        ?.driver ?? null)
    : null;

  const backgroundColor = compact ? screenColor : drawerColor;
  const effectivePressedBackground = selected
    ? themeColorWithAlpha(String(selectedForegroundColor), 0.16)
    : pressedBackgroundColor;
  const effectiveStatus =
    selected && status
      ? {
          ...status,
          pillClassName: "bg-user-bubble-foreground/20",
          textClassName: "text-user-bubble-foreground",
        }
      : status;

  const handleDelete = useCallback(() => onDeleteThread(thread), [onDeleteThread, thread]);
  const handleArchive = useCallback(() => onArchiveThread(thread), [onArchiveThread, thread]);
  const handleSettle = useCallback(() => onSettleThread?.(thread), [onSettleThread, thread]);
  const handleUnsettle = useCallback(() => onUnsettleThread?.(thread), [onUnsettleThread, thread]);
  const handleRegenerateTitle = useCallback(
    () => onRegenerateThreadTitle(thread),
    [onRegenerateThreadTitle, thread],
  );
  const primaryAction = useMemo(
    () => ({
      accessibilityLabel: `Archive ${thread.title}`,
      icon: "archivebox" as const,
      label: "Archive",
      onPress: handleArchive,
    }),
    [handleArchive, thread.title],
  );
  const menuActions = useMemo(
    () =>
      buildThreadRowMenuActions({
        settlementSupported,
        isSettled,
        titleRegeneration: buildThreadTitleRegenerationMenuItems({
          supported: props.titleRegenerationSupported,
          isRegenerating: thread.titleRegeneration != null,
        }),
      }),
    [isSettled, props.titleRegenerationSupported, settlementSupported, thread.titleRegeneration],
  );
  const handleMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      if (nativeEvent.event === "settle") handleSettle();
      if (nativeEvent.event === "unsettle") handleUnsettle();
      if (nativeEvent.event === "archive") handleArchive();
      if (nativeEvent.event === "regenerate-title") handleRegenerateTitle();
      if (nativeEvent.event === "delete") handleDelete();
    },
    [handleArchive, handleDelete, handleRegenerateTitle, handleSettle, handleUnsettle],
  );

  const statusPill = effectiveStatus ? (
    <View className={`${effectiveStatus.pillClassName} rounded-full px-1.5 py-0.5`}>
      <Text className={`text-3xs font-t3-bold ${effectiveStatus.textClassName}`}>
        {effectiveStatus.label}
      </Text>
    </View>
  ) : null;

  const subtitleRow =
    subtitleParts.length > 0 || pr !== null ? (
      <View className="mt-px flex-row items-center gap-1.5">
        {subtitleParts.length > 0 ? (
          <>
            <Text
              className={cn(
                "shrink",
                compact ? "text-sm text-foreground-muted" : "text-xs",
                !compact &&
                  (selected ? "text-user-bubble-foreground-muted" : "text-foreground-muted"),
              )}
              numberOfLines={1}
            >
              {subtitleParts.join(" · ")}
            </Text>
          </>
        ) : null}
        {pr !== null ? (
          <View className="flex-row items-center gap-0.5">
            <PullRequestIcon
              size={compact ? 13 : 11}
              color={
                selected
                  ? String(selectedForegroundColor)
                  : pullRequestTintColor(pr.state, colorScheme)
              }
            />
            <Text
              className={`${compact ? "text-sm" : "text-xs"} font-t3-medium ${
                selected ? "text-user-bubble-foreground" : pr.textClassName
              }`}
            >
              {pr.label}
            </Text>
          </View>
        ) : null}
      </View>
    ) : null;

  // Project-grouped lists already show a favicon in the group header, so the
  // slim row only leads with one where it also carries project context
  // (recency / flat / Needs attention) — the same rule the subtitle uses.
  const showSettledFavicon = Boolean(props.projectTitle) && props.projectCwd !== null;

  /**
   * Settled threads are history, not inbox: they collapse to a single dimmed
   * line so the active work above stays scannable. Status pill, subtitle,
   * PR badge, provider icon and chevron all drop — a settled row is a title,
   * a time, and a way back in. Matches the Thread List v2 settled tail
   * (thread-list-v2-items.tsx) and web's settled shelf (Sidebar.tsx), so
   * settled history reads the same in every list mode on every client.
   */
  const settledRowContent = (close: () => void) => (
    <Pressable
      accessibilityHint="Opens the settled thread. Swipe left for archive and delete actions."
      accessibilityLabel={threadAccessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      className={compact ? "bg-screen" : undefined}
      onHoverIn={compact ? undefined : () => setHovered(true)}
      onHoverOut={compact ? undefined : () => setHovered(false)}
      onPressIn={() => {
        prefetchEnvironmentThread(thread.environmentId, thread.id);
      }}
      onPress={() => {
        close();
        onSelectThread(thread);
      }}
      style={
        compact
          ? ({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })
          : ({ pressed }) => ({
              backgroundColor: selected
                ? selectedBackgroundColor
                : pressed || hovered
                  ? effectivePressedBackground
                  : backgroundColor,
              borderRadius: SIDEBAR_ROW_RADIUS,
              cursor: "pointer",
            })
      }
    >
      <View
        className="min-h-[44px] flex-row items-center gap-2.5 py-2"
        style={{
          paddingLeft: compact ? THREAD_LIST_COMPACT_INSET : 12,
          paddingRight: compact ? 18 : 12,
        }}
        testID="thread-list-row-settled"
      >
        {showSettledFavicon ? (
          <View className="opacity-40">
            <ProjectFavicon
              environmentId={thread.environmentId}
              size={15}
              projectTitle={props.projectTitle ?? ""}
              workspaceRoot={props.projectCwd}
            />
          </View>
        ) : null}
        <View className="min-w-0 flex-1">
          <View className="flex-row items-center gap-1.5">
            <Text
              className={cn(
                "min-w-0 flex-1 text-base",
                selected ? "text-user-bubble-foreground" : "text-foreground-muted",
              )}
              numberOfLines={1}
            >
              {thread.title}
            </Text>
            {hasDraft ? (
              <View
                accessibilityLabel="Unsent draft"
                className="size-1.5 shrink-0 rounded-full bg-blue-500"
              />
            ) : null}
          </View>
          {props.searchMatch ? (
            <ThreadSearchMatchExcerpt
              compact={compact}
              match={props.searchMatch}
              query={props.searchQuery ?? ""}
              selected={selected}
            />
          ) : null}
        </View>
        <Text
          className={cn(
            "text-sm tabular-nums",
            selected ? "text-user-bubble-foreground-muted" : "text-foreground-tertiary",
          )}
          style={{ fontFamily: MONO_FONT }}
        >
          {settledTimestamp}
        </Text>
      </View>
    </Pressable>
  );

  const rowContent = (close: () => void) =>
    isSettled ? (
      settledRowContent(close)
    ) : compact ? (
      <Pressable
        accessibilityHint="Swipe left for archive and delete actions"
        accessibilityLabel={threadAccessibilityLabel}
        accessibilityRole="button"
        className="bg-screen"
        onPressIn={() => {
          prefetchEnvironmentThread(thread.environmentId, thread.id);
        }}
        onPress={() => {
          close();
          onSelectThread(thread);
        }}
        style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
      >
        <View
          style={{
            paddingLeft: THREAD_LIST_COMPACT_INSET,
            paddingRight: 18,
            paddingTop: 10,
          }}
        >
          <View
            style={{
              gap: 3,
              borderBottomWidth: props.isLast ? 0 : 1,
              borderBottomColor: separatorColor,
              paddingBottom: 10,
            }}
          >
            <View className="flex-row items-center justify-between gap-2">
              <View className="flex-1 flex-row items-center gap-2 min-w-0">
                {providerDriverForIcon ? (
                  <ProviderUsageIcon
                    provider={providerDriverForIcon}
                    size={16}
                    marker={showUsageDot ? (threadUsage?.marker ?? null) : null}
                  />
                ) : null}
                <Text className="flex-1 text-lg font-t3-bold text-foreground" numberOfLines={1}>
                  {thread.title}
                </Text>
                <ThreadIdentityMark
                  environmentId={thread.environmentId}
                  originChannel={thread.originSource?.channel}
                  participants={thread.participantSummaries}
                />
                {hasDraft ? (
                  <View
                    accessibilityLabel="Unsent draft"
                    className="size-1.5 shrink-0 rounded-full bg-blue-500"
                  />
                ) : null}
              </View>
              <View className="flex-row items-center gap-2">
                {statusPill}
                <Text className="text-base tabular-nums text-foreground-tertiary">{timestamp}</Text>
                <SymbolView
                  name="chevron.right"
                  size={13}
                  tintColorClassName={"accent-icon-subtle"}
                  type="monochrome"
                />
              </View>
            </View>
            {props.searchMatch ? (
              <ThreadSearchMatchExcerpt
                compact
                match={props.searchMatch}
                query={props.searchQuery ?? ""}
              />
            ) : null}
            {subtitleRow}
          </View>
        </View>
      </Pressable>
    ) : (
      <Pressable
        accessibilityHint="Opens the thread"
        accessibilityLabel={threadAccessibilityLabel}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        onPressIn={() => {
          prefetchEnvironmentThread(thread.environmentId, thread.id);
        }}
        onPress={() => {
          close();
          onSelectThread(thread);
        }}
        style={({ pressed }) => ({
          backgroundColor: selected
            ? selectedBackgroundColor
            : pressed || hovered
              ? effectivePressedBackground
              : backgroundColor,
          borderRadius: SIDEBAR_ROW_RADIUS,
          cursor: "pointer",
          minHeight: 64,
          justifyContent: "center",
          paddingHorizontal: 12,
          paddingVertical: 10,
        })}
      >
        <View className="gap-[3px]">
          <View className="flex-row items-center justify-between gap-2">
            <View className="flex-1 flex-row items-center gap-2 min-w-0">
              {providerDriverForIcon ? (
                <ProviderUsageIcon
                  provider={providerDriverForIcon}
                  size={14}
                  marker={showUsageDot ? (threadUsage?.marker ?? null) : null}
                />
              ) : null}
              <Text
                className={cn(
                  "flex-1 text-base font-t3-medium",
                  selected ? "text-user-bubble-foreground" : "text-foreground",
                )}
                numberOfLines={1}
              >
                {thread.title}
              </Text>
              <ThreadIdentityMark
                environmentId={thread.environmentId}
                originChannel={thread.originSource?.channel}
                participants={thread.participantSummaries}
              />
              {hasDraft ? (
                <View
                  accessibilityLabel="Unsent draft"
                  className="size-1.5 shrink-0 rounded-full bg-blue-500"
                />
              ) : null}
            </View>
            <View className="flex-row items-center gap-2">
              {statusPill}
              <Text
                className={cn(
                  "text-xs tabular-nums",
                  selected ? "text-user-bubble-foreground-muted" : "text-foreground-muted",
                )}
                numberOfLines={1}
              >
                {timestamp}
              </Text>
            </View>
          </View>
          {props.searchMatch ? (
            <ThreadSearchMatchExcerpt
              match={props.searchMatch}
              query={props.searchQuery ?? ""}
              selected={selected}
            />
          ) : null}
          {subtitleRow}
        </View>
      </Pressable>
    );

  return (
    <ThreadSwipeable
      backgroundColor={backgroundColor}
      containerStyle={
        compact ? undefined : { borderRadius: SIDEBAR_ROW_RADIUS, overflow: "hidden" }
      }
      enableTrackpadSwipe
      fullSwipeWidth={props.fullSwipeWidth ?? windowWidth - 32}
      onDelete={handleDelete}
      onSwipeableClose={props.onSwipeableClose}
      onSwipeableWillOpen={props.onSwipeableWillOpen}
      primaryAction={primaryAction}
      resetKey={`${thread.environmentId}:${thread.id}`}
      simultaneousWithExternalGesture={props.simultaneousSwipeGesture}
      threadTitle={thread.title}
    >
      {(close) => (
        // Messages-style row actions on long-press. iOS: a real
        // UIContextMenuInteraction with the row as the zoom preview (needs the
        // patched @react-native-menu, see
        // patches/@react-native-menu__menu@2.0.0.patch — in long-press mode the
        // interaction is hosted by the component view and the underlying
        // UIButton passes touches through, so row taps keep working). Android:
        // ControlPillMenu injects onLongPress into the row and anchors the
        // token-styled dropdown to it; taps and swipes are untouched.
        <ControlPillMenu
          actions={menuActions}
          onPressAction={handleMenuAction}
          shouldOpenOnLongPress
        >
          {rowContent(close)}
        </ControlPillMenu>
      )}
    </ThreadSwipeable>
  );
});

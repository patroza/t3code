import { useAtomValue } from "@effect/atom-react";
import {
  deriveLogicalProjectKey,
  deriveProjectGroupLabel,
} from "@t3tools/client-runtime/state/project-grouping";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { effectiveSettled } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentId, SidebarProjectGroupingMode } from "@t3tools/contracts";
import { resolveThreadChangeRequest } from "@t3tools/shared/sourceControl";
import type { MenuAction } from "@react-native-menu/menu";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  FlatList,
  Pressable,
  ScrollView,
  useWindowDimensions,
  View,
  type ListRenderItemInfo,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import { EmptyState } from "../../components/EmptyState";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { SymbolView } from "../../components/AppSymbol";
import { relativeTime } from "../../lib/time";
import { scopedProjectKey, scopedThreadKey } from "../../lib/scopedEntities";
import { useThemeColor } from "../../lib/useThemeColor";
import { environmentServerConfigsAtom } from "../../state/server";
import {
  BOARD_COLUMN_IDS,
  BOARD_COLUMN_LABELS,
  boardGitKey,
  boardWorktreeKey,
  buildBoardColumns,
  buildBoardProjectFilterPredicate,
  countBoardColumnThreads,
  deriveBoardColumn,
  sliceBoardSettledItems,
  type BoardColumnId,
  type BoardColumnItem,
} from "./boardLogic";
import { resolveBoardThreadStatusLabel, resolveBoardWorkingStartedAt } from "./boardStatus";
import { useBoardVcsStatuses, type BoardVcsTarget } from "./useBoardVcsStatuses";

const SETTLED_INITIAL_COUNT = 10;
const SETTLED_PAGE_COUNT = 25;
const AUTO_SETTLE_AFTER_DAYS = 3;

export interface BoardScreenProps {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projectGroupingMode: SidebarProjectGroupingMode;
  readonly environmentLabelById: ReadonlyMap<string, string>;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onArchiveThread: (thread: EnvironmentThreadShell) => void;
  readonly onDeleteThread: (thread: EnvironmentThreadShell) => void;
  readonly onSettleThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onUnsettleThread: (thread: EnvironmentThreadShell) => void;
}

interface BoardProjectFilterOption {
  readonly key: string;
  readonly label: string;
  readonly memberProjectRefs: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly projectId: EnvironmentProject["id"];
  }>;
  readonly representative: EnvironmentProject;
}

function BoardCard(props: {
  readonly thread: EnvironmentThreadShell;
  readonly project: EnvironmentProject | null;
  readonly projectTitle: string | null;
  readonly environmentLabel: string | null;
  readonly statusLabel: string | null;
  readonly isSettled: boolean;
  readonly onSelect: () => void;
  readonly onArchive: () => void;
  readonly onDelete: () => void;
  readonly onSettle: () => void;
  readonly onUnsettle: () => void;
  readonly settlementSupported: boolean;
}) {
  const timestamp = relativeTime(
    props.thread.latestUserMessageAt ?? props.thread.updatedAt ?? props.thread.createdAt,
  );
  const subtitleParts = [props.projectTitle, props.environmentLabel, props.thread.branch].filter(
    (part): part is string => Boolean(part),
  );

  const menuActions = useMemo<MenuAction[]>(() => {
    const actions: MenuAction[] = [];
    if (props.settlementSupported) {
      actions.push(
        props.isSettled
          ? { id: "unsettle", title: "Unsettle", image: "pin" }
          : { id: "settle", title: "Settle", image: "checkmark.circle" },
      );
    }
    actions.push(
      { id: "archive", title: "Archive", image: "archivebox" },
      { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
    );
    return actions;
  }, [props.isSettled, props.settlementSupported]);

  const handleMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      switch (nativeEvent.event) {
        case "archive":
          props.onArchive();
          break;
        case "delete":
          props.onDelete();
          break;
        case "settle":
          void props.onSettle();
          break;
        case "unsettle":
          props.onUnsettle();
          break;
      }
    },
    [props],
  );

  return (
    <ControlPillMenu actions={menuActions} onPressAction={handleMenuAction} shouldOpenOnLongPress>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.thread.title}
        accessibilityHint="Long-press for thread actions"
        onPress={props.onSelect}
        className="rounded-xl border border-border bg-card px-3 py-2.5"
        style={({ pressed }) => ({ opacity: pressed ? 0.75 : 1 })}
      >
        <View className="flex-row items-start gap-2">
          {props.project ? (
            <ProjectFavicon
              environmentId={props.project.environmentId}
              open
              size={18}
              projectTitle={props.project.title}
              workspaceRoot={props.project.workspaceRoot}
            />
          ) : null}
          <View className="min-w-0 flex-1 gap-1">
            <Text className="text-base font-t3-medium text-foreground" numberOfLines={2}>
              {props.thread.title}
            </Text>
            {subtitleParts.length > 0 ? (
              <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                {subtitleParts.join(" · ")}
              </Text>
            ) : null}
            <View className="mt-0.5 flex-row items-center justify-between gap-2">
              {props.statusLabel ? (
                <View className="rounded-full bg-subtle px-1.5 py-0.5">
                  <Text className="text-3xs font-t3-bold text-foreground-muted">
                    {props.statusLabel}
                  </Text>
                </View>
              ) : (
                <View />
              )}
              <Text className="text-xs tabular-nums text-foreground-tertiary">{timestamp}</Text>
            </View>
          </View>
        </View>
      </Pressable>
    </ControlPillMenu>
  );
}

const BoardColumnView = memo(function BoardColumnView(props: {
  readonly columnId: BoardColumnId;
  readonly items: ReadonlyArray<BoardColumnItem<EnvironmentThreadShell>>;
  readonly width: number;
  readonly projectByKey: ReadonlyMap<string, EnvironmentProject>;
  readonly projectTitleByKey: ReadonlyMap<string, string>;
  readonly environmentLabelById: ReadonlyMap<string, string>;
  readonly settledThreadKeys: ReadonlySet<string>;
  readonly statusLabelByKey: ReadonlyMap<string, string | null>;
  readonly settlementEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onArchiveThread: (thread: EnvironmentThreadShell) => void;
  readonly onDeleteThread: (thread: EnvironmentThreadShell) => void;
  readonly onSettleThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onUnsettleThread: (thread: EnvironmentThreadShell) => void;
  readonly footer?: ReactNode;
}) {
  const count = countBoardColumnThreads(props.items);
  const threads = useMemo(() => {
    const list: EnvironmentThreadShell[] = [];
    for (const item of props.items) {
      if (item.kind === "thread") {
        list.push(item.thread);
      } else {
        list.push(...item.threads);
      }
    }
    return list;
  }, [props.items]);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<EnvironmentThreadShell>) => {
      const threadKey = scopedThreadKey(item.environmentId, item.id);
      const projectKey = scopedProjectKey(item.environmentId, item.projectId);
      return (
        <View className="px-2 pb-2">
          <BoardCard
            thread={item}
            project={props.projectByKey.get(projectKey) ?? null}
            projectTitle={props.projectTitleByKey.get(projectKey) ?? null}
            environmentLabel={props.environmentLabelById.get(item.environmentId) ?? null}
            statusLabel={props.statusLabelByKey.get(threadKey) ?? null}
            isSettled={props.settledThreadKeys.has(threadKey)}
            settlementSupported={props.settlementEnvironmentIds.has(item.environmentId)}
            onSelect={() => props.onSelectThread(item)}
            onArchive={() => props.onArchiveThread(item)}
            onDelete={() => props.onDeleteThread(item)}
            onSettle={() => props.onSettleThread(item)}
            onUnsettle={() => props.onUnsettleThread(item)}
          />
        </View>
      );
    },
    [props],
  );

  return (
    <View style={{ width: props.width }} className="flex-1">
      <View className="flex-row items-center justify-between px-3 pb-2 pt-1">
        <Text className="text-sm font-t3-bold uppercase tracking-wider text-foreground-muted">
          {BOARD_COLUMN_LABELS[props.columnId]}
        </Text>
        <Text className="text-xs font-t3-medium tabular-nums text-foreground-tertiary">
          {count}
        </Text>
      </View>
      <FlatList
        data={threads}
        keyExtractor={(thread) => `${thread.environmentId}:${thread.id}`}
        renderItem={renderItem}
        ListEmptyComponent={
          <View className="px-3 py-6">
            <Text className="text-center text-sm text-foreground-tertiary">No threads</Text>
          </View>
        }
        ListFooterComponent={props.footer ? <>{props.footer}</> : null}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 24 }}
      />
    </View>
  );
});

export function BoardScreen(props: BoardScreenProps) {
  const insets = useSafeAreaInsets();
  const iconColor = useThemeColor("--color-icon");
  const { width: windowWidth } = useWindowDimensions();
  const columnWidth = Math.min(Math.max(windowWidth * 0.78, 260), 320);
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const [projectFilterKey, setProjectFilterKey] = useState<string | null>(null);
  const [settledVisibleCount, setSettledVisibleCount] = useState(SETTLED_INITIAL_COUNT);
  const [nowMinute, setNowMinute] = useState(() => new Date().toISOString().slice(0, 16));

  useEffect(() => {
    const id = setInterval(() => setNowMinute(new Date().toISOString().slice(0, 16)), 60_000);
    return () => clearInterval(id);
  }, []);

  const projectFilterOptions = useMemo<ReadonlyArray<BoardProjectFilterOption>>(() => {
    const groups = new Map<string, EnvironmentProject[]>();
    for (const project of props.projects) {
      const key = deriveLogicalProjectKey(project, {
        groupingMode: props.projectGroupingMode,
      });
      const existing = groups.get(key);
      if (existing) existing.push(project);
      else groups.set(key, [project]);
    }
    return [...groups.entries()]
      .map(([key, members]) => {
        const representative = members[0]!;
        return {
          key,
          label: deriveProjectGroupLabel({ representative, members }),
          memberProjectRefs: members.map((project) => ({
            environmentId: project.environmentId,
            projectId: project.id,
          })),
          representative,
        };
      })
      .sort((left, right) => left.label.localeCompare(right.label));
  }, [props.projectGroupingMode, props.projects]);

  useEffect(() => {
    if (
      projectFilterKey !== null &&
      !projectFilterOptions.some((option) => option.key === projectFilterKey)
    ) {
      setProjectFilterKey(null);
    }
  }, [projectFilterKey, projectFilterOptions]);

  const filterPredicate = useMemo(
    () =>
      buildBoardProjectFilterPredicate({
        selectedProjectKey: projectFilterKey,
        snapshots: projectFilterOptions.map((option) => ({
          projectKey: option.key,
          memberProjectRefs: option.memberProjectRefs,
        })),
      }),
    [projectFilterKey, projectFilterOptions],
  );

  const liveThreads = useMemo(
    () => props.threads.filter((thread) => thread.archivedAt === null),
    [props.threads],
  );
  const filteredThreads = useMemo(
    () => liveThreads.filter(filterPredicate),
    [filterPredicate, liveThreads],
  );

  const projectByKey = useMemo(() => {
    const map = new Map<string, EnvironmentProject>();
    for (const project of props.projects) {
      map.set(scopedProjectKey(project.environmentId, project.id), project);
    }
    return map;
  }, [props.projects]);

  const projectTitleByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const option of projectFilterOptions) {
      for (const ref of option.memberProjectRefs) {
        map.set(scopedProjectKey(ref.environmentId, ref.projectId), option.label);
      }
    }
    return map;
  }, [projectFilterOptions]);

  const resolveThreadGitCwd = useCallback(
    (thread: EnvironmentThreadShell): string | null => {
      if (thread.branch == null) return null;
      const project = projectByKey.get(scopedProjectKey(thread.environmentId, thread.projectId));
      return thread.worktreePath ?? project?.workspaceRoot ?? null;
    },
    [projectByKey],
  );

  const vcsTargets = useMemo<BoardVcsTarget[]>(
    () =>
      filteredThreads.flatMap((thread) => {
        const cwd = resolveThreadGitCwd(thread);
        return cwd === null ? [] : [{ environmentId: thread.environmentId, cwd }];
      }),
    [filteredThreads, resolveThreadGitCwd],
  );
  const gitStatuses = useBoardVcsStatuses(vcsTargets);

  const getGitStatus = useCallback(
    (thread: EnvironmentThreadShell) => {
      const cwd = resolveThreadGitCwd(thread);
      if (cwd === null) return null;
      return gitStatuses.get(boardGitKey(thread.environmentId, cwd)) ?? null;
    },
    [gitStatuses, resolveThreadGitCwd],
  );

  const settlementEnvironmentIds = useMemo(() => {
    const supported = new Set<EnvironmentId>();
    for (const [environmentId, config] of serverConfigs) {
      if (config.environment.capabilities.threadSettlement === true) {
        supported.add(environmentId);
      }
    }
    return supported;
  }, [serverConfigs]);

  const statusLabelByKey = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const thread of liveThreads) {
      map.set(
        scopedThreadKey(thread.environmentId, thread.id),
        resolveBoardThreadStatusLabel(thread),
      );
    }
    return map;
  }, [liveThreads]);

  const previousSettledRef = useRef<ReadonlySet<string>>(new Set());
  const settledThreadKeys = useMemo(() => {
    const now = `${nowMinute}:00.000Z`;
    const keys = new Set<string>();
    for (const thread of filteredThreads) {
      if (!settlementEnvironmentIds.has(thread.environmentId)) continue;
      const changeRequestState =
        resolveThreadChangeRequest(thread.branch, getGitStatus(thread))?.state ?? null;
      if (
        effectiveSettled(thread, {
          now,
          autoSettleAfterDays: AUTO_SETTLE_AFTER_DAYS,
          changeRequestState,
        })
      ) {
        keys.add(scopedThreadKey(thread.environmentId, thread.id));
      }
    }
    const previous = previousSettledRef.current;
    if (previous.size === keys.size && [...keys].every((key) => previous.has(key))) {
      return previous;
    }
    previousSettledRef.current = keys;
    return keys;
  }, [filteredThreads, getGitStatus, nowMinute, settlementEnvironmentIds]);

  const workingWorktreeKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const thread of liveThreads) {
      const label = statusLabelByKey.get(scopedThreadKey(thread.environmentId, thread.id));
      if (label !== "Working" && label !== "Connecting") continue;
      const cwd = resolveThreadGitCwd(thread);
      if (cwd !== null) {
        keys.add(boardGitKey(thread.environmentId, cwd));
      }
    }
    return keys;
  }, [liveThreads, resolveThreadGitCwd, statusLabelByKey]);

  const columns = useMemo(
    () =>
      buildBoardColumns(
        filteredThreads,
        (thread) => {
          const threadKey = scopedThreadKey(thread.environmentId, thread.id);
          const cwd = resolveThreadGitCwd(thread);
          return deriveBoardColumn({
            threadStatusLabel:
              (statusLabelByKey.get(threadKey) as ReturnType<
                typeof resolveBoardThreadStatusLabel
              >) ?? null,
            interactionMode: thread.interactionMode,
            isSettled: settledThreadKeys.has(threadKey),
            latestTurnCompletedAt: thread.latestTurn?.completedAt ?? null,
            readySessionUpdatedAt:
              thread.latestTurn === null && thread.session?.status === "ready"
                ? thread.session.updatedAt
                : null,
            lastVisitedAt: null,
            threadBranch: thread.branch,
            hasDedicatedWorktree: thread.worktreePath != null,
            hasWorkingThreadForWorktree:
              cwd !== null && workingWorktreeKeys.has(boardGitKey(thread.environmentId, cwd)),
            gitStatus: getGitStatus(thread),
          });
        },
        (thread) => resolveBoardWorkingStartedAt(thread),
        boardWorktreeKey,
      ),
    [
      filteredThreads,
      getGitStatus,
      resolveThreadGitCwd,
      settledThreadKeys,
      statusLabelByKey,
      workingWorktreeKeys,
    ],
  );

  const settledResetKey = projectFilterKey ?? "all";
  const lastSettledResetKeyRef = useRef(settledResetKey);
  if (lastSettledResetKeyRef.current !== settledResetKey) {
    lastSettledResetKeyRef.current = settledResetKey;
    if (settledVisibleCount !== SETTLED_INITIAL_COUNT) {
      setSettledVisibleCount(SETTLED_INITIAL_COUNT);
    }
  }

  const settledTail = useMemo(
    () => sliceBoardSettledItems(columns.settled, settledVisibleCount),
    [columns.settled, settledVisibleCount],
  );
  const showMoreSettled = useCallback(
    () => setSettledVisibleCount((count) => count + SETTLED_PAGE_COUNT),
    [],
  );

  const filterMenuActions = useMemo<MenuAction[]>(
    () => [
      {
        id: "project:all",
        title: "All projects",
        state: projectFilterKey === null ? "on" : "off",
      },
      ...projectFilterOptions.map((option) => ({
        id: `project:${option.key}`,
        title: option.label,
        state: (projectFilterKey === option.key ? "on" : "off") as "on" | "off",
      })),
    ],
    [projectFilterKey, projectFilterOptions],
  );

  const handleFilterAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      const id = nativeEvent.event;
      if (id === "project:all") {
        setProjectFilterKey(null);
        return;
      }
      if (id.startsWith("project:")) {
        setProjectFilterKey(id.slice("project:".length));
      }
    },
    [],
  );

  const selectedFilterLabel =
    projectFilterKey === null
      ? "All projects"
      : (projectFilterOptions.find((option) => option.key === projectFilterKey)?.label ??
        "All projects");

  if (liveThreads.length === 0) {
    return (
      <View
        className="flex-1 items-center justify-center bg-screen px-8"
        style={{ paddingBottom: Math.max(insets.bottom, 16) }}
      >
        <EmptyState title="No threads yet" detail="Create a task to start filling the board." />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-screen">
      {/*
        Filter sits under the stack header (solid on iOS Board). Do not rely on
        a transparent glass header — horizontal columns are not one scroll view
        UIKit can inset, so cards used to paint under the nav bar.
      */}
      <View className="flex-row items-center gap-2 border-b border-border px-4 pb-2.5 pt-2">
        <ControlPillMenu actions={filterMenuActions} onPressAction={handleFilterAction}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Filter board by project, ${selectedFilterLabel}`}
            className="flex-row items-center gap-1.5 rounded-full bg-subtle px-3 py-1.5"
            style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
          >
            <SymbolView
              name="line.3.horizontal.decrease.circle"
              size={14}
              tintColor={iconColor}
              type="monochrome"
            />
            <Text
              className="max-w-[220px] text-sm font-t3-medium text-foreground"
              numberOfLines={1}
            >
              {selectedFilterLabel}
            </Text>
          </Pressable>
        </ControlPillMenu>
        <Text className="text-xs text-foreground-tertiary">
          {filteredThreads.length} thread{filteredThreads.length === 1 ? "" : "s"}
        </Text>
      </View>

      {filteredThreads.length === 0 ? (
        <View className="flex-1 items-center justify-center px-8">
          <EmptyState
            title="No threads in this project"
            detail="Choose another project filter or create a new task."
          />
        </View>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          decelerationRate="fast"
          snapToInterval={columnWidth}
          contentContainerStyle={{
            paddingLeft: 8,
            paddingRight: Math.max(insets.right, 8),
            paddingBottom: Math.max(insets.bottom, 12),
          }}
        >
          {BOARD_COLUMN_IDS.map((columnId) => {
            const items = columnId === "settled" ? settledTail.visibleItems : columns[columnId];
            return (
              <BoardColumnView
                key={columnId}
                columnId={columnId}
                items={items}
                width={columnWidth}
                projectByKey={projectByKey}
                projectTitleByKey={projectTitleByKey}
                environmentLabelById={props.environmentLabelById}
                settledThreadKeys={settledThreadKeys}
                statusLabelByKey={statusLabelByKey}
                settlementEnvironmentIds={settlementEnvironmentIds}
                onSelectThread={props.onSelectThread}
                onArchiveThread={props.onArchiveThread}
                onDeleteThread={props.onDeleteThread}
                onSettleThread={props.onSettleThread}
                onUnsettleThread={props.onUnsettleThread}
                footer={
                  columnId === "settled" && settledTail.hiddenThreadCount > 0 ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Show ${Math.min(settledTail.hiddenThreadCount, SETTLED_PAGE_COUNT)} more settled threads`}
                      onPress={showMoreSettled}
                      className="mx-2 mt-1 items-center rounded-lg border border-dashed border-border py-2.5"
                      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
                    >
                      <Text className="text-xs font-t3-medium text-foreground-muted">
                        Show more ({settledTail.hiddenThreadCount} settled hidden)
                      </Text>
                    </Pressable>
                  ) : null
                }
              />
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

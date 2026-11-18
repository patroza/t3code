import { useGT as useCopyTranslation } from "gt-react-native";
import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { useAtomValue } from "@effect/atom-react";
import {
  makeQueuedRunsAtom,
  queuedRunEditBlockedReason,
} from "@t3tools/client-runtime/queued-run-edit";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { resolveUserMessagePresentation } from "@t3tools/client-runtime/user-message";
import type { ChatAttachment, EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { Atom, AsyncResult } from "effect/reactivity";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { Image } from "expo-image";
import * as Haptics from "expo-haptics";
import { msg, T, useGT, useMessages } from "gt-react-native";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Alert, Animated, Pressable, ScrollView, View } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Reanimated, { ReduceMotion, useAnimatedStyle, withTiming } from "react-native-reanimated";

import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { FilePreviewModal, type FilePreviewSource } from "../../components/ui/FilePreviewModal";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { useAssetUrl } from "../../state/assets";
import { useQuietThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { assetImageSource } from "../../lib/assetImageSource";
import { beginQueuedRunEdit, useQueuedRunEdit } from "../../state/queued-run-edit";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  REMOVE_QUEUED_MESSAGE_ACCESSIBILITY_LABEL,
  buildCancelQueuedRunCommand,
  resolveQueueDragBeforeRunId,
  resolveQueueDropBeforeRunId,
  resolveThreadQueueRowControls,
} from "./threadQueueControlPresentation";
import { threadDragGapOffset } from "./threadDragGap";

const REMOVE_ACTION_WIDTH = 76;
const THUMBNAIL_LIMIT = 3;
const EMPTY_QUEUED_COUNT_ATOM = Atom.make(0).pipe(
  Atom.withLabel("mobile-thread-queue-count:empty"),
);

type QueueTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };
type QueueAction = "steer" | "edit" | "up" | "down" | "remove";
type QueueRowLayout = { readonly id: RunId; readonly y?: number; readonly height?: number };
type QueueDrag = {
  readonly runId: RunId;
  readonly order: string;
  beforeRunId: RunId | null | undefined;
  readonly rows: ReadonlyArray<QueueRowLayout>;
};

export function useThreadQueueWorkflow(target: QueueTarget) {
  return useAtomValue(environmentThreadDetails.queueWorkflowAtom(target));
}

export function useThreadQueuedCount(target: QueueTarget | null) {
  return useAtomValue(
    target === null ? EMPTY_QUEUED_COUNT_ATOM : environmentThreadDetails.queuedCountAtom(target),
  );
}

type QueuedRunMessage = NonNullable<
  NonNullable<ReturnType<typeof useThreadQueueWorkflow>>["queuedRuns"][number]["message"]
>;

/** Who sent a queued message, as its sent form shows it in the thread. */
function QueuedRunSender(props: {
  readonly environmentId: EnvironmentId;
  readonly message: QueuedRunMessage;
}) {
  const gt = useGT();
  const { attribution, scheduledTaskId } = resolveUserMessagePresentation(props.message);
  const senderThreadId = attribution === "agent" ? props.message.senderThreadId : undefined;
  // A linked environment's agent sent it from a thread there.
  const linkedSender = attribution === "agent" ? props.message.linkedSender : undefined;
  const senderShell = useQuietThreadShell(
    linkedSender ?? (senderThreadId ? scopeThreadRef(props.environmentId, senderThreadId) : null),
  );
  const tasks = useEnvironmentQuery(
    scheduledTaskId
      ? serverEnvironment.scheduledTasksLive({ environmentId: props.environmentId, input: {} })
      : null,
  );
  const sender =
    attribution === "automation"
      ? {
          icon: "calendar.badge.clock" as const,
          label:
            tasks.data?.tasks.find((task) => task.id === scheduledTaskId)?.title ??
            gt("Automation"),
        }
      : attribution === "agent"
        ? {
            icon: "bubble.left.and.bubble.right" as const,
            label: senderShell?.title.trim() || linkedSender?.title.trim() || gt("Agent"),
          }
        : attribution === "t3code"
          ? { icon: null, label: gt("Sent by T3 Code") }
          : null;
  if (sender === null) return null;
  return (
    <View className="flex-row items-center gap-1">
      {sender.icon ? (
        <SymbolView
          name={sender.icon}
          size={11}
          weight="medium"
          tintColorClassName="accent-foreground-muted"
          type="monochrome"
        />
      ) : null}
      <Text
        numberOfLines={1}
        className="min-w-0 shrink font-t3-medium text-2xs text-foreground-muted"
      >
        {sender.label}
      </Text>
    </View>
  );
}

export function ThreadQueueSheet({ route }: StaticScreenProps<QueueTarget>) {
  const translateCopy = useCopyTranslation();

  const theme = useUniwindTheme();
  const target = route.params;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const gt = useGT();
  const m = useMessages();
  const workflow = useThreadQueueWorkflow(target);
  const threadKey = scopedThreadKey(target.environmentId, target.threadId);
  const editing = useQueuedRunEdit(threadKey);
  const pendingRequests = useAtomValue(environmentThreadDetails.pendingRequestsAtom(target));
  const editBlockedReason = queuedRunEditBlockedReason(
    {
      openQuestionCount: pendingRequests?.userInputs.length ?? 0,
    },
    m,
  );
  const reorder = useAtomCommand(threadEnvironment.reorderQueuedRun, "reorder queued message");
  const promote = useAtomCommand(threadEnvironment.promoteQueuedRun, "promote queued message");
  const cancel = useAtomCommand(threadEnvironment.cancelQueuedRun, "remove queued message");
  const beginEdit = useAtomCommand(threadEnvironment.beginQueuedRunEdit, "edit queued message");
  const resume = useAtomCommand(threadEnvironment.resumeThreadQueue, "resume queue");
  const resumeHeldQueue = useAtomCommand(threadEnvironment.resumeThreadQueue, {
    label: "resume queue",
    reportFailure: false,
  });
  const [resuming, setResuming] = useState(false);
  const [busyRunId, setBusyRunId] = useState<RunId | null>(null);
  const [previewFile, setPreviewFile] = useState<FilePreviewSource | null>(null);
  const busyRef = useRef(false);
  const [dragState, setDragState] = useState<QueueDrag | null>(null);
  const rowLayouts = useRef(new Map<RunId, { y: number; height: number }>());
  const drag = useRef<QueueDrag | null>(null);
  const [translation] = useState(() => new Animated.Value(0));
  const queuedRuns = workflow?.queuedRuns ?? [];
  const order = queuedRuns.map(({ run }) => run.id).join(",");
  // A queue that changed under the drag (delivery, another client) ends it:
  // the gesture handlers ignore it from then on and its preview disappears.
  const visibleDrag = dragState?.order === order ? dragState : null;
  const draggedRunId = visibleDrag?.runId ?? null;
  const previewBeforeRunId = visibleDrag?.beforeRunId;
  const dragRows = visibleDrag?.rows ?? null;

  const hadQueuedRuns = useRef(queuedRuns.length > 0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pops the navigator once the server-side queue empties after it had runs
  useEffect(() => {
    if (queuedRuns.length > 0) {
      hadQueuedRuns.current = true;
      return;
    }
    if (hadQueuedRuns.current) navigation.goBack();
  }, [navigation, queuedRuns.length]);

  const move = async (runId: RunId, beforeRunId: RunId | null) => {
    if (busyRef.current || !workflow?.canReorder) return;
    busyRef.current = true;
    setBusyRunId(runId);
    void Haptics.selectionAsync();
    await reorder({ ...target, input: { threadId: target.threadId, runId, beforeRunId } });
    busyRef.current = false;
    setBusyRunId(null);
  };

  const act = async (runId: RunId, action: QueueAction) => {
    if (busyRef.current) return;
    const index = queuedRuns.findIndex(({ run }) => run.id === runId);
    if (index < 0) return;
    if (action === "up" && index > 0) {
      await move(runId, queuedRuns[index - 1]!.run.id);
      return;
    }
    if (action === "down" && index < queuedRuns.length - 1) {
      await move(runId, queuedRuns[index + 2]?.run.id ?? null);
      return;
    }
    if (action === "edit") {
      if (editing !== null) {
        if (editing.runId !== runId)
          Alert.alert(translateCopy("Save or cancel your current queued edit first."));
        navigation.goBack();
        return;
      }
      if (editBlockedReason !== null) return;
      const entry = queuedRuns[index]!;
      busyRef.current = true;
      setBusyRunId(runId);
      const settled = await settlePromise(() =>
        beginEdit({
          ...target,
          input: {
            threadId: target.threadId,
            runId,
            previousEditId: entry.run.queueEditId ?? null,
          },
        }),
      );
      busyRef.current = false;
      setBusyRunId(null);
      if (!AsyncResult.isSuccess(settled)) return;
      const result = settled.value;
      if (result._tag !== "Success") return;
      void Haptics.selectionAsync();
      beginQueuedRunEdit(
        threadKey,
        {
          ...result.value,
          runId,
          messageId: entry.messageId,
          originalText: entry.text,
          existingAttachments: entry.attachments,
          ...(entry.context ? { context: entry.context } : {}),
        },
        makeQueuedRunsAtom({
          threadId: target.threadId,
          snapshot: threadEnvironment.snapshotAtom(target.environmentId),
          detailStatus: environmentThreadDetails.statusAtom(target),
          runs: Atom.make(
            (get) => get(environmentThreadDetails.quietThreadAtom(target))?.projection.runs ?? null,
          ),
        }),
      );
      navigation.goBack();
      return;
    }
    if (action !== "steer" && action !== "remove") return;
    busyRef.current = true;
    setBusyRunId(runId);
    void Haptics.selectionAsync();
    const result =
      action === "remove"
        ? await cancel(buildCancelQueuedRunCommand({ ...target, runId }))
        : workflow?.canSendNow
          ? await resume({ ...target, input: { threadId: target.threadId, runId } })
          : workflow?.activeRun && workflow.canPromoteToSteer
            ? await promote({
                ...target,
                input: {
                  threadId: target.threadId,
                  queuedRunId: runId,
                  targetRunId: workflow.activeRun.id,
                },
              })
            : null;
    busyRef.current = false;
    setBusyRunId(null);
    if (action === "steer" && result?._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      Dialog.alert(
        m(msg("Could not send queued message")),
        errorDisplayMessage(error, m) ?? m(msg("Try again.")),
      );
    }
  };

  const canReorder = workflow?.canReorder === true && queuedRuns.length > 1;
  const sourceLayout = dragRows?.find((row) => row.id === draggedRunId);
  const lastLayout = dragRows?.at(-1);
  const insertionOffset =
    previewBeforeRunId === undefined
      ? undefined
      : previewBeforeRunId === null
        ? lastLayout?.y === undefined || lastLayout.height === undefined
          ? undefined
          : lastLayout.y + lastLayout.height
        : dragRows?.find((row) => row.id === previewBeforeRunId)?.y;
  const queueRows = () =>
    queuedRuns.map(({ run }) => ({ id: run.id, ...rowLayouts.current.get(run.id) }));
  const content = (
    <ScrollView
      nestedScrollEnabled
      className="flex-1"
      scrollEnabled={draggedRunId === null}
      // UIKit must inset content beneath the floating translucent iOS header.
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="px-5 pb-6"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
    >
      {workflow?.isHeld && queuedRuns.length > 0 ? (
        <View className="gap-2 py-3">
          <Text className="text-sm text-foreground-muted">
            <T>Queue paused</T>
          </Text>
          <Button
            label={gt("Resume queue")}
            disabled={resuming || busyRunId !== null}
            onPress={async () => {
              if (busyRef.current) return;
              busyRef.current = true;
              setResuming(true);
              const result = await resumeHeldQueue({
                ...target,
                input: { threadId: target.threadId },
              });
              busyRef.current = false;
              setResuming(false);
              // A usage limit holds the queue until the composer's Resume thread continues the run.
              if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                const error = squashAtomCommandFailure(result);
                Dialog.alert(
                  gt("Could not resume queue"),
                  errorDisplayMessage(error, m) ?? gt("Try again."),
                );
              }
            }}
          />
        </View>
      ) : null}
      {editBlockedReason !== null && queuedRuns.length > 0 ? (
        <Text className="py-3 text-sm text-foreground-muted">{editBlockedReason}</Text>
      ) : null}
      {queuedRuns.length === 0 ? (
        <Text className="pt-6 text-center text-sm text-foreground-muted">
          <T>No messages waiting in this queue.</T>
        </Text>
      ) : null}
      {queuedRuns.map(({ run, text, attachments, context, message }, index) => {
        const layout = dragRows?.find((row) => row.id === run.id);
        const offset =
          sourceLayout?.y !== undefined &&
          sourceLayout.height !== undefined &&
          layout?.y !== undefined &&
          insertionOffset !== undefined
            ? threadDragGapOffset(layout.y, sourceLayout.y, sourceLayout.height, insertionOffset)
            : 0;
        const controls = resolveThreadQueueRowControls({
          busy: busyRunId !== null || draggedRunId !== null,
          // A fresh message starts its own turn: it may skip compaction, but not steer into a turn.
          canPromoteToSteer:
            (workflow?.canPromoteToSteer ?? false) &&
            (run.freshContext !== true || workflow?.promoteSkipsCompaction === true),
          canSendNow: workflow?.canSendNow ?? false,
          canReorder: workflow?.canReorder ?? false,
          editBlocked: editBlockedReason !== null,
          index,
          isEditing: editing?.runId === run.id,
          isGuestMessage: context?.guest !== undefined,
          queuedCount: queuedRuns.length,
          text,
        });
        const title =
          controls.displayText ||
          (attachments.length > 0 ? gt("Attachments") : gt("Queued message"));
        return (
          <QueueShiftedRow
            key={run.id}
            offset={offset}
            dragging={draggedRunId !== null}
            lifted={draggedRunId === run.id}
            onLayout={({ nativeEvent }) => rowLayouts.current.set(run.id, nativeEvent.layout)}
          >
            <Animated.View
              className="flex-row items-center border-b border-border bg-sheet"
              style={
                draggedRunId === run.id
                  ? { transform: [{ translateY: translation }], zIndex: 1, opacity: 0.85 }
                  : undefined
              }
            >
              {canReorder ? (
                // Keep the vertical handle outside the sideways swipeable so their pans do not race.
                <QueueDragHandle
                  disabled={busyRunId !== null}
                  title={title}
                  canMoveUp={controls.canMoveUp}
                  canMoveDown={controls.canMoveDown}
                  onStep={(action) => void act(run.id, action)}
                  onStart={() => {
                    const rows = queueRows();
                    const beforeRunId = resolveQueueDragBeforeRunId(rows, run.id, 0);
                    drag.current = { runId: run.id, order, beforeRunId, rows };
                    translation.setValue(0);
                    setDragState({ ...drag.current });
                    void Haptics.selectionAsync();
                  }}
                  onMove={(y) => {
                    const current = drag.current;
                    if (current?.runId !== run.id || current.order !== order) return;
                    translation.setValue(y);
                    const before = resolveQueueDragBeforeRunId(current.rows, run.id, y);
                    if (current.beforeRunId !== before) {
                      current.beforeRunId = before;
                      setDragState({ ...current });
                    }
                  }}
                  onEnd={(y, success) => {
                    const started = drag.current;
                    const stop = () => {
                      if (drag.current !== started) return;
                      drag.current = null;
                      setDragState(null);
                      translation.setValue(0);
                    };
                    if (!success || started?.order !== order || started.runId !== run.id) {
                      stop();
                      return;
                    }
                    const before = resolveQueueDropBeforeRunId(started.rows, run.id, y);
                    if (before === undefined) {
                      stop();
                      return;
                    }
                    const source = started.rows.find((row) => row.id === run.id);
                    const tail = started.rows.at(-1);
                    const insertion =
                      before === null
                        ? tail?.y !== undefined && tail.height !== undefined
                          ? tail.y + tail.height
                          : undefined
                        : started.rows.find((row) => row.id === before)?.y;
                    if (
                      source?.y !== undefined &&
                      source.height !== undefined &&
                      insertion !== undefined
                    ) {
                      Animated.timing(translation, {
                        toValue: insertion - source.y - (insertion > source.y ? source.height : 0),
                        duration: 160,
                        useNativeDriver: true,
                      }).start();
                    }
                    started.beforeRunId = before;
                    setDragState({ ...started });
                    void move(run.id, before).finally(stop);
                  }}
                />
              ) : null}
              <QueueRowSwipeable
                enabled={draggedRunId === null && busyRunId === null && controls.canDismiss}
                background={theme["--color-sheet"]}
                onRemove={() => void act(run.id, "remove")}
              >
                <View className="flex-row items-center">
                  <Menu
                    accessibilityLabel={translateCopy("Actions for queued message {value0}", {
                      value0: index + 1,
                    })}
                    shouldOpenOnLongPress
                    style={{ flex: 1 }}
                    actions={[
                      ...(workflow?.canPromoteToSteer || workflow?.canSendNow
                        ? [
                            {
                              id: "steer",
                              title: workflow?.canSendNow
                                ? translateCopy("Send now")
                                : translateCopy("Steer now"),
                              attributes: {
                                disabled: !controls.canSend || run.queueEditId != null,
                              },
                              image: "arrow.turn.left.up",
                            },
                          ]
                        : []),
                      {
                        id: "edit",
                        title: gt("Edit", { $context: "verb, menu action" }),
                        attributes: { disabled: !controls.canEdit },
                        image: "pencil",
                      },
                      {
                        id: "up",
                        title: translateCopy("Move up"),
                        attributes: { disabled: !controls.canMoveUp },
                      },
                      {
                        id: "down",
                        title: translateCopy("Move down"),
                        attributes: { disabled: !controls.canMoveDown },
                      },
                      {
                        id: "remove",
                        title: translateCopy("Remove"),
                        attributes: { disabled: !controls.canDismiss, destructive: true },
                      },
                    ]}
                    onPressAction={({ nativeEvent }) =>
                      void act(run.id, nativeEvent.event as QueueAction)
                    }
                  >
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={title}
                      accessibilityHint={
                        controls.canEdit
                          ? gt("Opens this message in the composer for editing")
                          : (editBlockedReason ?? undefined)
                      }
                      disabled={!controls.canEdit}
                      onPress={() => void act(run.id, "edit")}
                      className="min-h-14 flex-row items-center gap-2.5 py-2.5 active:opacity-70"
                    >
                      <QueueAttachmentThumbnails
                        environmentId={target.environmentId}
                        attachments={attachments}
                        onPressPreview={setPreviewFile}
                      />
                      <View className="min-w-0 flex-1 gap-1">
                        {message ? (
                          <QueuedRunSender environmentId={target.environmentId} message={message} />
                        ) : null}
                        <Text
                          className={
                            controls.isEditing
                              ? "min-w-0 flex-1 text-sm text-foreground-muted"
                              : "min-w-0 flex-1 text-sm text-foreground"
                          }
                          numberOfLines={1}
                        >
                          {context?.guest === undefined ? null : (
                            <Text className="font-t3-medium text-adaptive-fuchsia-600-300">
                              {`${context.guest.name}  `}
                            </Text>
                          )}
                          {title}
                        </Text>
                      </View>
                      {controls.isEditing || run.queueEditId != null ? (
                        <Text className="shrink-0 text-2xs uppercase tracking-wide text-primary">
                          <T>Editing</T>
                        </Text>
                      ) : null}
                    </Pressable>
                  </Menu>
                  {workflow?.canPromoteToSteer || workflow?.canSendNow ? (
                    // Outside the edit row and full row height, so a near miss never opens the editor.
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={
                        workflow?.canSendNow
                          ? translateCopy("Send message {value0} now", { value0: index + 1 })
                          : translateCopy("Steer with message {value0} now", { value0: index + 1 })
                      }
                      disabled={!controls.canSend || run.queueEditId != null}
                      onPress={() => void act(run.id, "steer")}
                      className="shrink-0 justify-center self-stretch pl-4 active:opacity-70 disabled:opacity-40"
                    >
                      <View className="min-h-9 flex-row items-center gap-1.5 rounded-full bg-primary px-4">
                        <SymbolView
                          name={workflow?.canSendNow ? "arrow.up" : "arrow.turn.left.up"}
                          size={13}
                          tintColorClassName="accent-primary-foreground"
                        />
                        <Text className="font-t3-medium text-sm text-primary-foreground">
                          {workflow?.canSendNow
                            ? translateCopy("Send now")
                            : translateCopy("Steer")}
                        </Text>
                      </View>
                    </Pressable>
                  ) : null}
                </View>
              </QueueRowSwipeable>
            </Animated.View>
          </QueueShiftedRow>
        );
      })}
    </ScrollView>
  );

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <View collapsable={false} className="flex-1 bg-sheet">
        <SheetHeader
          title={gt("Queued", { $context: "title of the queued messages sheet" })}
          onClose={() => navigation.goBack()}
        />
        <ScreenContent>{content}</ScreenContent>
      </View>
      <FilePreviewModal source={previewFile} onRequestClose={() => setPreviewFile(null)} />
    </GestureHandlerRootView>
  );
}

function QueueShiftedRow(props: {
  readonly offset: number;
  readonly dragging: boolean;
  readonly lifted: boolean;
  readonly onLayout: React.ComponentProps<typeof View>["onLayout"];
  readonly children: React.ReactNode;
}) {
  const { dragging, offset } = props;
  const style = useAnimatedStyle(() => ({
    transform: [
      {
        translateY: dragging
          ? withTiming(offset, { duration: 160, reduceMotion: ReduceMotion.System })
          : offset,
      },
    ],
  }));
  return (
    <Reanimated.View onLayout={props.onLayout} style={[style, { zIndex: props.lifted ? 1 : 0 }]}>
      {props.children}
    </Reanimated.View>
  );
}

function QueueRowSwipeable(props: {
  readonly enabled: boolean;
  readonly background: string;
  readonly onRemove: () => void;
  readonly children: React.ReactNode;
}) {
  const swipeableRef = useRef<SwipeableMethods | null>(null);
  const gt = useGT();
  const m = useMessages();
  return (
    <ReanimatedSwipeable
      ref={swipeableRef}
      enabled={props.enabled}
      friction={2}
      rightThreshold={40}
      overshootRight={false}
      // Require a clearly sideways swipe to avoid competing with sheet scroll and drag handles.
      failOffsetY={[-12, 12]}
      containerStyle={{ backgroundColor: props.background, flex: 1 }}
      childrenContainerStyle={{ backgroundColor: props.background }}
      onSwipeableOpen={(direction) => {
        if (direction !== "right") return;
        swipeableRef.current?.close();
        props.onRemove();
      }}
      renderRightActions={() => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={m(REMOVE_QUEUED_MESSAGE_ACCESSIBILITY_LABEL)}
          disabled={!props.enabled}
          onPress={() => {
            swipeableRef.current?.close();
            props.onRemove();
          }}
          className="items-center justify-center bg-danger active:opacity-70 disabled:opacity-40"
          style={{ width: REMOVE_ACTION_WIDTH }}
        >
          <SymbolView name="trash" size={16} tintColorClassName="accent-danger-foreground" />
          <Text className="pt-1 text-2xs font-t3-medium text-danger-foreground">
            {gt("Remove", { $context: "verb, menu action" })}
          </Text>
        </Pressable>
      )}
    >
      {props.children}
    </ReanimatedSwipeable>
  );
}

function QueueAttachmentThumbnails(props: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly onPressPreview: (source: FilePreviewSource) => void;
}) {
  const images = props.attachments.filter((attachment) => attachment.mimeType.startsWith("image/"));
  const gallery = images.map((attachment) => queueImagePreview(props.environmentId, attachment));
  const shown = images.slice(0, THUMBNAIL_LIMIT);
  const overflow = props.attachments.length - shown.length;
  if (props.attachments.length === 0) return null;
  return (
    <View className="shrink-0 flex-row items-center gap-1">
      {shown.map((attachment) => (
        <QueueAttachmentThumbnail
          key={attachment.id}
          environmentId={props.environmentId}
          attachment={attachment}
          onPress={() =>
            props.onPressPreview({
              ...queueImagePreview(props.environmentId, attachment),
              gallery,
            })
          }
        />
      ))}
      {overflow > 0 ? (
        <View className="h-6 min-w-6 items-center justify-center rounded bg-subtle px-1">
          <Text className="text-2xs tabular-nums text-foreground-muted">
            {shown.length === 0 ? `${overflow}` : `+${overflow}`}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function queueAttachmentResource(attachment: ChatAttachment) {
  return {
    _tag: "attachment",
    attachmentId: attachment.id,
    fileName: attachment.name,
    mimeType: attachment.mimeType,
    disposition: "inline",
  } as const;
}

function queueImagePreview(environmentId: EnvironmentId, attachment: ChatAttachment) {
  const resource = queueAttachmentResource(attachment);
  return {
    kind: "image",
    environmentId,
    resource,
    name: attachment.name,
    mimeType: attachment.mimeType,
    actionsSource: {
      name: attachment.name,
      mimeType: attachment.mimeType,
      environmentId,
      resource,
    },
  } as const;
}

function QueueAttachmentThumbnail(props: {
  readonly environmentId: EnvironmentId;
  readonly attachment: ChatAttachment;
  readonly onPress: () => void;
}) {
  const resource = queueAttachmentResource(props.attachment);
  const url = useAssetUrl(props.environmentId, resource);
  const gt = useGT();
  return (
    // Its own press target, so tapping an image previews it instead of editing the message.
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={gt("Open {name}", { name: props.attachment.name })}
      hitSlop={6}
      onPress={props.onPress}
      className="active:opacity-70"
    >
      {url === null ? (
        <View className="h-6 w-6 rounded bg-subtle" />
      ) : (
        <Image
          source={assetImageSource(props.environmentId, resource, url)}
          cachePolicy="memory-disk"
          contentFit="cover"
          style={{ width: 24, height: 24, borderRadius: 4 }}
          accessibilityIgnoresInvertColors
        />
      )}
    </Pressable>
  );
}

function QueueDragHandle(props: {
  disabled: boolean;
  title: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onStep: (action: "up" | "down") => void;
  onStart: () => void;
  onMove: (y: number) => void;
  onEnd: (y: number, success: boolean) => void;
}) {
  const translateCopy = useCopyTranslation();

  const onStart = useEffectEvent(() => props.onStart());
  const onMove = useEffectEvent((y: number) => props.onMove(y));
  const onEnd = useEffectEvent((y: number, success: boolean) => props.onEnd(y, success));
  // oxlint-disable-next-line react/capitalized-calls -- Gesture.Pan is a gesture factory, not a React component.
  const gesture = Gesture.Pan()
    .enabled(!props.disabled)
    .minDistance(0)
    .shouldCancelWhenOutside(false)
    .runOnJS(true)
    .onStart(() => onStart())
    .onUpdate((event) => onMove(event.translationY))
    .onFinalize((event, success) => onEnd(event.translationY, success));
  return (
    <GestureDetector gesture={gesture}>
      <View
        collapsable={false}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={translateCopy("Reorder {value0}", { value0: props.title })}
        accessibilityState={{ disabled: props.disabled }}
        accessibilityActions={[
          ...(props.canMoveUp ? [{ name: "decrement", label: translateCopy("Move up") }] : []),
          ...(props.canMoveDown ? [{ name: "increment", label: translateCopy("Move down") }] : []),
        ]}
        onAccessibilityAction={({ nativeEvent }) => {
          if (props.disabled) return;
          if (nativeEvent.actionName === "decrement" && props.canMoveUp) props.onStep("up");
          if (nativeEvent.actionName === "increment" && props.canMoveDown) props.onStep("down");
        }}
        className="h-12 w-8 items-center justify-center"
      >
        <SymbolView
          name="line.3.horizontal"
          size={16}
          tintColorClassName="accent-foreground-muted"
        />
      </View>
    </GestureDetector>
  );
}

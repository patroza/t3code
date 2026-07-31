// Migration 35 was skipped when pre-restack databases had already recorded
// ProjectionQueuedMessages as migration 35. Integration reached migration 38
// before the collision was detected, so this repair must follow it.
export { default } from "./035_ProjectionThreadTitleRegeneration.ts";

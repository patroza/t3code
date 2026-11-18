import { msg } from "gt-react-native";
import { m as resolveCopy } from "../../i18n/messages";
import * as Cause from "effect/Cause";

export type ThreadListAction = "archive" | "unarchive" | "delete" | "settle" | "unsettle";

const ACTION_VERBS: Record<ThreadListAction, string> = {
  archive: "archived",
  unarchive: "unarchived",
  delete: "deleted",
  settle: "settled",
  unsettle: "un-settled",
};

export function actionFailureMessage(
  action: ThreadListAction,
  cause: Cause.Cause<unknown>,
): string {
  const error = Cause.squash(cause);
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return resolveCopy(msg("The thread could not be {value0}.", { value0: ACTION_VERBS[action] }));
}

export function actionFailureTitle(action: ThreadListAction): string {
  if (action === "archive") return resolveCopy(msg("Could not archive thread"));
  if (action === "unarchive") return resolveCopy(msg("Could not unarchive thread"));
  if (action === "settle") return resolveCopy(msg("Could not settle thread"));
  if (action === "unsettle") return resolveCopy(msg("Could not un-settle thread"));
  return resolveCopy(msg("Could not delete thread"));
}

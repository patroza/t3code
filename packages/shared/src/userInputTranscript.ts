import type { OrchestrationThreadActivity, UserInputQuestion } from "@t3tools/contracts";

export interface ResolvedUserInputAnswer {
  readonly questionId: string;
  readonly header: string;
  readonly question: string;
  readonly answer: string;
}

export interface ResolvedUserInputTranscript {
  readonly activityId: string;
  readonly requestId: string;
  readonly createdAt: string;
  readonly turnId: OrchestrationThreadActivity["turnId"];
  readonly answers: ReadonlyArray<ResolvedUserInputAnswer>;
  readonly preview: string;
  readonly detail: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseQuestions(value: unknown): ReadonlyArray<UserInputQuestion> | null {
  if (!Array.isArray(value)) return null;
  const parsed = value.filter((entry): entry is UserInputQuestion => {
    const question = record(entry);
    return (
      typeof question?.id === "string" &&
      typeof question.header === "string" &&
      typeof question.question === "string" &&
      Array.isArray(question.options)
    );
  });
  return parsed.length === value.length && parsed.length > 0 ? parsed : null;
}

function formatAnswer(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (Array.isArray(value)) {
    const values = value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    return values.length > 0 ? values.join(", ") : null;
  }
  if (value === null || value === undefined) return null;
  return String(value);
}

function compareActivities(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    return left.sequence - right.sequence;
  }
  return left.createdAt.localeCompare(right.createdAt);
}

export function deriveResolvedUserInputTranscripts(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<ResolvedUserInputTranscript> {
  const questionsByRequestId = new Map<string, ReadonlyArray<UserInputQuestion>>();
  const transcripts: ResolvedUserInputTranscript[] = [];

  for (const activity of [...activities].toSorted(compareActivities)) {
    const payload = record(activity.payload);
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : null;
    if (!requestId) continue;

    if (activity.kind === "user-input.requested") {
      const questions = parseQuestions(payload?.questions);
      if (questions) questionsByRequestId.set(requestId, questions);
      continue;
    }
    if (activity.kind !== "user-input.resolved") continue;

    const questions = questionsByRequestId.get(requestId);
    const rawAnswers = record(payload?.answers);
    if (!questions || !rawAnswers) continue;

    const answers = questions.flatMap<ResolvedUserInputAnswer>((question) => {
      const answer = formatAnswer(rawAnswers[question.id]);
      return answer
        ? [
            {
              questionId: question.id,
              header: question.header,
              question: question.question,
              answer,
            },
          ]
        : [];
    });
    if (answers.length === 0) continue;

    transcripts.push({
      activityId: activity.id,
      requestId,
      createdAt: activity.createdAt,
      turnId: activity.turnId,
      answers,
      preview: answers.map((entry) => entry.answer).join(" · "),
      detail: answers.map((entry) => `${entry.question}\n${entry.answer}`).join("\n\n"),
    });
  }

  return transcripts;
}

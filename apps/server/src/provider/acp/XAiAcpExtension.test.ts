// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect } from "vite-plus/test";

import {
  extractXAiAskUserQuestions,
  extractXAiExitPlanModePlanMarkdown,
  makeXAiAskUserQuestionCancelledResponse,
  makeXAiAskUserQuestionResponse,
  makeXAiExitPlanModeAbandonedResponse,
  makeXAiExitPlanModeApprovedResponse,
  makeXAiExitPlanModeRejectedResponse,
  makeXAiPromptCompletionRuntime,
  resolveXAiExitPlanModeFromFollowUp,
  XAiAskUserQuestionRequest,
  XAiExitPlanModeRequest,
} from "./XAiAcpExtension.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

const makePromptCompletionRuntime = (env: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const runtime = yield* AcpSessionRuntime.make({
      spawn: {
        command: process.execPath,
        args: [mockAgentPath],
        env,
      },
      cwd: process.cwd(),
      clientInfo: { name: "t3-test", version: "0.0.0" },
      authMethodId: "test",
    });
    return yield* makeXAiPromptCompletionRuntime(runtime);
  });

const decodeXAiAskUserQuestionRequest = Schema.decodeUnknownSync(XAiAskUserQuestionRequest);

describe("XAiAcpExtension", () => {
  it("extracts questions from the real xAI ask_user_question payload shape", () => {
    const questions = extractXAiAskUserQuestions({
      sessionId: "session-1",
      toolCallId: "tool-call-1",
      mode: "default",
      questions: [
        {
          id: "scope",
          question: "Which scope should Grok use?",
          options: [
            { label: "Workspace", description: "Use the current workspace" },
            { label: "Session", description: "Only use this session" },
          ],
        },
      ],
    });

    expect(questions).toEqual([
      {
        id: "scope",
        header: "Question",
        question: "Which scope should Grok use?",
        multiSelect: false,
        options: [
          { label: "Workspace", description: "Use the current workspace" },
          { label: "Session", description: "Only use this session" },
        ],
      },
    ]);
  });

  it("extracts questions from wrapped _x.ai extension payloads", () => {
    const payload = {
      method: "_x.ai/ask_user_question",
      params: {
        sessionId: "session-1",
        toolCallId: "tool-call-1",
        mode: "plan",
        questions: [
          {
            question: "Which changes should be included?",
            multiSelect: true,
            options: [{ label: "Tests" }, { label: "Docs" }],
          },
        ],
      },
    };
    const decoded = decodeXAiAskUserQuestionRequest(payload);
    const questions = extractXAiAskUserQuestions(decoded);

    expect(questions).toEqual([
      {
        id: "Which changes should be included?",
        header: "Question",
        question: "Which changes should be included?",
        multiSelect: true,
        options: [
          { label: "Tests", description: "Tests" },
          { label: "Docs", description: "Docs" },
        ],
      },
    ]);
  });

  it("treats nullable multiSelect from Grok as single-select", () => {
    const questions = extractXAiAskUserQuestions({
      sessionId: "session-1",
      toolCallId: "tool-call-1",
      mode: "default",
      questions: [
        {
          question: "Which label should Grok use?",
          multiSelect: null,
          options: [
            { label: "Alpha", description: "Use the Alpha label" },
            { label: "Beta", description: "Use the Beta label" },
            { label: "Other", description: "Use the Other label" },
          ],
        },
      ],
    });

    expect(questions).toEqual([
      {
        id: "Which label should Grok use?",
        header: "Question",
        question: "Which label should Grok use?",
        multiSelect: false,
        options: [
          { label: "Alpha", description: "Use the Alpha label" },
          { label: "Beta", description: "Use the Beta label" },
          { label: "Other", description: "Use the Other label" },
        ],
      },
    ]);
  });

  it("maps UI question ids back to xAI question text in accepted responses", () => {
    const response = makeXAiAskUserQuestionResponse(
      {
        sessionId: "session-1",
        toolCallId: "tool-call-1",
        mode: "default",
        questions: [
          {
            id: "scope",
            question: "Which scope should Grok use?",
            options: [
              { label: "workspace", description: "Use the current workspace" },
              { label: "session", description: "Only use this session" },
            ],
          },
        ],
      },
      { scope: "workspace" },
    );

    expect(response).toEqual({
      outcome: "accepted",
      answers: {
        "Which scope should Grok use?": ["workspace"],
      },
    });
  });

  it("orders accepted answers by the original xAI question order", () => {
    const response = makeXAiAskUserQuestionResponse(
      {
        sessionId: "session-1",
        toolCallId: "tool-call-1",
        mode: "default",
        questions: [
          {
            id: "first",
            question: "First question?",
            options: [{ label: "A", description: "A" }],
          },
          {
            id: "second",
            question: "Second question?",
            options: [{ label: "B", description: "B" }],
          },
        ],
      },
      {
        second: "B",
        first: "A",
      },
    );

    expect(Object.keys(response.answers)).toEqual(["First question?", "Second question?"]);
    expect(response).toMatchObject({
      outcome: "accepted",
      answers: {
        "First question?": ["A"],
        "Second question?": ["B"],
      },
    });
  });

  it("encodes typed custom answers as xAI Other annotations", () => {
    const response = makeXAiAskUserQuestionResponse(
      {
        method: "x.ai/ask_user_question",
        params: {
          sessionId: "session-1",
          toolCallId: "tool-call-1",
          mode: "default",
          questions: [
            {
              question: "Which ice cream flavor?",
              options: [
                { label: "vanilla", description: "Vanilla flavor" },
                { label: "chocolate", description: "Chocolate flavor" },
              ],
            },
          ],
        },
      },
      { "Which ice cream flavor?": "pistachio" },
    );

    expect(response).toEqual({
      outcome: "accepted",
      answers: {
        "Which ice cream flavor?": ["Other"],
      },
      annotations: {
        "Which ice cream flavor?": {
          notes: "pistachio",
        },
      },
    });
  });

  it("encodes interrupted dialogs as xAI cancelled responses", () => {
    expect(makeXAiAskUserQuestionCancelledResponse()).toEqual({
      outcome: "cancelled",
    });
  });

  it("does not echo preview annotations for multi-select answers", () => {
    const response = makeXAiAskUserQuestionResponse(
      {
        sessionId: "session-1",
        toolCallId: "tool-call-1",
        mode: "default",
        questions: [
          {
            question: "Which files should Grok touch?",
            multiSelect: true,
            options: [
              {
                label: "Tests",
                description: "Update tests",
                preview: "test preview",
              },
              {
                label: "Docs",
                description: "Update docs",
                preview: "docs preview",
              },
            ],
          },
        ],
      },
      { "Which files should Grok touch?": ["Tests", "Docs"] },
    );

    expect(response).toEqual({
      outcome: "accepted",
      answers: {
        "Which files should Grok touch?": ["Tests", "Docs"],
      },
    });
  });

  it("decodes _x.ai/exit_plan_mode request payloads and extracts plan markdown", () => {
    const decode = Schema.decodeUnknownSync(XAiExitPlanModeRequest);
    const flat = decode({
      sessionId: "session-1",
      toolCallId: "tool-1",
      planContent: "# Plan\n\n- step\n",
    });
    expect(extractXAiExitPlanModePlanMarkdown(flat)).toBe("# Plan\n\n- step\n");

    const wrapped = decode({
      method: "_x.ai/exit_plan_mode",
      params: {
        sessionId: "session-1",
        toolCallId: "tool-1",
        planContent: null,
      },
    });
    expect(extractXAiExitPlanModePlanMarkdown(wrapped)).toBeUndefined();
  });

  it("builds exit_plan_mode response outcomes and maps follow-up turns", () => {
    expect(makeXAiExitPlanModeApprovedResponse()).toEqual({ outcome: "approved" });
    expect(makeXAiExitPlanModeApprovedResponse(" ship it ")).toEqual({
      outcome: "approved",
      feedback: "ship it",
    });
    expect(makeXAiExitPlanModeRejectedResponse("use REST")).toEqual({
      outcome: "rejected",
      feedback: "use REST",
    });
    expect(makeXAiExitPlanModeAbandonedResponse()).toEqual({ outcome: "abandoned" });

    expect(
      resolveXAiExitPlanModeFromFollowUp({
        interactionMode: "default",
        text: "PLEASE IMPLEMENT THIS PLAN:\n# Plan",
      }),
    ).toEqual({ outcome: "approved" });
    expect(
      resolveXAiExitPlanModeFromFollowUp({
        interactionMode: "plan",
        text: "prefer a smaller approach",
      }),
    ).toEqual({ outcome: "rejected", feedback: "prefer a smaller approach" });
    expect(
      resolveXAiExitPlanModeFromFollowUp({
        interactionMode: "plan",
        text: "  ",
      }),
    ).toEqual({ outcome: "abandoned" });
  });

  it.effect("resolves a hung standard prompt from xAI prompt completion", () =>
    Effect.gen(function* () {
      const runtime = yield* makePromptCompletionRuntime({
        T3_ACP_EMIT_XAI_PROMPT_COMPLETE_THEN_HANG: "1",
      });
      yield* runtime.start();

      const promptResult = yield* runtime.prompt({
        prompt: [{ type: "text", text: "hi" }],
      });
      const promptId = promptResult._meta?.promptId;

      expect(typeof promptId).toBe("string");
      expect(promptResult).toMatchObject({
        stopReason: "end_turn",
        _meta: {
          sessionId: "mock-session-1",
          promptId,
          requestId: promptId,
        },
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("ignores stale xAI completion from an already settled prompt", () =>
    Effect.gen(function* () {
      const runtime = yield* makePromptCompletionRuntime({
        T3_ACP_EMIT_STALE_XAI_PROMPT_COMPLETE_BEFORE_SECOND_HANG: "1",
      });
      yield* runtime.start();

      const firstPromptResult = yield* runtime.prompt({
        prompt: [{ type: "text", text: "first" }],
      });
      expect(firstPromptResult).toMatchObject({
        stopReason: "end_turn",
        _meta: { promptId: "mock-stale-xai-prompt-1" },
      });

      const secondPromptResult = yield* runtime.prompt({
        prompt: [{ type: "text", text: "second" }],
      });
      const secondPromptId = secondPromptResult._meta?.promptId;
      expect(typeof secondPromptId).toBe("string");
      expect(secondPromptId).not.toBe("mock-stale-xai-prompt-1");
      expect(secondPromptResult).toMatchObject({
        stopReason: "end_turn",
        _meta: {
          promptId: secondPromptId,
          requestId: secondPromptId,
        },
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as Generator from "./generate.ts";

const isGeneratorFetchError = Schema.is(Generator.GeneratorFetchError);
const isGeneratorDirectoryDecodeError = Schema.is(Generator.GeneratorDirectoryDecodeError);
const isGeneratorSchemaDocumentDecodeError = Schema.is(
  Generator.GeneratorSchemaDocumentDecodeError,
);
const isGeneratorFormatExitError = Schema.is(Generator.GeneratorFormatExitError);
const isGeneratorSchemaNameParseError = Schema.is(Generator.GeneratorSchemaNameParseError);
const isGeneratorSchemaValueDeclarationMissingError = Schema.is(
  Generator.GeneratorSchemaValueDeclarationMissingError,
);

const httpClient = (response: Response) =>
  HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, response)));

function processHandle(exitCode: number) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

describe("Codex schema generator errors", () => {
  it.effect("retains safe URL diagnostics and the HTTP cause when fetching fails", () =>
    Effect.gen(function* () {
      const url =
        "https://generator-user:generator-password@example.test/private/schema.json?token=generator-secret#fragment";
      const error = yield* Generator.fetchText(url).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          httpClient(new Response("unavailable", { status: 503 })),
        ),
        Effect.flip,
      );

      assert(isGeneratorFetchError(error));
      expect(error).toMatchObject({
        urlInputLength: url.length,
        urlProtocol: "https:",
        urlHostname: "example.test",
      });
      expect(error).not.toHaveProperty("url");
      expect(error.stage).toBe("request");
      expect(error.cause).toBeDefined();
      const { cause: _, ...directDiagnostics } = error;
      expect(directDiagnostics).not.toHaveProperty("url");
      expect(directDiagnostics.urlProtocol).toBe("https:");
      expect(directDiagnostics.urlHostname).toBe("example.test");
      expect(error.message).not.toMatch(
        /generator-user|generator-password|private|token|generator-secret|fragment/,
      );
    }),
  );

  it.effect("adds the GitHub directory path to listing decode failures", () =>
    Effect.gen(function* () {
      const error = yield* Generator.fetchDirectoryEntries("schema/json/v2").pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          httpClient(new Response("not-json", { status: 200 })),
        ),
        Effect.flip,
      );

      assert(isGeneratorDirectoryDecodeError(error));
      expect(error.directoryPath).toBe("schema/json/v2");
      expect(error).toMatchObject({
        urlProtocol: "https:",
        urlHostname: "api.github.com",
      });
      expect(error.urlInputLength).toBeGreaterThan(0);
      expect(error).not.toHaveProperty("url");
      expect(error.cause).toBeDefined();
      expect(error.message).toContain("schema/json/v2");
    }),
  );

  it.effect("adds repository and download context to schema decode failures", () =>
    Effect.gen(function* () {
      const repositoryPath = "codex-rs/app-server-protocol/schema/json/v2/Thread.json";
      const url = "https://raw.example.test/Thread.json";
      const error = yield* Generator.decodeSchemaDocument({
        repositoryPath,
        url,
        raw: "not-json",
      }).pipe(Effect.flip);

      assert(isGeneratorSchemaDocumentDecodeError(error));
      expect(error.repositoryPath).toBe(repositoryPath);
      expect(error).toMatchObject({
        urlInputLength: url.length,
        urlProtocol: "https:",
        urlHostname: "raw.example.test",
      });
      expect(error).not.toHaveProperty("url");
      expect(error.cause).toBeDefined();
      expect(error.message).toContain(repositoryPath);
    }),
  );

  it.effect("reports formatter commands and nonzero exit codes structurally", () => {
    let spawned: ChildProcess.StandardCommand | undefined;
    const spawner = ChildProcessSpawner.make((command) => {
      if (ChildProcess.isStandardCommand(command)) {
        spawned = command;
      }
      return Effect.succeed(processHandle(17));
    });

    return Effect.gen(function* () {
      const generatedDir = "/tmp/codex-generated";
      const error = yield* Generator.formatGeneratedFiles(generatedDir).pipe(Effect.flip);

      assert(isGeneratorFormatExitError(error));
      expect(error.command).toBe("vp");
      expect(error.argumentCount).toBe(3);
      expect(error).not.toHaveProperty("args");
      expect(error.generatedDir).toBe(generatedDir);
      expect(error.exitCode).toBe(17);
      expect(error.message).toContain("17");
      expect(spawned?.command).toBe("vp");
      expect(spawned?.args).toEqual(["fmt", generatedDir, "--write"]);
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
  });

  it.effect("returns malformed generated schema declarations as typed failures", () =>
    Effect.gen(function* () {
      const missingValueError = yield* Generator.collectSchemaEntries(
        "export type Session = string;",
      ).pipe(Effect.flip);
      assert(isGeneratorSchemaValueDeclarationMissingError(missingValueError));
      expect(missingValueError).toMatchObject({
        lineIndex: 0,
        typeDeclarationLength: 29,
        nextLinePresent: false,
      });
      expect(missingValueError).not.toHaveProperty("typeDeclaration");

      const nameParseError = yield* Generator.collectSchemaEntries(
        "export type @ = string;\nexport const invalid = Schema.String;",
      ).pipe(Effect.flip);
      assert(isGeneratorSchemaNameParseError(nameParseError));
      expect(nameParseError).toMatchObject({
        lineIndex: 0,
        typeDeclarationLength: 23,
      });
      expect(nameParseError).not.toHaveProperty("typeDeclaration");
    }),
  );
});

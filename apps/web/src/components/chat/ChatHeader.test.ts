import { EnvironmentId } from "@t3tools/contracts";
import {
  BearerConnectionProfile,
  BearerConnectionTarget,
  SshConnectionProfile,
  SshConnectionTarget,
  type ConnectionCatalogEntry,
} from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";
// @effect-diagnostics nodeBuiltinImport:off - existence contract reads source text on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveRemoteVscodeOpenTarget,
  shouldOfferRemoteVscodeOpen,
  shouldShowOpenInPicker,
} from "./ChatHeader";

const chatHeaderSource = NodeFS.readFileSync(
  NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "ChatHeader.tsx"),
  "utf8",
);

describe("shouldShowOpenInPicker", () => {
  const primaryEnvironmentId = EnvironmentId.make("environment-primary");

  it("shows the picker for projects in the primary environment", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
      }),
    ).toBe(true);
  });

  it("hides the picker when hosted static mode has no primary environment", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId: null,
      }),
    ).toBe(false);
  });

  it("hides the picker for remote environments", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId,
      }),
    ).toBe(false);
  });

  it("hides the picker when there is no active project", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: undefined,
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
      }),
    ).toBe(false);
  });
});

describe("shouldOfferRemoteVscodeOpen", () => {
  it("offers remote open for a named project when the local picker is hidden", () => {
    expect(
      shouldOfferRemoteVscodeOpen({
        activeProjectName: "codething-mvp",
        showOpenInPicker: false,
      }),
    ).toBe(true);
  });

  it("never offers remote open when the local OpenInPicker is shown", () => {
    expect(
      shouldOfferRemoteVscodeOpen({
        activeProjectName: "codething-mvp",
        showOpenInPicker: true,
      }),
    ).toBe(false);
  });

  it("never offers remote open without an active project", () => {
    expect(
      shouldOfferRemoteVscodeOpen({
        activeProjectName: undefined,
        showOpenInPicker: false,
      }),
    ).toBe(false);
  });
});

describe("resolveRemoteVscodeOpenTarget", () => {
  const environmentId = EnvironmentId.make("environment-remote");

  it("uses the environment label instead of a paired HTTP gateway", () => {
    const entry: ConnectionCatalogEntry = {
      target: new BearerConnectionTarget({
        environmentId,
        label: "remote-vm",
        connectionId: "bearer:remote-vm",
      }),
      profile: Option.some(
        new BearerConnectionProfile({
          connectionId: "bearer:remote-vm",
          environmentId,
          label: "remote-vm",
          httpBaseUrl: "http://gateway.example.test:8080/",
          wsBaseUrl: "ws://gateway.example.test:8080/",
        }),
      ),
    };

    expect(
      resolveRemoteVscodeOpenTarget({
        entry,
        cwd: "/home/tester/projects/example",
      }),
    ).toEqual({
      authority: "remote-vm",
      uri: "vscode://vscode-remote/ssh-remote+remote-vm/home/tester/projects/example?windowId=_blank",
    });
  });

  it("uses the stored SSH profile user and host when present", () => {
    const entry: ConnectionCatalogEntry = {
      target: new SshConnectionTarget({
        environmentId,
        label: "remote-host",
        connectionId: "ssh:remote-host",
      }),
      profile: Option.some(
        new SshConnectionProfile({
          connectionId: "ssh:remote-host",
          environmentId,
          label: "remote-host",
          target: {
            alias: "remote-host",
            hostname: "remote.example.test",
            username: "tester",
            port: null,
          },
        }),
      ),
    };

    expect(
      resolveRemoteVscodeOpenTarget({
        entry,
        cwd: "/home/tester/project with spaces",
      }),
    ).toEqual({
      authority: "tester@remote.example.test",
      uri: "vscode://vscode-remote/ssh-remote+tester%40remote.example.test/home/tester/project%20with%20spaces?windowId=_blank",
    });
  });

  it("returns null for non-absolute cwd, missing entry, or empty hostname", () => {
    expect(
      resolveRemoteVscodeOpenTarget({
        entry: null,
        cwd: "/home/tester/projects/example",
      }),
    ).toBeNull();
    expect(
      resolveRemoteVscodeOpenTarget({
        entry: {
          target: new BearerConnectionTarget({
            environmentId,
            label: "remote-vm",
            connectionId: "bearer:remote-vm",
          }),
          profile: Option.none(),
        },
        cwd: "/home/tester/projects/example",
      }),
    ).toBeNull();
    expect(
      resolveRemoteVscodeOpenTarget({
        entry: {
          target: new BearerConnectionTarget({
            environmentId,
            label: "remote-vm",
            connectionId: "bearer:remote-vm",
          }),
          profile: Option.some(
            new BearerConnectionProfile({
              connectionId: "bearer:remote-vm",
              environmentId,
              label: "remote-vm",
              httpBaseUrl: "http://gateway.example.test:8080/",
              wsBaseUrl: "ws://gateway.example.test:8080/",
            }),
          ),
        },
        cwd: "relative/path",
      }),
    ).toBeNull();
  });
});

describe("ChatHeader remote Open in VS Code surface (anti stack-drop)", () => {
  it("still wires the remote control through the pure gate into header JSX", () => {
    // Pure helpers alone are not enough: #154 proved stack recovery can keep
    // resolveRemoteVscodeOpenTarget while deleting the button. These markers
    // must remain co-located in ChatHeader.tsx.
    expect(chatHeaderSource).toContain("shouldOfferRemoteVscodeOpen");
    expect(chatHeaderSource).toContain("resolveRemoteVscodeOpenTarget");
    expect(chatHeaderSource).toContain("remoteVscodeTarget");
    expect(chatHeaderSource).toContain("Open in VS Code Remote SSH on");
    expect(chatHeaderSource).toContain("Open VS Code Remote SSH:");
    expect(chatHeaderSource).toContain("shell.openExternal");
    expect(chatHeaderSource).toContain("VisualStudioCode");
  });
});

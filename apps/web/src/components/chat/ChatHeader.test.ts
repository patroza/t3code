import { EnvironmentId } from "@t3tools/contracts";
import {
  BearerConnectionProfile,
  BearerConnectionTarget,
  SshConnectionProfile,
  SshConnectionTarget,
  type ConnectionCatalogEntry,
} from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { resolveRemoteVscodeOpenTarget, shouldShowOpenInPicker } from "./ChatHeader";

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

  it("keeps built-in applications visible when hosted static mode has no primary environment", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId: null,
      }),
    ).toBe(true);
  });

  it("keeps built-in applications visible for remote environments", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId,
      }),
    ).toBe(true);
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
});

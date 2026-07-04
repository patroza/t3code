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

describe("resolveRemoteVscodeOpenTarget", () => {
  const environmentId = EnvironmentId.make("environment-remote");

  it("builds a VS Code Remote SSH URL for a paired HTTP remote", () => {
    const entry: ConnectionCatalogEntry = {
      target: new BearerConnectionTarget({
        environmentId,
        label: "smart",
        connectionId: "bearer:smart",
      }),
      profile: Option.some(
        new BearerConnectionProfile({
          connectionId: "bearer:smart",
          environmentId,
          label: "smart",
          httpBaseUrl: "http://100.64.1.2:8080/",
          wsBaseUrl: "ws://100.64.1.2:8080/",
        }),
      ),
    };

    expect(
      resolveRemoteVscodeOpenTarget({
        entry,
        cwd: "/home/patroza/pj/macs/scanner",
      }),
    ).toEqual({
      authority: "patroza@100.64.1.2",
      uri: "vscode://vscode-remote/ssh-remote+patroza%40100.64.1.2/home/patroza/pj/macs/scanner",
    });
  });

  it("uses the stored SSH profile user and host when present", () => {
    const entry: ConnectionCatalogEntry = {
      target: new SshConnectionTarget({
        environmentId,
        label: "smart",
        connectionId: "ssh:smart",
      }),
      profile: Option.some(
        new SshConnectionProfile({
          connectionId: "ssh:smart",
          environmentId,
          label: "smart",
          target: {
            alias: "smart",
            hostname: "smart.local",
            username: "patroza",
            port: null,
          },
        }),
      ),
    };

    expect(
      resolveRemoteVscodeOpenTarget({
        entry,
        cwd: "/home/patroza/project with spaces",
      }),
    ).toEqual({
      authority: "patroza@smart.local",
      uri: "vscode://vscode-remote/ssh-remote+patroza%40smart.local/home/patroza/project%20with%20spaces",
    });
  });
});

import { createIdentityEnvironmentAtoms } from "@t3tools/client-runtime/state/identity";

import { connectionAtomRuntime } from "../connection/runtime";

export const identityEnvironment = createIdentityEnvironmentAtoms(connectionAtomRuntime);

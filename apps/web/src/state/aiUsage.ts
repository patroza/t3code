import { createAiUsageEnvironmentAtoms } from "@t3tools/client-runtime/state/ai-usage";

import { connectionAtomRuntime } from "../connection/runtime";

export const aiUsageEnvironment = createAiUsageEnvironmentAtoms(connectionAtomRuntime);

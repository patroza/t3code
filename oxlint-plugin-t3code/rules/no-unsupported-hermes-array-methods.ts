import { defineRule } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName } from "../utils.ts";

const unsupportedMethods = new Set(["toReversed", "toSorted", "toSpliced"]);
const mobileRuntimeRoots = ["apps/mobile/", "packages/client-runtime/", "packages/shared/"];

const normalizePath = (path: string) => path.replaceAll("\\", "/");

const isMobileRuntimeFile = (filename: string) => {
  const normalized = normalizePath(filename);
  return mobileRuntimeRoots.some(
    (root) => normalized.startsWith(root) || normalized.includes(`/${root}`),
  );
};

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow ES2023 change-by-copy array methods in code that can run on Expo's Hermes runtime.",
    },
  },
  createOnce(context) {
    return {
      MemberExpression(node) {
        if (!isMobileRuntimeFile(context.filename)) return;

        const property = getPropertyName(node.property);
        if (Option.isNone(property) || !unsupportedMethods.has(property.value)) return;

        context.report({
          node,
          message: `Hermes does not provide Array.prototype.${property.value}; copy the array and use its mutating equivalent instead.`,
        });
      },
    };
  },
});

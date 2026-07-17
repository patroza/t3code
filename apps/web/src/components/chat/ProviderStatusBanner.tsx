import { type ServerProvider } from "@t3tools/contracts";
import { memo } from "react";
import { InfoIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { formatProviderDriverKindLabel } from "../../providerModels";
import { ErrorDetailText } from "../ui/errorDetailText";

export const ProviderStatusBanner = memo(function ProviderStatusBanner({
  status,
}: {
  status: ServerProvider | null;
}) {
  if (!status || status.status === "ready" || status.status === "disabled") {
    return null;
  }

  const providerName = status.displayName?.trim() || formatProviderDriverKindLabel(status.driver);
  const isUnauthenticated = status.status === "error" && status.auth.status === "unauthenticated";
  const title = isUnauthenticated
    ? `${providerName} is unauthenticated`
    : `${providerName} provider status`;
  const message = isUnauthenticated
    ? "Sign in via the CLI to authenticate again."
    : (status.message ??
      (status.status === "error"
        ? `${providerName} provider is unavailable.`
        : `${providerName} provider has limited availability.`));

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pt-3 sm:px-6">
      <div
        className={cn(
          "flex w-full items-start gap-3 rounded-xl border px-3.5 py-3 text-card-foreground text-sm sm:px-4 sm:py-3.5",
          status.status === "warning"
            ? "border-warning/32 bg-warning/4 [&_svg]:text-warning"
            : "border-destructive/32 bg-destructive/4 text-destructive-foreground [&_svg]:text-destructive",
        )}
        role="alert"
      >
        <InfoIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="font-medium">{title}</div>
          <ErrorDetailText
            showCopy={status.status === "error"}
            text={message}
            textClassName="text-muted-foreground"
          />
        </div>
      </div>
    </div>
  );
});

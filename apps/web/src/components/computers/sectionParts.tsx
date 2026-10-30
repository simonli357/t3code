/** Small pieces the Computers page repeats: section headings, errors, empty notices, dates, badges. */
import { CircleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ExpandableText } from "../settings/ExpandableText";
import { useComputersClock } from "./computersClock";
import { formatAge, formatDatedAge, formatMoment, presentBackup } from "./computersFormat";
import type { BackupStatus } from "./computersViewModel";

export function SectionHeading({
  id,
  action,
  hidden = false,
  children,
}: {
  readonly id: string;
  readonly action?: ReactNode;
  /** Keep the heading for screen readers only, where the page title already says it. */
  readonly hidden?: boolean;
  readonly children: ReactNode;
}) {
  if (hidden) {
    return (
      <h2 id={id} className="sr-only">
        {children}
      </h2>
    );
  }
  return (
    <div className="flex min-h-8 items-center justify-between gap-3">
      <h2 id={id} className="text-sm font-medium text-foreground">
        {children}
      </h2>
      {action}
    </div>
  );
}

/** A concrete failure with the way out of it. The message is shown whole, never summarised. */
export function LoadError({
  title,
  message,
  onRetry,
}: {
  readonly title: string;
  readonly message: string;
  readonly onRetry?: () => void;
}) {
  return (
    <Alert variant="error">
      <CircleAlertIcon />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <ExpandableText text={message} />
      </AlertDescription>
      {onRetry ? (
        <AlertAction>
          <Button size="xs" variant="outline" onClick={onRetry}>
            Try again
          </Button>
        </AlertAction>
      ) : null}
    </Alert>
  );
}

/** A quiet "nothing here" for a list or section, with a line on why. */
export function EmptyNotice({
  icon,
  title,
  description,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly description?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-xl border border-dashed border-border/70 px-4 py-8 text-center">
      <div className="mb-1 text-muted-foreground [&_svg]:size-5">{icon}</div>
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description ? (
        <p className="max-w-md text-balance text-xs text-muted-foreground">{description}</p>
      ) : null}
    </div>
  );
}

type DatedTimeFormat = "dated-age" | "age" | "moment";

/**
 * A timestamp as the person reads it: "10/3 2:02 PM (19d ago)" so an old date looks old, or just the
 * age, or just the moment. An unreadable timestamp says so instead of showing a guess.
 */
export function DatedTime({
  iso,
  format = "dated-age",
}: {
  readonly iso: string;
  readonly format?: DatedTimeFormat;
}) {
  const { nowMs, timestampFormat } = useComputersClock();
  const text =
    format === "age"
      ? formatAge(iso, nowMs)
      : format === "moment"
        ? formatMoment(iso, nowMs, timestampFormat)
        : formatDatedAge(iso, nowMs, timestampFormat);
  return <time dateTime={iso}>{text ?? "Unknown time"}</time>;
}

const TONE_BADGE_VARIANT = {
  success: "success",
  warning: "warning",
  error: "error",
  info: "info",
  muted: "outline",
} as const;

export type Tone = keyof typeof TONE_BADGE_VARIANT;

export function ToneBadge({
  tone,
  children,
}: {
  readonly tone: Tone;
  readonly children: ReactNode;
}) {
  return <Badge variant={TONE_BADGE_VARIANT[tone]}>{children}</Badge>;
}

export function BackupBadge({ backup }: { readonly backup: BackupStatus }) {
  const { label, tone } = presentBackup(backup);
  return <ToneBadge tone={tone}>{label}</ToneBadge>;
}

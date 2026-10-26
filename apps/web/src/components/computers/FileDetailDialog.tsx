import { ArchiveIcon, ArchiveRestoreIcon, CheckIcon, CircleAlertIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Skeleton } from "~/components/ui/skeleton";
import { Spinner } from "~/components/ui/spinner";
import { useComputersClock } from "./computersClock";
import {
  FILE_LOCATION_LABELS,
  NOT_VERIFIED,
  formatBytes,
  formatDatedAge,
  normalizeKeepReason,
  normalizeRestoreDestination,
} from "./computersFormat";
import {
  KEEP_REASON_MAX_LENGTH,
  type ActionAvailability,
  type ActionState,
  type BackupStatus,
  type ComputersActions,
  type ComputersDetail,
  type FileDetail,
} from "./computersViewModel";
import { DetailDialog } from "./DetailDialog";
import { BackupBadge, DatedTime, LoadError } from "./sectionParts";

type FileDetailState = Extract<ComputersDetail, { kind: "file" }>;

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-0.5 px-3 py-2.5 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 wrap-anywhere text-sm text-foreground">{children}</dd>
    </div>
  );
}

function Unverified() {
  return <span className="text-muted-foreground">{NOT_VERIFIED}</span>;
}

function BackupFact({ backup }: { readonly backup: BackupStatus }) {
  return (
    <div className="flex flex-col items-start gap-1">
      <BackupBadge backup={backup} />
      {backup.state === "not-verified" ? (
        <p className="text-xs text-muted-foreground">
          No check has confirmed a backup copy of this file.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {backup.state === "confirmed"
            ? "A check found the copy"
            : "Kept in the archive; an independent backup has not been verified"}
          {backup.at ? (
            <>
              {" · "}
              <DatedTime iso={backup.at} />
            </>
          ) : null}
          {backup.where ? (
            <>
              {" · "}
              <span className="font-mono">{backup.where}</span>
            </>
          ) : null}
        </p>
      )}
    </div>
  );
}

function ActionMessage({ state }: { readonly state: ActionState }) {
  if (state.status === "failed") {
    return (
      <p role="alert" className="flex items-start gap-1.5 text-xs text-destructive-foreground">
        <CircleAlertIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        <span className="wrap-anywhere">{state.message}</span>
      </p>
    );
  }
  if (state.status === "done") {
    return (
      <p role="status" className="flex items-start gap-1.5 text-xs text-success-foreground">
        <CheckIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        <span className="wrap-anywhere">{state.message}</span>
      </p>
    );
  }
  return null;
}

function ActionSection({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

function KeepSection({
  file,
  state,
  onKeep,
}: {
  readonly file: FileDetail;
  readonly state: ActionState;
  readonly onKeep: ComputersActions["onKeep"];
}) {
  const reasonId = useId();
  const [reason, setReason] = useState("");
  const [validation, setValidation] = useState<string | null>(null);
  const submitting = state.status === "submitting";

  if (file.kept) {
    return (
      <ActionSection title="Kept">
        <p className="wrap-anywhere text-sm text-foreground">“{file.kept.reason}”</p>
        {file.kept.keptAt ? (
          <p className="text-xs text-muted-foreground">
            Kept <DatedTime iso={file.kept.keptAt} />
          </p>
        ) : null}
      </ActionSection>
    );
  }

  const availability: ActionAvailability = file.keep;
  return (
    <ActionSection
      title="Keep"
      description="Keep this in the kept archive so it stays after the work around it is cleaned up."
    >
      {availability.available ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (submitting) return;
            const result = normalizeKeepReason(reason);
            if (!result.ok) {
              setValidation(result.message);
              return;
            }
            setValidation(null);
            onKeep({ fileId: file.id, reason: result.value });
          }}
        >
          <Label htmlFor={reasonId}>Why keep it? One line.</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id={reasonId}
              value={reason}
              maxLength={KEEP_REASON_MAX_LENGTH}
              placeholder="For example: final drawings sent to the client"
              autoComplete="off"
              disabled={submitting}
              aria-invalid={validation !== null}
              onChange={(event) => {
                setReason(event.currentTarget.value);
                setValidation(null);
              }}
            />
            <Button type="submit" disabled={submitting}>
              {submitting ? <Spinner /> : <ArchiveIcon />}
              Keep
            </Button>
          </div>
          {validation ? (
            <p role="alert" className="text-xs text-destructive-foreground">
              {validation}
            </p>
          ) : null}
          <ActionMessage state={state} />
        </form>
      ) : (
        <p className="text-xs text-muted-foreground">{availability.reason}</p>
      )}
    </ActionSection>
  );
}

function RestoreSection({
  file,
  state,
  onRestore,
}: {
  readonly file: FileDetail;
  readonly state: ActionState;
  readonly onRestore: ComputersActions["onRestore"];
}) {
  const destinationId = useId();
  const [chosenTargetId, setChosenTargetId] = useState<string | null>(null);
  const [destination, setDestination] = useState("");
  const [validation, setValidation] = useState<string | null>(null);
  const submitting = state.status === "submitting";
  // What the person chose, else the first computer that can receive it: the targets may change while this is open.
  const target =
    file.restoreTargets.find((candidate) => candidate.computerId === chosenTargetId) ??
    file.restoreTargets.find((candidate) => candidate.online) ??
    file.restoreTargets[0];

  const availability: ActionAvailability = file.restore;
  let body: ReactNode;
  if (!availability.available) {
    body = <p className="text-xs text-muted-foreground">{availability.reason}</p>;
  } else if (file.restoreTargets.length === 0) {
    body = <p className="text-xs text-muted-foreground">No computer is available to restore to.</p>;
  } else {
    body = (
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (submitting || target === undefined || !target.online) return;
          const result = normalizeRestoreDestination(destination);
          if (!result.ok) {
            setValidation(result.message);
            return;
          }
          setValidation(null);
          onRestore({ fileId: file.id, computerId: target.computerId, destination: result.value });
        }}
      >
        {file.restoreTargets.length === 1 ? (
          <p className="text-sm text-foreground">
            To <span className="font-medium">{file.restoreTargets[0]?.name}</span>
            {file.restoreTargets[0]?.online ? "" : " (offline)"}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <Label>Restore to computer</Label>
            <Select
              value={target?.computerId ?? null}
              onValueChange={(next) => setChosenTargetId(next)}
            >
              <SelectTrigger aria-label="Restore to computer" disabled={submitting}>
                <SelectValue>
                  {target
                    ? `${target.name}${target.online ? "" : " (offline)"}`
                    : "Choose a computer"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {file.restoreTargets.map((candidate) => (
                  <SelectItem
                    key={candidate.computerId}
                    value={candidate.computerId}
                    disabled={!candidate.online}
                  >
                    {candidate.name}
                    {candidate.online ? "" : " (offline)"}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        )}
        <div className="flex flex-col gap-2">
          <Label htmlFor={destinationId}>Destination folder</Label>
          <Input
            id={destinationId}
            font="mono"
            value={destination}
            placeholder="/path/to/folder"
            autoComplete="off"
            spellCheck={false}
            disabled={submitting}
            aria-invalid={validation !== null}
            onChange={(event) => {
              setDestination(event.currentTarget.value);
              setValidation(null);
            }}
          />
          <p className="text-xs text-muted-foreground">
            The restored copy is written into this folder on the chosen computer.
          </p>
        </div>
        {validation ? (
          <p role="alert" className="text-xs text-destructive-foreground">
            {validation}
          </p>
        ) : null}
        <div>
          <Button
            type="submit"
            variant="outline"
            disabled={submitting || target === undefined || !target.online}
          >
            {submitting ? <Spinner /> : <ArchiveRestoreIcon />}
            Restore
          </Button>
        </div>
        <ActionMessage state={state} />
      </form>
    );
  }

  return (
    <ActionSection title="Restore" description="Copy the kept version into a folder you choose.">
      {body}
    </ActionSection>
  );
}

function FileFacts({ file }: { readonly file: FileDetail }) {
  const { nowMs, timestampFormat } = useComputersClock();
  const modified =
    file.modifiedAt === null ? null : formatDatedAge(file.modifiedAt, nowMs, timestampFormat);
  return (
    <dl className="divide-y divide-border/50 overflow-hidden rounded-xl border border-border/60">
      <Fact label="Computer">{file.computerName}</Fact>
      <Fact label="Path">
        <span className="font-mono text-xs">{file.path}</span>
      </Fact>
      {file.projectName ? <Fact label="Project">{file.projectName}</Fact> : null}
      {file.location ? <Fact label="Location">{FILE_LOCATION_LABELS[file.location]}</Fact> : null}
      {file.kind === "folder" || file.fileType ? (
        <Fact label="Type">{file.kind === "folder" ? "Folder" : file.fileType}</Fact>
      ) : null}
      <Fact label="Size">
        {file.sizeBytes === null ? <Unverified /> : formatBytes(file.sizeBytes)}
      </Fact>
      <Fact label="Modified">{modified === null ? <Unverified /> : modified}</Fact>
      <Fact label="Backup">
        <BackupFact backup={file.backup} />
      </Fact>
    </dl>
  );
}

/**
 * A file or folder in full, with the only two things a person can do to it: Keep it with a one-line
 * reason, or Restore its backed-up copy into a folder they choose. Whether each is possible, and why not,
 * comes from the data layer; what happened after they asked is shown as it was reported.
 */
export function FileDetailDialog({
  detail,
  actions,
}: {
  readonly detail: FileDetailState;
  readonly actions: Pick<ComputersActions, "onCloseDetail" | "onKeep" | "onRestore" | "onOpenFile">;
}) {
  const { file } = detail;
  return (
    <DetailDialog
      title={file.status === "ready" ? file.data.name : "File details"}
      description={file.status === "ready" ? file.data.computerName : null}
      onClose={actions.onCloseDetail}
    >
      {file.status === "loading" ? (
        <div role="status" aria-label="Loading file details" className="flex flex-col gap-3">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-8 w-full" />
          ))}
        </div>
      ) : file.status === "error" ? (
        <LoadError
          title="Could not load this file"
          message={file.message}
          onRetry={() => actions.onOpenFile(detail.fileId)}
        />
      ) : (
        <>
          <FileFacts file={file.data} />
          <KeepSection file={file.data} state={detail.keepState} onKeep={actions.onKeep} />
          <RestoreSection
            file={file.data}
            state={detail.restoreState}
            onRestore={actions.onRestore}
          />
        </>
      )}
    </DetailDialog>
  );
}

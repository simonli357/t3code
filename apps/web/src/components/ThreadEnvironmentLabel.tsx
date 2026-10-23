/** The owning environment stays visible without taking over the thread title. */
export function ThreadEnvironmentLabel({ label }: { readonly label: string | null }) {
  if (!label) return null;
  return (
    <span className="max-w-24 shrink-0 truncate rounded bg-muted/50 px-1 text-2xs leading-4 font-normal text-muted-foreground">
      {label}
    </span>
  );
}

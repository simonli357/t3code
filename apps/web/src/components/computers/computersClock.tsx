import type { TimestampFormat } from "@t3tools/contracts/settings";
import { createContext, use, useMemo, type ReactNode } from "react";

import { useNowMinute } from "~/hooks/useNowMinute";

interface ComputersClock {
  readonly nowMs: number;
  readonly timestampFormat: TimestampFormat;
}

const ComputersClockContext = createContext<ComputersClock | null>(null);

/**
 * The page's one clock. Ages ("Last seen 3h ago") are minute-granular, so every label shares the
 * app's minute timer instead of each running its own interval.
 */
export function ComputersClockProvider({
  timestampFormat,
  children,
}: {
  readonly timestampFormat: TimestampFormat;
  readonly children: ReactNode;
}) {
  const minute = useNowMinute();
  const value = useMemo(
    () => ({ nowMs: Date.parse(`${minute}:00Z`), timestampFormat }),
    [minute, timestampFormat],
  );
  return <ComputersClockContext value={value}>{children}</ComputersClockContext>;
}

export function useComputersClock(): ComputersClock {
  const clock = use(ComputersClockContext);
  if (clock === null) {
    throw new Error("useComputersClock must be used inside ComputersClockProvider.");
  }
  return clock;
}

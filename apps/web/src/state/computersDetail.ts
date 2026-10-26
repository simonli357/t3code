import type { ComputerInspection, ComputerInspectInput, EnvironmentId } from "@t3tools/contracts";

/** Polls one selected detail without replacing a slow request on every tick. Invalidate on close or selection change. */
export function createComputerDetailReader(
  read: (environmentId: EnvironmentId, input: ComputerInspectInput) => Promise<ComputerInspection>,
  receive: (result: ComputerInspection) => void,
  fail: (error: unknown) => void,
) {
  let generation = 0;
  let flight: { key: string; promise: Promise<void>; refresh: boolean } | null = null;

  const invalidate = () => {
    generation++;
    flight = null;
  };

  const request = (environmentId: EnvironmentId, input: ComputerInspectInput): Promise<void> => {
    const key = JSON.stringify([environmentId, input.section, input.path]);
    if (flight?.key === key) {
      if (input.refresh) flight.refresh = true;
      return flight.promise;
    }
    invalidate();
    const current = generation;
    const pending = { key, promise: Promise.resolve(), refresh: false };
    flight = pending;
    pending.promise = (async () => {
      let next = input;
      do {
        if (current !== generation) return;
        pending.refresh = false;
        try {
          const result = await read(environmentId, next);
          if (current !== generation) return;
          receive(result);
        } catch (error) {
          if (current !== generation) return;
          fail(error);
        }
        next = { ...input, refresh: true };
      } while (pending.refresh);
    })().finally(() => {
      if (flight === pending) flight = null;
    });
    return pending.promise;
  };
  return { request, invalidate };
}

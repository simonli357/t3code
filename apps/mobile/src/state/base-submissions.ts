import type { BaseSubmissionStorage } from "@t3tools/client-runtime/state/base-sessions";
import { writeFileAtomically } from "../lib/atomic-file";

export function baseSubmissionStorage(key: string): BaseSubmissionStorage {
  const file = async () => {
    const { Directory, File, Paths } = await import("expo-file-system");
    const directory = new Directory(Paths.document, "base-submissions");
    directory.create({ idempotent: true, intermediates: true });
    return new File(directory, `${encodeURIComponent(key)}.json`);
  };
  return {
    read: async () => {
      const entry = await file();
      return entry.exists ? entry.text() : null;
    },
    write: async (value) => writeFileAtomically(await file(), value),
    clear: async () => {
      const entry = await file();
      if (entry.exists) entry.delete();
    },
  };
}

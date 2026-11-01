import { expect, it } from "vite-plus/test";
import { openConversationFork } from "./conversation-fork.ts";

it("reuses the saved request after an uncertain submission and clears only after opening", async () => {
  let saved: string | null = null;
  let counter = 0;
  const submitted: unknown[] = [];
  const storage = { read: async () => saved, write: async (v: string) => { saved = v; }, clear: async () => { saved = null; } };
  const input = { storage, newId: () => String(++counter), submit: async (request: unknown) => { submitted.push(request); if (submitted.length === 1) throw new Error("disconnected"); }, open: async () => {} };
  await expect(openConversationFork(input)).rejects.toThrow("disconnected");
  expect(saved).not.toBeNull();
  await openConversationFork(input);
  expect(submitted[0]).toEqual(submitted[1]);
  expect(counter).toBe(2);
  expect(saved).toBeNull();
});
it("does not fork again after confirmed creation when navigation failed", async () => {
  let saved: string | null = null;
  let submits = 0;
  let opens = 0;
  const storage = { read: async () => saved, write: async (v: string) => { saved = v; }, clear: async () => { saved = null; } };
  const input = { storage, newId: () => "stable", submit: async () => { submits++; }, open: async () => { if (++opens === 1) throw new Error("route unavailable"); } };
  await expect(openConversationFork(input)).rejects.toThrow("route unavailable");
  await openConversationFork(input);
  expect(submits).toBe(1);
  expect(saved).toBeNull();
});
it("never submits when durable storage is unavailable or its saved request is invalid", async () => {
  let submits = 0;
  const input = { storage: { read: async () => null, write: async () => { throw new Error("storage unavailable"); }, clear: async () => {} }, newId: () => "id", submit: async () => { submits++; }, open: async () => {} };
  await expect(openConversationFork(input)).rejects.toThrow("storage unavailable");
  await expect(openConversationFork({ ...input, storage: { ...input.storage, read: async () => "invalid" } })).rejects.toThrow();
  expect(submits).toBe(0);
});

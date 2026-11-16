// A browser window stays open across a server release, so its loaded
// JavaScript can be older (or, after a rollback, newer) than the server that
// served it. That server then reports a different build after the reconnect,
// and one reload fetches the matching client. Only the serving server counts:
// a linked computer on another build says nothing about this page's assets.
// The desktop app bundles its own client and updates with the app.
const STALE_CLIENT_RELOAD_GUARD_KEY = "t3code:stale-client-reloaded-for";

export type StaleClientDecision = "current" | "reload" | "prompt";

export interface StaleClientInput {
  readonly clientVersion: string;
  /** Build reported by the server this page was loaded from, once connected. */
  readonly ownServerVersion: string | null;
  /** Dev serves source through Vite and the desktop app ships its own client. */
  readonly servedByOwnServer: boolean;
  /** Server build this window already reloaded for, so a reload that did not help is not repeated. */
  readonly reloadedForServerVersion: string | null;
  readonly unsavedInput: boolean;
}

export function resolveStaleClient(input: StaleClientInput): StaleClientDecision {
  if (
    !input.servedByOwnServer ||
    input.ownServerVersion === null ||
    input.ownServerVersion === input.clientVersion ||
    input.ownServerVersion === input.reloadedForServerVersion
  ) {
    return "current";
  }
  return input.unsavedInput ? "prompt" : "reload";
}

const TEXT_ENTRY_SELECTOR =
  "textarea, input:not([type=checkbox], [type=radio], [type=button], [type=submit], [type=range], [type=file])";

/**
 * What a reload would throw away. Composer drafts persist to localStorage and
 * come back, so they do not count. An open dialog and text typed into any
 * other focused field do.
 */
export function hasUnsavedInput(doc: Document = document): boolean {
  if (doc.querySelector('[role="dialog"], [role="alertdialog"]')) return true;
  const focused = doc.activeElement;
  if (!(focused instanceof HTMLElement) || focused.closest("[data-composer-rich-text]")) {
    return false;
  }
  if (focused.matches(TEXT_ENTRY_SELECTOR)) {
    return (focused as HTMLInputElement | HTMLTextAreaElement).value !== "";
  }
  return focused.isContentEditable && focused.textContent !== "";
}

export function readReloadedForServerVersion(
  getStorage: () => Storage = () => window.sessionStorage,
): string | null {
  try {
    return getStorage().getItem(STALE_CLIENT_RELOAD_GUARD_KEY);
  } catch {
    return null;
  }
}

/**
 * Reloads for `serverVersion` and returns whether it did. Without storage the
 * guard cannot survive the reload, so a build that never matches would loop;
 * stay on the loaded client instead.
 */
export function reloadForServerVersion(
  serverVersion: string,
  getStorage: () => Storage = () => window.sessionStorage,
  reload: () => void = () => window.location.reload(),
): boolean {
  try {
    getStorage().setItem(STALE_CLIENT_RELOAD_GUARD_KEY, serverVersion);
  } catch {
    return false;
  }
  reload();
  return true;
}

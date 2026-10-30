import { useCanGoBack, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

/** Returns to the previous app page, or home when opened without app history. */
function useNavigateBack() {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();

  return () => {
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  };
}

/** Enables page-level Escape navigation, letting controls consume Escape first. */
export function useEscapeToGoBack(onEscape?: () => void) {
  const navigateBack = useNavigateBack();
  const handleEscape = onEscape ?? navigateBack;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keeps the window Escape listener in step with the current route and handler while mounted.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.key !== "Escape") {
        return;
      }
      event.preventDefault();

      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement) {
        activeElement.blur();
      }

      handleEscape();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleEscape]);
}

import type { ReactNode } from "react";

import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";

/**
 * The shell shared by every detail view: a dialog on a desktop, a bottom sheet on a phone (the Dialog
 * does that itself). It is open for as long as it is rendered; closing asks the data layer to clear
 * the detail, which unmounts it.
 */
export function DetailDialog({
  title,
  description,
  onClose,
  children,
}: {
  readonly title: string;
  /** Plain text only: it renders inside a paragraph. */
  readonly description?: string | null;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <DialogPanel>{children}</DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

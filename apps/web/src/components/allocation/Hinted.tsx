import type { ReactElement, ReactNode } from "react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Marks a name whose explanation shows on hover. */
export const HINT_MARK = "cursor-help underline decoration-dotted underline-offset-2";

/**
 * A name or value with its explanation one hover away: the allocation pages carry names,
 * values and controls, and no explanatory sentences.
 */
export function Hinted(props: {
  hint: string;
  /** The element that is hovered, with its own classes; a marked span by default. */
  render?: ReactElement;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={props.render ?? <span className={HINT_MARK} />}>
        {props.children}
      </TooltipTrigger>
      <TooltipPopup>{props.hint}</TooltipPopup>
    </Tooltip>
  );
}

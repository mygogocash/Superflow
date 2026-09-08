import * as React from "react";

import { cn } from "@/lib/utils";

// Text size is keyed to the POINTER, not the viewport width.
//
// iOS Safari zooms the viewport whenever a focused text field computes under
// 16px, and never zooms back out. The rule here used to be a bare
// `md:text-sm`, which encodes "768px or wider is a desktop" — an assumption
// an iPad Mini (768px, touch) disproves. Phase 7E measured 14px on the iPad
// profile because of it. `md:pointer-fine:text-sm` keeps the smaller desktop
// size for anything driven by a mouse and leaves every touch device at 16px,
// at every width including iPad landscape. Compounded into one variant rather
// than layered as a separate `pointer-coarse:` utility, so there is no
// source-order race between two same-specificity media queries.
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  // Chrome DevTools "Issues" flags `<input>` without an `id` OR `name`
  // attribute as autofill-unfriendly. `autocomplete="off"` alone
  // doesn't silence it — the browser still wants one of id/name.
  // Generate a stable React id when neither is supplied so search /
  // filter inputs don't pollute the Issues panel.
  const generatedId = React.useId();
  const unnamed =
    !props.id &&
    !props.name &&
    !props["aria-label"] &&
    !props["aria-labelledby"];
  const placeholderLabel =
    unnamed && typeof props.placeholder === "string"
      ? props.placeholder.replace(/[….]+$/, "").trim()
      : undefined;
  const fallbackAutoComplete =
    unnamed && !props.autoComplete ? "off" : undefined;
  const fallbackId = !props.id && !props.name ? generatedId : undefined;
  return (
    <input
      type={type}
      data-slot="input"
      {...(fallbackId ? { id: fallbackId } : {})}
      {...(placeholderLabel ? { "aria-label": placeholderLabel } : {})}
      {...(fallbackAutoComplete ? { autoComplete: fallbackAutoComplete } : {})}
      className={cn(
        `
          border-input h-8 w-full min-w-0 rounded-lg border bg-transparent
          px-2.5 py-1 text-base transition-colors outline-none
          file:text-foreground file:inline-flex file:h-6 file:border-0
          file:bg-transparent file:text-sm file:font-medium
          placeholder:text-muted-foreground
          hover:border-ring/40
          focus-visible:border-ring focus-visible:ring-ring/30
          focus-visible:ring-3
          disabled:bg-muted/40 disabled:pointer-events-none
          disabled:cursor-not-allowed disabled:opacity-60
          aria-invalid:border-destructive aria-invalid:ring-destructive/20
          aria-invalid:ring-3
          dark:bg-input/30 dark:disabled:bg-input/80
          dark:aria-invalid:border-destructive/50
          dark:aria-invalid:ring-destructive/40
          md:pointer-fine:text-sm
        `,
        className,
      )}
      {...props}
    />
  );
}

export { Input };

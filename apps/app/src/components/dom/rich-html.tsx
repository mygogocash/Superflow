"use dom";

import { sanitizeRichHtml } from "@/lib/sanitize-rich-html";

/**
 * Web-only escape hatch for HTML the Reusables stack cannot render
 * (TipTap dumps, PDF previews, charts). Layouts cannot be DOM components.
 * HTML is sanitized here so callers cannot accidentally mount raw markup.
 */
export default function RichHtml({
  html,
  dom,
}: {
  html: string;
  dom?: import("expo/dom").DOMProps;
}) {
  void dom;
  return (
    <div dangerouslySetInnerHTML={{ __html: sanitizeRichHtml(html) }} />
  );
}

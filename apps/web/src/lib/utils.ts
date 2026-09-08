import { type ClassValue, clsx } from "clsx";
import sanitizeHtml from "sanitize-html";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Sanitize rich-text HTML (Quill editor output or imported documents)
// before it is rendered via dangerouslySetInnerHTML. Strips <script> /
// <iframe>, inline event handlers (onerror/onload/...), and
// javascript:-scheme URLs, while keeping the formatting tags + inline
// styles the editor produces (images via https or data: URIs survive).
// `sanitize-html` is pure JS so this runs identically on the server
// (SSR/prerender) and the client — no jsdom/DOM dependency.
//
// Quill 2.0.3 has an unpatched XSS in its HTML export
// (GHSA-v3m3-f69x-jf25, no upstream fix). Sanitizing at every render sink
// neutralizes it regardless of how the HTML was produced.
export function sanitizeRichHtml(html: string): string {
  if (!html) return "";
  return sanitizeHtml(html, {
    allowedTags: [
      "p",
      "br",
      "span",
      "div",
      "strong",
      "b",
      "em",
      "i",
      "u",
      "s",
      "sub",
      "sup",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "blockquote",
      "pre",
      "code",
      "ol",
      "ul",
      "li",
      "a",
      "img",
      "hr",
    ],
    allowedAttributes: {
      a: ["href", "target", "rel", "name"],
      img: ["src", "alt", "width", "height"],
      "*": ["style", "class"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    // Quill embeds pasted/uploaded images as data: URIs.
    allowedSchemesByTag: { img: ["http", "https", "data"] },
    allowProtocolRelative: false,
    // Without allowedStyles, sanitize-html keeps arbitrary CSS (expression()/
    // url(javascript:)). Restrict to formatting Quill actually emits.
    allowedStyles: {
      "*": {
        color: [/^#[0-9a-fA-F]{3,8}$/, /^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/, /^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*[\d.]+\s*\)$/],
        "background-color": [/^#[0-9a-fA-F]{3,8}$/, /^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/, /^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*[\d.]+\s*\)$/],
        "text-align": [/^(left|right|center|justify)$/],
        "font-size": [/^\d+(?:px|em|rem|%)$/],
        "font-weight": [/^(normal|bold|[1-9]00)$/],
        "text-decoration": [/^(none|underline|line-through)$/],
      },
    },
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer" }, true),
    },
  });
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

/**
 * Strip HTML tags from a TipTap / rich-text payload and decode common
 * entities into their plain-text equivalents. Replaces tags with a
 * space first so adjacent block elements don't get glued together
 * (e.g. `<p>foo</p><p>bar</p>` → "foo bar", not "foobar"), then
 * collapses whitespace. Used by kanban / list previews where only a
 * short text snippet is needed and the rich formatting would render
 * as raw `&nbsp;` etc. otherwise.
 */
export function stripHtmlToText(input: string | null | undefined): string {
  if (!input) return "";
  const noTags = input.replace(/<[^>]+>/g, " ");
  const decoded = noTags.replace(
    /&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (_, body: string) => {
      if (body.startsWith("#x") || body.startsWith("#X")) {
        const code = parseInt(body.slice(2), 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : "";
      }
      if (body.startsWith("#")) {
        const code = parseInt(body.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : "";
      }
      return NAMED_ENTITIES[body] ?? "";
    },
  );
  return decoded.replace(/\s+/g, " ").trim();
}

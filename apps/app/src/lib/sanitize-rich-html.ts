import sanitizeHtml from "sanitize-html";

/**
 * Sanitize rich HTML before DOM sinks (`RichHtml` / dangerouslySetInnerHTML).
 * Mirrors `apps/web` `sanitizeRichHtml` — Quill/TipTap XSS (GHSA-v3m3-f69x-jf25)
 * must not reach the Expo web surface either.
 */
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
    allowedSchemesByTag: { img: ["http", "https", "data"] },
    allowProtocolRelative: false,
    allowedStyles: {
      "*": {
        color: [
          /^#[0-9a-fA-F]{3,8}$/,
          /^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/,
          /^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*[\d.]+\s*\)$/,
        ],
        "background-color": [
          /^#[0-9a-fA-F]{3,8}$/,
          /^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/,
          /^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*[\d.]+\s*\)$/,
        ],
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

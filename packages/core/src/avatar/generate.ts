/**
 * Brand-aligned avatar generator for Manut profiles.
 *
 * Fail-closed: callers must gate on AVATAR_GENERATOR_ENABLED === "true".
 * Always produces a deterministic SVG → PNG-friendly SVG payload (no Node
 * canvas). Optional Gemini path can replace the SVG when GEMINI_API_KEY is set;
 * for v1 we ship the SVG initials path so Workers stay dependency-light.
 */

export type AvatarStyle =
  | "initials"
  | "geometric"
  | "soft";

export interface GenerateAvatarInput {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  style?: AvatarStyle;
  /** Seed for deterministic palette (defaults to email / name). */
  seed?: string | null;
}

export interface GeneratedAvatar {
  contentType: "image/svg+xml";
  bytes: Uint8Array;
  fileName: string;
  style: AvatarStyle;
}

/** Manut Brand CI v1.0 palette — Ink / Paper / Intelligence / Stone. */
const PALETTES = [
  { bg: "#5B5BD6", fg: "#F7F7F3" }, // Intelligence
  { bg: "#0B0B0A", fg: "#F7F7F3" }, // Ink
  { bg: "#3F3F46", fg: "#F7F7F3" }, // Stone-700
  { bg: "#18181B", fg: "#E4E4E7" }, // near-ink
  { bg: "#4F46E5", fg: "#F7F7F3" }, // Intelligence sibling
] as const;

function hashSeed(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return h;
}

function initialsOf(input: GenerateAvatarInput): string {
  const first = (input.firstName ?? "").trim();
  const last = (input.lastName ?? "").trim();
  if (first || last) {
    return `${first.charAt(0)}${last.charAt(0) || first.charAt(1) || ""}`.toUpperCase() || "?";
  }
  const email = (input.email ?? "").trim();
  if (email) return email.slice(0, 2).toUpperCase();
  return "M";
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildSvg(input: GenerateAvatarInput): string {
  const style: AvatarStyle = input.style ?? "initials";
  const seed =
    input.seed?.trim() ||
    [input.email, input.firstName, input.lastName].filter(Boolean).join("|") ||
    "manut";
  const h = hashSeed(seed);
  const palette = PALETTES[h % PALETTES.length]!;
  const initials = escapeXml(initialsOf(input));
  const rot = (h % 360);

  if (style === "geometric") {
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="${palette.bg}"/>
  <g transform="translate(256 256) rotate(${rot})">
    <rect x="-140" y="-140" width="280" height="280" rx="48" fill="${palette.fg}" opacity="0.18"/>
    <circle cx="0" cy="0" r="96" fill="${palette.fg}" opacity="0.22"/>
    <rect x="-48" y="-160" width="96" height="320" rx="24" fill="${palette.fg}" opacity="0.28"/>
  </g>
  <text x="256" y="286" text-anchor="middle" font-family="Inter, system-ui, sans-serif"
    font-size="160" font-weight="600" fill="${palette.fg}">${initials}</text>
</svg>`;
  }

  if (style === "soft") {
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <radialGradient id="g" cx="35%" cy="30%" r="75%">
      <stop offset="0%" stop-color="${palette.fg}" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="${palette.bg}"/>
    </radialGradient>
  </defs>
  <rect width="512" height="512" fill="url(#g)"/>
  <text x="256" y="286" text-anchor="middle" font-family="Inter, system-ui, sans-serif"
    font-size="168" font-weight="600" fill="${palette.fg}">${initials}</text>
</svg>`;
  }

  // initials (default)
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="${palette.bg}"/>
  <text x="256" y="290" text-anchor="middle" font-family="Inter, system-ui, sans-serif"
    font-size="180" font-weight="600" fill="${palette.fg}">${initials}</text>
</svg>`;
}

export function generateAvatarSvg(input: GenerateAvatarInput): GeneratedAvatar {
  const style: AvatarStyle = input.style ?? "initials";
  const svg = buildSvg(input);
  const bytes = new TextEncoder().encode(svg);
  const stamp = Date.now().toString(36);
  return {
    contentType: "image/svg+xml",
    bytes,
    fileName: `avatar-${style}-${stamp}.svg`,
    style,
  };
}

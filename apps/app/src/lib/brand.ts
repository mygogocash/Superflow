/**
 * Manut Brand CI v1.0 — concrete brand colors.
 *
 * For the non-CSS contexts where a Tailwind class cannot be used
 * (ActivityIndicator `color`, placeholder text props, OS chrome):
 * tokens themselves live in global.css / globals.css and this file must
 * stay in sync with them. Everything else should use the token classes.
 */
export const BRAND = {
  /** Manut Ink #0B0B0A — logo, headings, primary text, primary action */
  ink: "#0B0B0A",
  /** Manut Paper #F7F7F3 — main warm background */
  paper: "#F7F7F3",
  white: "#FFFFFF",
  /** Graphite #282826 — secondary dark UI / ink hover */
  graphite: "#282826",
  /** Intelligence 500 #5B5BD6 — AI actions and status only (CI §6) */
  intelligence: "#5B5BD6",
  /** Stone 700 #555550 — secondary text (AA-safe) */
  stone700: "#555550",
  /** Stone 500 #85857E — CI placeholder tone (§22); decorative/large only */
  stone500: "#85857E",
} as const;

/** User-facing product name for the in-app AI assistant (routes stay `/aria`). */
export const ASSISTANT_DISPLAY_NAME = "Manut AI";

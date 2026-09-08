# Manut — Design System (Brand CI v1.0)

The product is **Manut** — the AI-driven intelligence workspace of The Binary
Holdings. This document is the binding design contract for every surface
(`apps/app` Expo web is the official client; `apps/web` Next.js is legacy).

**Brand idea:** *Human intelligence, amplified.*
**Design principle:** **Human × Intelligence × Clarity**
**North-star rule:** when unsure about a UI decision, ask *"does this make
Manut feel more intelligent and easier to think with?"* — if it only makes the
interface look more "AI-ish", don't add it.

> **Editorial outside. Functional inside. Human throughout.**

---

## 1. Design tokens (single source of truth)

Tokens live as CSS variables and are the ONLY approved way to use brand color:

- Expo app: `apps/app/global.css` + `apps/app/tailwind.config.js`
- Web: `apps/web/src/app/globals.css` (light `:root` + `.dark`)

Slot names are shared across surfaces (`--background`, `--primary`,
`--intelligence-500`, …) so components compile against either. Never hardcode
a palette hex in component code; non-CSS contexts (ActivityIndicator,
placeholder props) import `BRAND` from `apps/app/src/lib/brand.ts`.

## 2. Color system

### Core identity

| Token | HEX | Usage |
|---|---|---|
| Manut Ink | `#0B0B0A` | Primary action, headings, primary text |
| Manut Paper | `#F7F7F3` | Main warm background |
| Pure White | `#FFFFFF` | Cards, inputs, elevated areas |
| Graphite | `#282826` | Secondary dark UI / ink hover |

### Stone neutrals

| Token | HEX | Usage |
|---|---|---|
| Stone 100 | `#F0EFEA` | Subtle surfaces, hover (`--secondary`, `--muted`, `--accent`) |
| Stone 200 | `#E3E2DC` | Primary border (`--border`) |
| Stone 300 | `#C9C8C1` | Strong border |
| Stone 500 | `#85857E` | Metadata, placeholders (CI §22) — **large/decorative only**, fails AA for body text |
| Stone 700 | `#555550` | Secondary/muted text — `--muted-foreground`, AA-safe (6.5–7.5:1) |

Target ratio: **80% neutrals / 15% surface variation / 5% accent.**

### Intelligence accent (the one accent hue)

| Token | HEX |
|---|---|
| Intelligence 50 | `#F1F1FF` |
| Intelligence 100 | `#E4E4FF` |
| Intelligence 200 | `#CACAFF` |
| Intelligence 300 | `#A6A6FA` |
| Intelligence 400 | `#7C7CEB` |
| Intelligence 500 | `#5B5BD6` |
| Intelligence 600 | `#4949BB` |
| Intelligence 700 | `#3B3B98` |
| Intelligence 800 | `#303079` |
| Intelligence 900 | `#272761` |

Use for: AI status, active AI surfaces, focus rings, links, selected objects,
and the `ai` button variant. **Do not turn the app purple.**

### Semantic colors

| Purpose | Fill | Text on fill |
|---|---|---|
| Success | `#237A57` | White (5.26:1) |
| Warning | `#A86710` | White (4.55:1) |
| Error | `#C53B36` | White (5.18:1) |
| Information | `#3973C6` | White (4.73:1) |

Never use semantic red merely to attract attention. In code the error slot is
`--destructive` (shadcn legacy name) — CI's "error" maps to it 1:1.

### Dark mode (CI §26)

| Token | HEX |
|---|---|
| Canvas | `#111110` |
| Surface | `#181817` |
| Surface Raised | `#20201E` |
| Border | `#30302D` |
| Primary Text | `#F5F4EF` |
| Secondary Text | `#A8A7A0` |
| Muted Text | `#777771` |
| Intelligence | `#7777E8` |

The reversed logo is warm white `#F7F7F3`, never blue. Dark values are lifted,
not inverted — a nested surface must read *above* the card behind it.

### Contrast

Every canonical text/background pair is verified WCAG 2.2 AA by
`scripts/brand-contrast.mjs` (repo root). Run it after touching a token —
it fails the shell on any regression. Known constraint: Stone 500 is
decorative/large-only (3.46–3.71:1); body-muted text is always Stone 700.

## 3. Typography

Two personalities (CI §8):

| Role | Face | Usage |
|---|---|---|
| Product UI | **Inter** (400/500/600) | navigation, buttons, tables, forms, AI responses, settings |
| Brand / editorial | **Instrument Serif** (400) | brand statements, auth headline, editorial quotes — never buttons or inputs |

Hierarchy (desktop): Display XL/L/M in Instrument Serif 72/56/44; H1–H4 in
Inter 600 (40/32/24/20); Body 16, Body S 14, Caption 12, Micro 11. Avoid
800–900 weights — confidence comes from spacing, not boldness.

Loading: `apps/app` imports both from Google Fonts in `global.css`;
`apps/web` uses `next/font` (`Inter`, `Instrument_Serif`) in
`src/app/layout.tsx`. `DM Mono` remains for tabular/code cells only.

## 4. Radius, borders, elevation

Radius scale (CI §11): XS 4 / S 6 / M 10 / L 14 / XL 20 / Full.
Buttons 8–10, inputs 8, cards 12–14, dialogs 16, large AI surfaces 16–20.

Borders over shadows (CI §12): primary border Stone 200, strong Stone 300,
dark `#30302D`. Elevation tokens (`--shadow-xs/sm/md/lg`, CI §13) are for
menus, dropdowns, dialogs, floating AI actions — normal cards are
**border + white surface**, no shadow.

### Liquid Glass chrome (Manut frosted)

Workspace chrome (sidebar, top bar, phone dock, tablet rail, floating
controls) may use **frosted translucency**: light fill + `backdrop-filter`
blur + hairline border. Content cards and form fields stay opaque.
Primary Ink / AI / destructive buttons stay solid for AA. Full rules:
[`docs/LIQUID_GLASS.md`](./LIQUID_GLASS.md). This is **not** 3D
glassmorphism (still forbidden by §8).

## 5. Spacing, layout, motion

- 4px base grid: `4 / 8 / 12 / 16 / 20 / 24 / 32 / 40 / 48 / 64 / 80 / 96 / 128`.
- Standard card padding 24, section gap 48–64. Whitespace is part of the brand.
- Workspace: sidebar 240–280, intelligence panel 320–400, max document width
  720–800. Desktop reference 1280–1440.
- Motion (CI §27): hover 120ms, button 150ms, dropdown 180ms, panel 220ms,
  dialog 240ms, AI state 300–600ms; easing `cubic-bezier(0.2, 0, 0, 1)`
  (`--ease-manut`). No bouncy transitions, glow, or floating gradients.

## 6. Components

- **Button** — `default`: Ink bg / white text, Graphite hover. `ai`: Intelligence
  500 bg, white text, Intelligence 600 hover — **reserved for AI actions**
  ("Ask Manut", "Analyze with Manut"); never a generic CTA. `outline`/`secondary`
  per CI §20. Destructive red only after destructive intent is clear.
- **Input** — 40px height, radius 8, border `#DAD9D3`, white bg, focus ring
  Intelligence (`rgba(91,91,214,.16)`), placeholder Stone 500 (the one approved
  Stone-500 text usage).
- **Card** — surface card (white + border, no shadow); interactive card adds
  hover `#FAFAF7`; intelligence card uses Intelligence 50; selected uses an
  Intelligence border.
- **IntelligenceBadge** — `✦ Manut Intelligence` motif (CI §24). The four-point
  sparkle marks AI-generated/interpreted content; it lives in
  `components/intelligence/` on both surfaces and never enters the primary logo.

## 7. Intelligence & voice

- Pattern: **Information → understanding → suggested intelligence → action**,
  not a chatbot sandwich.
- Loading copy is context-specific: "Reading 18 sources…", "Comparing
  assumptions…" — never "AI is thinking…".
- Voice: clear, short, precise, helpful ("Analysis complete. 3 inconsistencies
  were found."). No "awesome/magic/supercharge", no emoji in system messages.
- Empty states sound composed: "Your workspace is ready." — never "Oops!"

## 8. Do NOT (CI §38)

Generic purple-to-blue AI gradients · glowing chatbot orbs · robot
illustrations · 3D glassmorphism · neon outlines · excessive pill UI ·
emoji-heavy communication · random colorful icons · huge drop shadows ·
multiple competing accents · chat bubbles as the whole product.

## 9. Governance

- Token changes: edit the two token files, update this doc, re-run
  `node scripts/brand-contrast.mjs`, and include the new report in the PR.
- The brand-drift CI job greps `apps/web/src` + `apps/app/src`(+`apps/app/app`)
  for the retired palettes (legacy blue/teal set and cream/bronze/gold:
  `f7f3eb`, `8b6b3d`, `8b6914`, `c8a84b`, `0d0b07`, `3f3428`, `6b5e4e`).
- Logo assets: canonical SVGs live in `packages/brand/assets/` (contract in its
  README); bitmaps are generated by `scripts/build-brand-assets.mjs`.
- History: cream/bronze/gold "quiet luxury" palette and the "Intranet" product
  name were retired by the Brand CI v1.0 adoption — do not reintroduce either.

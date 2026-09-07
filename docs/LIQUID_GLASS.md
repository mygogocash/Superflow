# Manut Liquid Glass — chrome material plan

**Scope:** Expo official client (`apps/app`).  
**Constraint:** Brand CI §8 forbids *3D glassmorphism*, neon glow, and purple-gradient AI skins. This plan adapts Apple-style “liquid glass” into a **Manut frosted chrome** system: translucent fill + blur + hairline border, Ink/Paper/Intelligence only.

## Intent

Make shell chrome (sidebar, top bar, mobile dock, floating controls) feel layered and calm over Paper, without turning content cards into glass or sacrificing WCAG AA.

## Material rules

| Layer | Use | Fill | Blur | Border |
|---|---|---|---|---|
| **Chrome** | Sidebar, top bar, dock, icon rail | White ~72% / dark surface ~78% | 16px web | Stone 200 @ ~55% |
| **Control** | Outline/secondary/glass buttons, icon chips | White ~64% / raised ~70% | 12px web | Stone 200 |
| **Sheet** | Mobile nav drawer overlay panel | White ~88% | 20px web | Stone 200 |
| **Content** | Cards, tables, forms | **Opaque** card white | none | Stone 200 |

Do **not** glass: data tables, form fields (keep solid inputs), primary Ink / AI / destructive buttons (solid for contrast).

### Accessibility

- Text on glass chrome stays Ink / Stone 700 — never Stone 500 for body.
- `@media (prefers-reduced-motion: reduce)` and browsers without `backdrop-filter`: fall back to solid `--card` / `--sidebar-background`.
- Touch targets ≥ 44px on phone dock and tablet rail.
- Active dock/rail item uses Intelligence accent (icon + label), not a purple wash.

## Breakpoints (IA)

| Mode | Width | Chrome |
|---|---|---|
| **Phone** | `< 768` | Top glass brand bar + **bottom dock** (Home / ARIA / Messages / More) + full-nav sheet |
| **Tablet** | `768–1099` | **Icon rail** (glass) + More opens sheet; no permanent full sidebar |
| **Desktop** | `≥ 1100` | Full glass sidebar (labels) |

Constants: `TABLET_MIN=768`, `DESKTOP_MIN=1100` in `use-viewport-width.ts`.

## Rollout order

1. Tokens (`global.css` + `lib/glass.ts`) + `GlassSurface`
2. Button `glass` / translucent outline-secondary
3. Shell: desktop sidebar → tablet rail → phone dock
4. `PageScreen` bottom inset for dock
5. Later pages: adopt `GlassSurface` only for floating chrome (filters bars, sticky headers) — not every card

## Anti-patterns

- Glass on every card → muddy ERP
- Specular / multi-layer refraction / heavy drop shadows
- Pill-cluster docks with >5 primary destinations
- Intelligence as a full theme wash behind glass

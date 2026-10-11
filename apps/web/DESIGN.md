# Design Style Guide — MongoMation dashboard

## Aesthetic Direction

**Control room / SCADA HMI, dark.** The dashboard is watched like an operator screen while a worker engineers
and tests a PLC program on a real simulator, so it borrows the conventions of industrial HMIs (ISA-101,
IEC 60073 signal colors): a quiet dark plant surface, a faint blueprint grid, instrument-style panels, and
color used **only to signal state**. Data is the loud part; chrome stays recessive.

Rules:
- Every value comes from a query. Missing data is an explicit empty state ("No runs yet", "DISCONNECTED",
  "BLOCKED: <reason>") in dashed boxes, never a placeholder number.
- Status is never color alone: every pill carries an uppercase label, hidden tests carry a lock icon,
  FORCED signals carry hazard striping, deltas carry an explicit sign.

## Color Palette

Tokens live in `src/client/index.css` (`@theme`).

| Token | Values | Use |
|---|---|---|
| `plant-*` | `950 #06080a` … `100 #e4eaee`, `50 #f4f7f9` | page (950), panels (900/850), hairlines (700/600), ink (100–400) |
| `go-*` | `300 #8ef0b0` `400 #3ad671` `500 #16b455` `600 #0e8f43` | start / normal / verified / done (IEC green); primary action |
| `stop-*` | `300 #fca5a5` `400 #f26363` `500 #d93b3b` `600 #b42a2a` | fault / failed / stop commands |
| `caution-*` | `300 #fcd57a` `400 #fab219` `500 #e39a00` `600 #b87a00` | abnormal / BLOCKED / FORCED / stale; fault-injection button |
| `flow-*` | `300 #8fdcff` `400 #3cc3f5` `500 #0ea5e9` `600 #0b84bb` | running / in progress / links / focus rings |
| `meta-*` | `300 #cbbfff` `400 #a594f9` `500 #8b74f0` | the self-improving harness (RSI, repair-created versions) |
| `leaf-*` | `400 #00ed64` `500 #00c853` | MongoDB Atlas identity (brand dot, "Mation") |
| `series-sensor` / `series-actuator` | `#3987e5` / `#d95926` | timeline lines; categorical slots 1–2, validated on `plant-900` with the dataviz palette validator (dark) |

Status tones (`src/client/lib/tones.ts`): good = go, bad = stop, warn = caution, active = flow (pulsing dot),
meta = meta, info = plant-200 (queued / available), muted = plant-400 (pending / unsupported / no data).

## Typography

Google Fonts, loaded in `src/client/index.html`:
- **Chakra Petch** (`font-display`, 500–700): panel titles, section labels (uppercase, wide tracking), buttons.
- **IBM Plex Sans** (`font-sans`, 400–600): body copy, requirement text, spec input.
- **JetBrains Mono** (`font-mono`, 400–700): ids, tags, addresses, timestamps, logs, Structured Text,
  status pills. `tabular-nums` only where numbers align in columns.

## Spacing & Radius

- 4 px grid (Tailwind spacing). Panels: `p-4`, sections inside panels separated by `space-y-4/5`, lists by
  `space-y-1.5`.
- Radius: panels and inputs `rounded-lg`/`rounded-md` (8/6 px); pills and chips `rounded` (4 px) for an
  instrument-label look. No fully round pills.
- Panels use the `panel-surface` utility (92 % plant-900, 1 px plant-700 border, faint top highlight).
- Layout: header, spec console, project picker, then three columns at `xl` (simulation · execution ·
  results/RSI/long-horizon), two at `lg`, one below. `grid-cols-1` keeps wide code blocks from forcing
  horizontal page scroll on phones.

## Motion & Animation

Defined in `@theme` (`src/client/index.css`), all disabled under `prefers-reduced-motion`:
- `animate-rise` (0.5 s): panel entrance (fade + 8 px rise).
- `animate-pulse-dot` (1.4 s loop): live/running indicators (status dots, running stage nodes).
- `animate-sweep` (2.4 s loop): the loading bar.
- `animate-stripes`: reserved for moving hazard stripes.
Utilities: `bg-blueprint` (page grid + glows), `hazard` (amber 45° stripes), `panel-surface`.

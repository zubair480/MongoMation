export type Variant = "solid" | "outline" | "ghost" | "link" | "soft";
export type Color = "neutral" | "primary" | "destructive";

export const DEFAULT_VARIANT: Variant = "solid";
export const DEFAULT_COLOR: Color = "neutral";

/**
 * Base classes shared by Button and IconButton.
 * Ring width/offset live here; ring *color* lives per variant×color cell below
 * so tailwind-merge resolves to a single ring color.
 */
export const CONTROL_BASE =
  "inline-flex items-center justify-center whitespace-nowrap font-medium cursor-pointer " +
  "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-plant-950 " +
  "disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed " +
  "[&_svg]:pointer-events-none [&_svg]:shrink-0";

/**
 * variant (style treatment) × color (intent) → Tailwind classes, on the dark control-room palette
 * (DESIGN.md): neutral = instrument white, primary = go green, destructive = stop red.
 */
export const VARIANT_COLOR: Record<Variant, Record<Color, string>> = {
  solid: {
    neutral:
      "bg-plant-100 text-plant-950 shadow hover:bg-white active:bg-plant-200 focus-visible:ring-flow-400",
    primary:
      "bg-go-500 text-plant-950 shadow hover:bg-go-400 active:bg-go-600 focus-visible:ring-go-400",
    destructive:
      "bg-stop-500 text-white shadow-sm hover:bg-stop-400 active:bg-stop-600 focus-visible:ring-stop-400",
  },
  outline: {
    neutral:
      "border border-plant-600 bg-transparent text-plant-100 shadow-sm hover:bg-plant-800 active:bg-plant-750 focus-visible:ring-flow-400",
    primary:
      "border border-go-500/60 bg-transparent text-go-300 shadow-sm hover:bg-go-500/10 active:bg-go-500/20 focus-visible:ring-go-400",
    destructive:
      "border border-stop-500/60 bg-transparent text-stop-300 shadow-sm hover:bg-stop-500/10 active:bg-stop-500/20 focus-visible:ring-stop-400",
  },
  ghost: {
    neutral:
      "text-plant-100 hover:bg-plant-800 active:bg-plant-750 focus-visible:ring-flow-400",
    primary:
      "text-go-300 hover:bg-go-500/10 active:bg-go-500/20 focus-visible:ring-go-400",
    destructive:
      "text-stop-300 hover:bg-stop-500/10 active:bg-stop-500/20 focus-visible:ring-stop-400",
  },
  link: {
    neutral:
      "text-plant-100 underline-offset-4 hover:underline focus-visible:ring-flow-400",
    primary:
      "text-flow-300 underline-offset-4 hover:underline focus-visible:ring-flow-400",
    destructive:
      "text-stop-300 underline-offset-4 hover:underline focus-visible:ring-stop-400",
  },
  soft: {
    neutral:
      "bg-plant-800 text-plant-100 shadow-sm hover:bg-plant-750 active:bg-plant-700 focus-visible:ring-flow-400",
    primary:
      "bg-go-500/15 text-go-300 shadow-sm hover:bg-go-500/25 active:bg-go-500/30 focus-visible:ring-go-400",
    destructive:
      "bg-stop-500/15 text-stop-300 shadow-sm hover:bg-stop-500/25 active:bg-stop-500/30 focus-visible:ring-stop-400",
  },
};

export function variantColorClasses(variant: Variant, color: Color): string {
  return VARIANT_COLOR[variant][color];
}

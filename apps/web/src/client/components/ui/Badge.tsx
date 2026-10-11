import * as React from "react";

import { cn } from "@/client/lib/utils";
import type { Color } from "./_shared/variants";

export type BadgeVariant = "solid" | "soft" | "outline";

/** Static (non-interactive) variant×color classes for badges. */
const BADGE_CLASSES: Record<BadgeVariant, Record<Color, string>> = {
  solid: {
    neutral: "bg-plant-100 text-plant-950",
    primary: "bg-go-500 text-plant-950",
    destructive: "bg-stop-500 text-white",
  },
  soft: {
    neutral: "bg-plant-800 text-plant-100",
    primary: "bg-go-500/15 text-go-300",
    destructive: "bg-stop-500/15 text-stop-300",
  },
  outline: {
    neutral: "border border-plant-600 text-plant-100",
    primary: "border border-go-500/50 text-go-300",
    destructive: "border border-stop-500/50 text-stop-300",
  },
};

export interface BadgeProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, "color"> {
  /** @default "soft" */
  variant?: BadgeVariant;
  /** @default "neutral" */
  color?: Color;
}

const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant = "soft", color = "neutral", ...props }, ref) => (
    <span
      ref={ref}
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
        BADGE_CLASSES[variant][color],
        className
      )}
      {...props}
    />
  )
);
Badge.displayName = "Badge";

export { Badge };

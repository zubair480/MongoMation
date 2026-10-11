"use client";

import * as React from "react";
import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import { Check, Minus } from "lucide-react";
import { cn } from "@/client/lib/utils";

export interface CheckboxProps
  extends React.ComponentPropsWithoutRef<typeof BaseCheckbox.Root> {}

const Checkbox = React.forwardRef<
  React.ElementRef<typeof BaseCheckbox.Root>,
  CheckboxProps
>(({ className, indeterminate, ...props }, ref) => (
  <BaseCheckbox.Root
    ref={ref}
    indeterminate={indeterminate}
    className={cn(
      "flex h-4 w-4 shrink-0 items-center justify-center rounded border border-plant-600 bg-plant-900 text-plant-950 shadow-sm outline-none transition-colors",
      "focus-visible:ring-2 focus-visible:ring-flow-400 focus-visible:ring-offset-2 focus-visible:ring-offset-plant-950",
      "data-[checked]:border-go-500 data-[checked]:bg-go-500",
      "data-[indeterminate]:border-go-500 data-[indeterminate]:bg-go-500",
      "disabled:cursor-not-allowed disabled:opacity-50",
      className
    )}
    {...props}
  >
    <BaseCheckbox.Indicator className="flex items-center justify-center text-current data-[unchecked]:hidden">
      {indeterminate ? (
        <Minus className="size-3" aria-hidden="true" />
      ) : (
        <Check className="size-3" aria-hidden="true" />
      )}
    </BaseCheckbox.Indicator>
  </BaseCheckbox.Root>
));
Checkbox.displayName = "Checkbox";

export { Checkbox };

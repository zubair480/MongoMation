import * as React from "react";

import { cn } from "@/client/lib/utils";

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          "flex min-h-16 w-full rounded-md border border-plant-600 bg-plant-900 px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-plant-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-flow-400 focus-visible:ring-offset-2 focus-visible:ring-offset-plant-950 disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Textarea.displayName = "Textarea";

export { Textarea };

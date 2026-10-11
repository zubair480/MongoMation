"use client";

import * as React from "react";
import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import { cn } from "@/client/lib/utils";

const Tabs = BaseTabs.Root;

const TabsList = React.forwardRef<
  React.ElementRef<typeof BaseTabs.List>,
  React.ComponentPropsWithoutRef<typeof BaseTabs.List>
>(({ className, ...props }, ref) => (
  <BaseTabs.List
    ref={ref}
    className={cn(
      "inline-flex h-9 items-center justify-center rounded-lg bg-plant-800 p-1 text-plant-300",
      className
    )}
    {...props}
  />
));
TabsList.displayName = "TabsList";

const TabsTab = React.forwardRef<
  React.ElementRef<typeof BaseTabs.Tab>,
  React.ComponentPropsWithoutRef<typeof BaseTabs.Tab>
>(({ className, ...props }, ref) => (
  <BaseTabs.Tab
    ref={ref}
    className={cn(
      "inline-flex cursor-pointer items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium outline-none transition-all",
      "focus-visible:ring-2 focus-visible:ring-flow-400 focus-visible:ring-offset-2 focus-visible:ring-offset-plant-950",
      "data-[active]:bg-plant-900 data-[active]:text-plant-100 data-[active]:shadow",
      "disabled:pointer-events-none disabled:opacity-50",
      className
    )}
    {...props}
  />
));
TabsTab.displayName = "TabsTab";

const TabsPanel = React.forwardRef<
  React.ElementRef<typeof BaseTabs.Panel>,
  React.ComponentPropsWithoutRef<typeof BaseTabs.Panel>
>(({ className, ...props }, ref) => (
  <BaseTabs.Panel
    ref={ref}
    className={cn(
      "mt-2 outline-none focus-visible:ring-2 focus-visible:ring-flow-400 focus-visible:ring-offset-2 focus-visible:ring-offset-plant-950",
      className
    )}
    {...props}
  />
));
TabsPanel.displayName = "TabsPanel";

export { Tabs, TabsList, TabsTab, TabsPanel };

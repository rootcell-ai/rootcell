import * as React from "react";
import { cn } from "../../lib/utils.ts";

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, ...props },
  ref,
) {
  return (
    <select
      ref={ref}
      className={cn(
        "h-9 rounded-md border border-stone-300 bg-white px-2 text-sm text-stone-950 shadow-sm outline-none",
        "focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/20",
        className,
      )}
      {...props}
    />
  );
});

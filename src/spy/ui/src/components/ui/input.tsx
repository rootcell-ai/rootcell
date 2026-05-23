import * as React from "react";
import { cn } from "../../lib/utils.ts";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(
        "h-9 w-full rounded-md border border-stone-300 bg-white px-3 text-sm text-stone-950 shadow-sm outline-none",
        "placeholder:text-stone-400 focus:border-emerald-600 focus:ring-2 focus:ring-emerald-600/20",
        className,
      )}
      {...props}
    />
  );
});

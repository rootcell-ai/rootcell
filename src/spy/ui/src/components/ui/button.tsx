import * as React from "react";
import { cn } from "../../lib/utils.ts";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "icon";

const variantClass: Record<ButtonVariant, string> = {
  primary: "border-emerald-700 bg-emerald-700 text-white hover:bg-emerald-800",
  secondary: "border-stone-300 bg-white text-stone-900 hover:bg-stone-100",
  ghost: "border-transparent bg-transparent text-stone-700 hover:bg-stone-100",
  danger: "border-red-700 bg-red-700 text-white hover:bg-red-800",
};

const sizeClass: Record<ButtonSize, string> = {
  sm: "h-8 gap-1.5 px-2.5 text-xs",
  md: "h-9 gap-2 px-3 text-sm",
  icon: "h-8 w-8 p-0",
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant | undefined;
  readonly size?: ButtonSize | undefined;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "secondary", size = "md", type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md border font-medium transition-colors disabled:pointer-events-none disabled:opacity-45",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2",
        variantClass[variant],
        sizeClass[size],
        className,
      )}
      {...props}
    />
  );
});

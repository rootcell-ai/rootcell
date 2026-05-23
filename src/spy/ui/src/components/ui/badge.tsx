import { cn } from "../../lib/utils.ts";
import type { ReactElement, ReactNode } from "react";

type BadgeTone = "neutral" | "green" | "amber" | "red" | "blue" | "teal";

const toneClass: Record<BadgeTone, string> = {
  neutral: "border-stone-300 bg-stone-50 text-stone-700",
  green: "border-emerald-200 bg-emerald-50 text-emerald-800",
  amber: "border-amber-200 bg-amber-50 text-amber-800",
  red: "border-red-200 bg-red-50 text-red-800",
  blue: "border-sky-200 bg-sky-50 text-sky-800",
  teal: "border-teal-200 bg-teal-50 text-teal-800",
};

export function Badge(props: {
  readonly children: ReactNode;
  readonly tone?: BadgeTone | undefined;
  readonly className?: string | undefined;
}): ReactElement {
  const { children, tone = "neutral", className } = props;
  return (
    <span className={cn("inline-flex h-6 items-center rounded-md border px-2 text-xs font-medium", toneClass[tone], className)}>
      {children}
    </span>
  );
}

import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium tracking-tight transition-all duration-200 ease-out focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default:
          'bg-gradient-to-r from-slate-blue-600 to-indigo-600 text-white shadow-md shadow-slate-blue-500/20 hover:from-slate-blue-700 hover:to-indigo-700 hover:shadow-lg hover:shadow-slate-blue-500/30 hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-slate-blue-500/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:shadow-glow-blue',
        destructive:
          'bg-destructive text-destructive-foreground shadow-md shadow-destructive/15 hover:bg-destructive/90 hover:shadow-lg hover:shadow-destructive/25 hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-red-500/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:shadow-glow-red',
        outline:
          'border border-slate-200 dark:border-slate-700 bg-background/90 backdrop-blur-sm shadow-sm hover:bg-slate-blue-50 dark:hover:bg-slate-blue-950/30 hover:text-slate-blue-700 dark:hover:text-slate-blue-300 hover:border-slate-blue-300 dark:hover:border-slate-blue-700 hover:shadow-elevation-1 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-slate-blue-500/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        secondary:
          'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-sm hover:bg-slate-200 dark:hover:bg-slate-700 hover:shadow-elevation-1 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-slate-400/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        ghost:
          'hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-blue-700 dark:hover:text-slate-blue-300 active:scale-[0.95] focus-visible:ring-2 focus-visible:ring-slate-blue-500/30 focus-visible:ring-offset-0',
        link: 'text-slate-blue-600 dark:text-slate-blue-400 underline-offset-4 hover:underline hover:text-slate-blue-700 dark:hover:text-slate-blue-300 focus-visible:ring-2 focus-visible:ring-slate-blue-500/30 focus-visible:ring-offset-0',
        glass:
          'bg-white/80 dark:bg-slate-900/80 backdrop-blur-md border border-slate-200/60 dark:border-slate-700/60 shadow-glass noise-texture hover:bg-slate-blue-50/80 dark:hover:bg-slate-blue-950/40 hover:border-slate-blue-200 dark:hover:border-slate-blue-800 hover:shadow-elevation-2 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-slate-blue-500/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-11 rounded-lg px-8 text-base',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = 'Button';

export { Button, buttonVariants };

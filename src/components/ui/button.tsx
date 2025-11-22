import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium tracking-tight transition-all duration-200 ease-out focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 relative overflow-hidden',
  {
    variants: {
      variant: {
        default:
          'bg-gradient-to-r from-slate-blue-600 to-indigo-600 text-white shadow-lg shadow-slate-blue-500/20 hover:shadow-xl hover:shadow-slate-blue-500/30 hover:-translate-y-0.5 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-slate-blue-500/50 focus-visible:ring-offset-2 backdrop-blur-sm border border-white/10',
        destructive:
          'bg-gradient-to-r from-red-600 to-red-500 text-white shadow-lg shadow-red-500/20 hover:shadow-xl hover:shadow-red-500/30 hover:-translate-y-0.5 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-red-500/50 focus-visible:ring-offset-2 backdrop-blur-sm border border-white/10',
        outline:
          'border-2 border-slate-blue-200 dark:border-slate-blue-800 bg-white/30 dark:bg-slate-blue-950/30 backdrop-blur-md text-slate-blue-700 dark:text-slate-blue-300 shadow-md hover:bg-white/50 dark:hover:bg-slate-blue-900/50 hover:border-slate-blue-300 dark:hover:border-slate-blue-700 hover:shadow-lg hover:shadow-slate-blue-500/10 hover:-translate-y-0.5 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-slate-blue-500/50 focus-visible:ring-offset-2',
        secondary:
          'bg-gradient-to-r from-purple-500/80 to-indigo-500/80 backdrop-blur-md text-white border border-white/20 dark:border-white/10 shadow-md shadow-purple-500/10 hover:from-purple-500 hover:to-indigo-500 hover:shadow-lg hover:shadow-purple-500/20 hover:-translate-y-0.5 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-purple-500/50 focus-visible:ring-offset-2',
        ghost:
          'text-slate-blue-700 dark:text-slate-blue-300 hover:bg-white/40 dark:hover:bg-slate-blue-900/40 hover:backdrop-blur-md hover:shadow-md active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-slate-blue-500/30',
        link:
          'text-slate-blue-600 dark:text-slate-blue-400 underline-offset-4 hover:underline hover:text-slate-blue-700 dark:hover:text-slate-blue-300 active:scale-[0.98]',
        glass:
          'bg-white/30 dark:bg-slate-blue-950/30 backdrop-blur-xl border border-white/30 dark:border-white/10 shadow-glass text-slate-blue-900 dark:text-white hover:bg-white/40 dark:hover:bg-slate-blue-900/40 hover:border-white/40 dark:hover:border-white/20 hover:shadow-glass-lg hover:-translate-y-0.5 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-slate-blue-500/30 focus-visible:ring-offset-2',
        success:
          'bg-gradient-to-r from-green-600 to-emerald-600 text-white shadow-lg shadow-green-500/20 hover:shadow-xl hover:shadow-green-500/30 hover:-translate-y-0.5 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-green-500/50 focus-visible:ring-offset-2 backdrop-blur-sm border border-white/10',
        error:
          'bg-gradient-to-r from-red-600 to-rose-600 text-white shadow-lg shadow-red-500/20 hover:shadow-xl hover:shadow-red-500/30 hover:-translate-y-0.5 active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-red-500/50 focus-visible:ring-offset-2 backdrop-blur-sm border border-white/10',
      },
      size: {
        default: 'h-10 px-5 py-2 text-sm rounded-lg',
        sm: 'h-8 px-3 py-1.5 text-xs rounded-md',
        lg: 'h-12 px-8 py-3 text-base rounded-xl',
        icon: 'h-10 w-10 rounded-lg',
        'icon-sm': 'h-8 w-8 rounded-md',
        'icon-lg': 'h-12 w-12 rounded-xl',
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
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading, disabled, children, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        disabled={disabled || loading}
        {...props}
      >
        {loading ? (
          <>
            <svg
              className="animate-spin h-4 w-4"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
            <span>{typeof children === 'string' ? children : 'Loading...'}</span>
          </>
        ) : (
          children
        )}
      </Comp>
    );
  }
);
Button.displayName = 'Button';

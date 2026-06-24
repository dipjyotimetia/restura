'use client';

import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { cn } from '@/lib/shared/utils';

export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium tracking-tight transition-all duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-60 [&_svg]:pointer-events-none [&_svg]:shrink-0 relative overflow-hidden active:scale-[0.98]',
  {
    variants: {
      variant: {
        default:
          'bg-primary text-primary-foreground shadow-md hover:shadow-lg hover:bg-primary/90 hover:brightness-110 border border-transparent',
        destructive:
          'bg-destructive text-destructive-foreground shadow-md hover:shadow-lg hover:bg-destructive/90 hover:brightness-110 border border-transparent',
        outline:
          'border border-sp-line bg-sp-surface text-foreground hover:bg-sp-surface-hi hover:border-sp-line-strong',
        secondary:
          'border border-sp-line bg-sp-surface-hi text-secondary-foreground hover:bg-sp-surface-lo',
        ghost: 'hover:bg-sp-hover hover:text-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
        glow: 'bg-primary/10 text-primary border border-primary/30 hover:bg-primary/20',
        // Canonical primary action (Send / Invoke / Connect / Stream) — flat
        // solid accent, white label, the one saturated element. Pair size="cta".
        cta: 'sp-cta text-white tracking-wide hover:brightness-110 disabled:opacity-50',
      },
      size: {
        default: 'h-8 px-3 py-2 text-[13px] rounded-md [&_svg]:size-4',
        sm: 'h-7 rounded-md px-2.5 text-xs [&_svg]:size-3.5',
        lg: 'h-9 rounded-md px-4 text-sm [&_svg]:size-5',
        icon: 'h-8 w-8 rounded-md [&_svg]:size-4',
        'icon-sm': 'h-7 w-7 rounded-md [&_svg]:size-3.5',
        // Canonical primary-action size — h-8/32px, pill, used with variant="cta".
        // text-[13px] (not text-sp-13) so tailwind-merge keeps it as font-size and
        // does NOT drop the variant's text-white (custom text-sp-* classes collide
        // with text-white in tailwind-merge's "text" group).
        cta: 'h-8 px-4 gap-1.5 rounded-sp-pill text-[13px] font-semibold [&_svg]:size-3.5',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
  loadingText?: string;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      asChild = false,
      loading,
      loadingText,
      disabled,
      children,
      ...props
    },
    ref
  ) => {
    const Comp = asChild ? Slot : 'button';

    const getLoadingContent = () => {
      if (loadingText) return loadingText;
      if (typeof children === 'string') return children;
      return 'Loading...';
    };

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
              className="animate-spin"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              aria-hidden="true"
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
            <span>{getLoadingContent()}</span>
          </>
        ) : (
          children
        )}
      </Comp>
    );
  }
);
Button.displayName = 'Button';

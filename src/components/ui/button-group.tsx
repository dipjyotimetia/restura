'use client';

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/shared/utils';

const buttonGroupVariants = cva('inline-flex items-center rounded-md', {
  variants: {
    size: {
      default: 'h-9',
      sm: 'h-8',
      lg: 'h-10',
    },
  },
  defaultVariants: {
    size: 'default',
  },
});

export interface ButtonGroupProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof buttonGroupVariants> {}

export const ButtonGroup = React.forwardRef<HTMLDivElement, ButtonGroupProps>(
  ({ className, size, children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          buttonGroupVariants({ size }),
          '[&>button]:rounded-none [&>button]:border-r-0 [&>button:first-child]:rounded-l-md [&>button:last-child]:rounded-r-md [&>button:last-child]:border-r',
          className
        )}
        role="group"
        {...props}
      >
        {children}
      </div>
    );
  }
);

ButtonGroup.displayName = 'ButtonGroup';

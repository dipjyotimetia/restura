import * as React from 'react';
import { cn } from '@/lib/shared/utils';

export type FloaterRadius = 'chip' | 'btn' | 'pill' | 'panel' | 'window';
export type FloaterElevation = 'float' | 'float-lg' | 'inset' | 'none';

export interface FloaterProps extends React.HTMLAttributes<HTMLDivElement> {
  radius?: FloaterRadius;
  elevation?: FloaterElevation;
  asChild?: boolean;
}

const radiusMap: Record<FloaterRadius, string> = {
  chip: 'rounded-sp-chip',
  btn: 'rounded-sp-btn',
  pill: 'rounded-sp-pill',
  panel: 'rounded-sp-panel',
  window: 'rounded-sp-window',
};

const elevationMap: Record<FloaterElevation, string> = {
  float: 'sp-floater',
  'float-lg': 'sp-floater-lg',
  inset: 'sp-inset',
  none: '',
};

export const Floater = React.forwardRef<HTMLDivElement, FloaterProps>(
  ({ radius = 'panel', elevation = 'float', className, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(radiusMap[radius], elevationMap[elevation], className)}
        {...props}
      />
    );
  }
);
Floater.displayName = 'Floater';

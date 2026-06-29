'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X, type LucideIcon } from 'lucide-react';
import * as React from 'react';

import { cn } from '@/lib/shared/utils';

export const Dialog = DialogPrimitive.Root;

export const DialogTrigger = DialogPrimitive.Trigger;

export const DialogPortal = DialogPrimitive.Portal;

export const DialogClose = DialogPrimitive.Close;

export const DialogOverlay = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 z-50 bg-black/55 backdrop-blur-[6px] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

export const DialogContent = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, style, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    {/* Spatial Depth dialog surface — solid sp-surface-hi (NOT frosted glass):
        matches the Settings / Environments / Import hub surfaces so every dialog
        reads as one system. */}
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        'fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 rounded-sp-window border border-sp-line-strong bg-sp-surface-hi p-6 duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]',
        className
      )}
      style={{
        // Theme-aware via light-dark() (resolves off the class-driven
        // color-scheme): a heavy black drop + white inset hairline reads wrong
        // in light mode, so soften the shadow and darken the hairline there.
        boxShadow:
          '0 30px 80px light-dark(rgba(15,23,42,0.18), rgba(0,0,0,0.6)), 0 0 0 1px light-dark(rgba(15,23,42,0.06), rgba(255,255,255,0.04))',
        ...style,
      }}
      {...props}
    >
      {children}
      <DialogPrimitive.Close className="absolute right-4 top-4 inline-flex h-9 w-9 items-center justify-center rounded-sp-btn border border-sp-line bg-sp-surface-lo text-sp-muted transition-colors hover:border-sp-line-strong hover:bg-sp-hover hover:text-sp-text focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent disabled:pointer-events-none">
        <X className="h-3.5 w-3.5" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

/** Icon-badge tints. Default is the accent (blue); warning/danger preserve
 *  severity on caution / destructive dialogs so chrome consistency doesn't
 *  flatten meaning. */
const DIALOG_HEADER_TONES = {
  accent: {
    badge:
      'linear-gradient(135deg, var(--sp-accent-glow-33), transparent 70%), var(--sp-surface-lo)',
    icon: 'text-sp-accent',
  },
  warning: {
    badge:
      'linear-gradient(135deg, color-mix(in srgb, var(--color-warning) 22%, transparent), transparent 70%), var(--sp-surface-lo)',
    icon: 'text-amber-500 dark:text-amber-400',
  },
  danger: {
    // Rose (matching the rose-500 icon below), distinct from the status
    // --color-danger red — tinted from the same token the icon uses.
    badge:
      'linear-gradient(135deg, color-mix(in srgb, var(--color-rose-500) 20%, transparent), transparent 70%), var(--sp-surface-lo)',
    icon: 'text-rose-500 dark:text-rose-400',
  },
} as const;

interface DialogHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  /** When set, renders the Spatial Depth icon-badge header (accent gradient tile
   *  + title/description column) used by the Settings / Environments / Import
   *  hubs. Omit for a plain left-aligned title block. */
  icon?: LucideIcon;
  /** Badge tint. Default 'accent' (blue). Use 'warning'/'danger' on caution or
   *  destructive dialogs so the unified chrome keeps severity legible. */
  tone?: keyof typeof DIALOG_HEADER_TONES;
}

export const DialogHeader = ({
  className,
  icon: Icon,
  tone = 'accent',
  children,
  ...props
}: DialogHeaderProps) => {
  if (Icon) {
    const { badge, icon } = DIALOG_HEADER_TONES[tone];
    return (
      <div className={cn('flex items-start gap-3 text-left', className)} {...props}>
        <div
          aria-hidden="true"
          className="flex size-10 shrink-0 items-center justify-center rounded-sp-btn border border-sp-line"
          style={{ background: badge, boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06)' }}
        >
          <Icon size={18} className={icon} />
        </div>
        <div className="flex min-w-0 flex-col gap-0.5 leading-tight">{children}</div>
      </div>
    );
  }
  return (
    <div className={cn('flex flex-col space-y-1.5 text-left', className)} {...props}>
      {children}
    </div>
  );
};
DialogHeader.displayName = 'DialogHeader';

export const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn('flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2', className)}
    {...props}
  />
);
DialogFooter.displayName = 'DialogFooter';

export const DialogTitle = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-sp-16 font-bold leading-tight text-sp-text', className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

export const DialogDescription = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-sp-12-5 text-sp-muted', className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

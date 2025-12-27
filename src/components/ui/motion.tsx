'use client';

import * as React from 'react';
import {
  motion,
  type HTMLMotionProps,
  type Variants,
  type Transition,
  AnimatePresence,
} from 'framer-motion';

import { cn } from '@/lib/shared/utils';

// Animation variants for common patterns
export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
  exit: { opacity: 0 },
};

export const slideUp: Variants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -20 },
};

export const slideDown: Variants = {
  hidden: { opacity: 0, y: -20 },
  visible: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: 20 },
};

export const slideLeft: Variants = {
  hidden: { opacity: 0, x: 20 },
  visible: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -20 },
};

export const slideRight: Variants = {
  hidden: { opacity: 0, x: -20 },
  visible: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: 20 },
};

export const scale: Variants = {
  hidden: { opacity: 0, scale: 0.95 },
  visible: { opacity: 1, scale: 1 },
  exit: { opacity: 0, scale: 0.95 },
};

export const staggerContainer: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1,
    },
  },
};

export const staggerItem: Variants = {
  hidden: { opacity: 0, y: 10 },
  visible: { opacity: 1, y: 0 },
};

// Bounce animation for notifications and success states
export const bounce: Variants = {
  hidden: { opacity: 0, scale: 0.3, y: 20 },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: {
      type: 'spring',
      stiffness: 500,
      damping: 15,
    },
  },
  exit: { opacity: 0, scale: 0.3, y: -20 },
};

// Shake animation for validation errors
export const shake: Variants = {
  initial: { x: 0 },
  shake: {
    x: [0, -10, 10, -10, 10, 0],
    transition: { duration: 0.4, ease: 'easeInOut' },
  },
};

// Pulse animation for drawing attention
export const pulse: Variants = {
  initial: { scale: 1 },
  pulse: {
    scale: [1, 1.05, 1],
    transition: { duration: 0.3, ease: 'easeInOut' },
  },
};

// Success checkmark animation (for SVG path)
export const successPath: Variants = {
  hidden: { pathLength: 0, opacity: 0 },
  visible: {
    pathLength: 1,
    opacity: 1,
    transition: { duration: 0.3, ease: 'easeOut' },
  },
};

// Pop animation for quick emphasis
export const pop: Variants = {
  hidden: { opacity: 0, scale: 0.8 },
  visible: {
    opacity: 1,
    scale: 1,
    transition: {
      type: 'spring',
      stiffness: 600,
      damping: 20,
    },
  },
  exit: { opacity: 0, scale: 0.8 },
};

// Glow animation for highlights
export const glow: Variants = {
  initial: { boxShadow: '0 0 0 rgba(59, 130, 246, 0)' },
  glow: {
    boxShadow: [
      '0 0 0 rgba(59, 130, 246, 0)',
      '0 0 20px rgba(59, 130, 246, 0.5)',
      '0 0 0 rgba(59, 130, 246, 0)',
    ],
    transition: { duration: 1, ease: 'easeInOut' },
  },
};

// Reusable transition presets
export const springTransition: Transition = {
  type: 'spring',
  stiffness: 400,
  damping: 30,
};

export const smoothTransition: Transition = {
  duration: 0.3,
  ease: [0.4, 0, 0.2, 1] as const,
};

export const fastTransition: Transition = {
  duration: 0.15,
  ease: 'easeOut' as const,
};

// Motion components
interface MotionDivProps extends HTMLMotionProps<'div'> {
  children?: React.ReactNode;
}

export const MotionDiv = React.forwardRef<HTMLDivElement, MotionDivProps>(
  ({ className, ...props }, ref) => (
    <motion.div ref={ref} className={cn(className)} {...props} />
  )
);
MotionDiv.displayName = 'MotionDiv';

// Fade component
interface FadeProps extends MotionDivProps {
  show?: boolean;
}

export const Fade = React.forwardRef<HTMLDivElement, FadeProps>(
  ({ show = true, children, ...props }, ref) => (
    <AnimatePresence>
      {show && (
        <MotionDiv
          ref={ref}
          initial="hidden"
          animate="visible"
          exit="exit"
          variants={fadeIn}
          transition={smoothTransition}
          {...props}
        >
          {children}
        </MotionDiv>
      )}
    </AnimatePresence>
  )
);
Fade.displayName = 'Fade';

// Slide component
interface SlideProps extends MotionDivProps {
  show?: boolean;
  direction?: 'up' | 'down' | 'left' | 'right';
}

export const Slide = React.forwardRef<HTMLDivElement, SlideProps>(
  ({ show = true, direction = 'up', children, ...props }, ref) => {
    const variants = {
      up: slideUp,
      down: slideDown,
      left: slideLeft,
      right: slideRight,
    }[direction];

    return (
      <AnimatePresence>
        {show && (
          <MotionDiv
            ref={ref}
            initial="hidden"
            animate="visible"
            exit="exit"
            variants={variants}
            transition={smoothTransition}
            {...props}
          >
            {children}
          </MotionDiv>
        )}
      </AnimatePresence>
    );
  }
);
Slide.displayName = 'Slide';

// Scale component
interface ScaleProps extends MotionDivProps {
  show?: boolean;
}

export const Scale = React.forwardRef<HTMLDivElement, ScaleProps>(
  ({ show = true, children, ...props }, ref) => (
    <AnimatePresence>
      {show && (
        <MotionDiv
          ref={ref}
          initial="hidden"
          animate="visible"
          exit="exit"
          variants={scale}
          transition={springTransition}
          {...props}
        >
          {children}
        </MotionDiv>
      )}
    </AnimatePresence>
  )
);
Scale.displayName = 'Scale';

// Stagger container for list animations
interface StaggerProps extends MotionDivProps {
  show?: boolean;
}

export const Stagger = React.forwardRef<HTMLDivElement, StaggerProps>(
  ({ show = true, children, ...props }, ref) => (
    <AnimatePresence>
      {show && (
        <MotionDiv
          ref={ref}
          initial="hidden"
          animate="visible"
          exit="hidden"
          variants={staggerContainer}
          {...props}
        >
          {children}
        </MotionDiv>
      )}
    </AnimatePresence>
  )
);
Stagger.displayName = 'Stagger';

// Stagger item for use inside Stagger
export const StaggerItem = React.forwardRef<HTMLDivElement, MotionDivProps>(
  ({ children, ...props }, ref) => (
    <MotionDiv ref={ref} variants={staggerItem} transition={smoothTransition} {...props}>
      {children}
    </MotionDiv>
  )
);
StaggerItem.displayName = 'StaggerItem';

// Hover scale effect
interface HoverScaleProps extends MotionDivProps {
  scale?: number;
}

export const HoverScale = React.forwardRef<HTMLDivElement, HoverScaleProps>(
  ({ scale: hoverScale = 1.02, children, ...props }, ref) => (
    <MotionDiv
      ref={ref}
      whileHover={{ scale: hoverScale }}
      whileTap={{ scale: 0.98 }}
      transition={fastTransition}
      {...props}
    >
      {children}
    </MotionDiv>
  )
);
HoverScale.displayName = 'HoverScale';

// Tap feedback
export const TapFeedback = React.forwardRef<HTMLDivElement, MotionDivProps>(
  ({ children, ...props }, ref) => (
    <MotionDiv ref={ref} whileTap={{ scale: 0.97 }} transition={fastTransition} {...props}>
      {children}
    </MotionDiv>
  )
);
TapFeedback.displayName = 'TapFeedback';

// Page transition wrapper
export const PageTransition = React.forwardRef<HTMLDivElement, MotionDivProps>(
  ({ children, ...props }, ref) => (
    <MotionDiv
      ref={ref}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
      {...props}
    >
      {children}
    </MotionDiv>
  )
);
PageTransition.displayName = 'PageTransition';

// Bounce component for notifications/alerts
interface BounceProps extends MotionDivProps {
  show?: boolean;
}

export const Bounce = React.forwardRef<HTMLDivElement, BounceProps>(
  ({ show = true, children, ...props }, ref) => (
    <AnimatePresence>
      {show && (
        <MotionDiv
          ref={ref}
          initial="hidden"
          animate="visible"
          exit="exit"
          variants={bounce}
          {...props}
        >
          {children}
        </MotionDiv>
      )}
    </AnimatePresence>
  )
);
Bounce.displayName = 'Bounce';

// Shake component for error feedback
interface ShakeProps extends MotionDivProps {
  trigger?: boolean;
  onAnimationComplete?: () => void;
}

export const Shake = React.forwardRef<HTMLDivElement, ShakeProps>(
  ({ trigger = false, onAnimationComplete, children, ...props }, ref) => (
    <MotionDiv
      ref={ref}
      variants={shake}
      initial="initial"
      animate={trigger ? 'shake' : 'initial'}
      onAnimationComplete={onAnimationComplete}
      {...props}
    >
      {children}
    </MotionDiv>
  )
);
Shake.displayName = 'Shake';

// Pulse component for attention
interface PulseProps extends MotionDivProps {
  trigger?: boolean;
}

export const Pulse = React.forwardRef<HTMLDivElement, PulseProps>(
  ({ trigger = false, children, ...props }, ref) => (
    <MotionDiv
      ref={ref}
      variants={pulse}
      initial="initial"
      animate={trigger ? 'pulse' : 'initial'}
      {...props}
    >
      {children}
    </MotionDiv>
  )
);
Pulse.displayName = 'Pulse';

// Pop component for quick emphasis
interface PopProps extends MotionDivProps {
  show?: boolean;
}

export const Pop = React.forwardRef<HTMLDivElement, PopProps>(
  ({ show = true, children, ...props }, ref) => (
    <AnimatePresence>
      {show && (
        <MotionDiv
          ref={ref}
          initial="hidden"
          animate="visible"
          exit="exit"
          variants={pop}
          {...props}
        >
          {children}
        </MotionDiv>
      )}
    </AnimatePresence>
  )
);
Pop.displayName = 'Pop';

// Skeleton pulse animation for loading states
export const SkeletonPulse = React.forwardRef<HTMLDivElement, MotionDivProps>(
  ({ className, ...props }, ref) => (
    <MotionDiv
      ref={ref}
      className={cn('animate-pulse rounded-md bg-muted', className)}
      {...props}
    />
  )
);
SkeletonPulse.displayName = 'SkeletonPulse';

// Loading spinner with rotation
interface SpinnerProps extends MotionDivProps {
  size?: 'sm' | 'md' | 'lg';
}

export const Spinner = React.forwardRef<HTMLDivElement, SpinnerProps>(
  ({ size = 'md', className, ...props }, ref) => {
    const sizeClasses = {
      sm: 'h-4 w-4 border-2',
      md: 'h-6 w-6 border-2',
      lg: 'h-8 w-8 border-3',
    };

    return (
      <MotionDiv
        ref={ref}
        className={cn(
          'rounded-full border-primary/30 border-t-primary',
          sizeClasses[size],
          className
        )}
        animate={{ rotate: 360 }}
        transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
        {...props}
      />
    );
  }
);
Spinner.displayName = 'Spinner';

// Fade in up on scroll (intersection observer based)
interface FadeInViewProps extends MotionDivProps {
  once?: boolean;
  delay?: number;
}

export const FadeInView = React.forwardRef<HTMLDivElement, FadeInViewProps>(
  ({ once = true, delay = 0, children, ...props }, ref) => (
    <MotionDiv
      ref={ref}
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once }}
      transition={{ duration: 0.5, delay, ease: [0.4, 0, 0.2, 1] }}
      {...props}
    >
      {children}
    </MotionDiv>
  )
);
FadeInView.displayName = 'FadeInView';

// Re-export AnimatePresence for convenience
export { AnimatePresence, motion };

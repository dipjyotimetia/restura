'use client';

import * as React from 'react';
import {
  motion,
  type HTMLMotionProps,
  type Variants,
  type Transition,
  AnimatePresence,
} from 'framer-motion';

import { cn } from '@/lib/utils';

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

// Re-export AnimatePresence for convenience
export { AnimatePresence, motion };

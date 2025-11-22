# Restura UI Enhancement Plan

## Current Assessment

### Strengths
- Well-structured shadcn/ui component patterns
- HSL-based design token system with CSS custom properties
- Framer Motion integration already in place
- Dark/light mode support with surface elevation system
- Good accessibility with ARIA labels and keyboard shortcuts

### Areas for Improvement
- Inconsistent elevation/shadows across components
- Underutilized Framer Motion animations
- Tabs and active states lack visual distinction
- Missing micro-interactions on key actions
- Dense UI needs more breathing room

---

## Phase 1 - High Impact Changes

### 1. Send Button Enhancement
Add gradient, glow effect, and success state animation.

```tsx
className={cn(
  "bg-gradient-to-r from-primary to-primary/80",
  "shadow-lg shadow-primary/25",
  "hover:shadow-xl hover:shadow-primary/35",
  "hover:from-primary/90 hover:to-primary/70",
  "active:scale-[0.98]",
  "transition-all duration-200",
  isSuccess && "animate-success-pulse bg-green-600"
)}
```

### 2. Animated Tab Indicator
Sliding underline with Framer Motion `layoutId`.

```tsx
<TabsList className="relative">
  <motion.div
    className="absolute bottom-0 h-0.5 bg-primary rounded-full"
    layoutId="tab-indicator"
    transition={{ type: "spring", stiffness: 500, damping: 30 }}
  />
  <TabsTrigger>Params</TabsTrigger>
  <TabsTrigger>Headers</TabsTrigger>
</TabsList>
```

### 3. Response Panel Animations
Entrance animation with status-specific border glow.

```tsx
<motion.div
  initial={{ opacity: 0, y: 20, scale: 0.98 }}
  animate={{ opacity: 1, y: 0, scale: 1 }}
  transition={{ type: "spring", stiffness: 300, damping: 25 }}
  className={cn(
    "border-l-4",
    status >= 200 && status < 300 && "border-l-green-500 shadow-glow-green",
    status >= 400 && "border-l-red-500 shadow-glow-red"
  )}
>
```

### 4. Method Selector Polish
Vibrant colors with smooth transitions.

```tsx
<SelectTrigger
  className={cn(
    "font-mono font-bold text-sm",
    "border-2 rounded-lg",
    "transition-all duration-300",
    methodColors[method]
  )}
>
```

---

## Phase 2 - Visual Polish

### 5. Sidebar Hover Effects
Scale, translate, and gradient overlay on hover.

```tsx
<motion.div
  whileHover={{ scale: 1.02, x: 4 }}
  whileTap={{ scale: 0.98 }}
  className={cn(
    "group relative overflow-hidden",
    "before:absolute before:inset-0 before:bg-gradient-to-r before:from-primary/5 before:to-transparent before:opacity-0",
    "hover:before:opacity-100 before:transition-opacity"
  )}
>
```

### 6. Empty State Improvements
Animated illustrations with decorative elements.

```tsx
<motion.div
  initial={{ opacity: 0, scale: 0.9 }}
  animate={{ opacity: 1, scale: 1 }}
  transition={{ delay: 0.2 }}
  className="text-center p-12"
>
  <div className="relative inline-block">
    <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-primary/10 to-primary/5 flex items-center justify-center">
      <Zap className="w-8 h-8 text-primary animate-pulse" />
    </div>
    <div className="absolute inset-0 rounded-2xl border border-primary/20 animate-ping opacity-75" />
  </div>
  <h3 className="mt-4 font-semibold text-lg">Ready to Send</h3>
  <p className="text-muted-foreground mt-1">Configure your request to begin</p>
</motion.div>
```

### 7. Header Gradient Accent
Subtle gradient border for brand presence.

```tsx
<header className="relative border-b bg-background/80 backdrop-blur-sm">
  <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-primary/50 to-transparent" />

  <motion.div
    whileHover={{ rotate: 5, scale: 1.05 }}
    className="h-8 w-8 rounded-lg bg-primary"
  >
    <span className="font-bold text-primary-foreground">R</span>
  </motion.div>
</header>
```

### 8. URL Input Focus States
Glow effect and subtle scale on focus.

```tsx
className={cn(
  "transition-all duration-200",
  "focus:ring-2 focus:ring-primary/20 focus:border-primary",
  "focus:shadow-glow-blue focus:scale-[1.01]",
  "placeholder:text-muted-foreground/50"
)}
```

---

## Phase 3 - Refinements

### 9. Toast Notification Styling
Custom styling with progress indicators.

```tsx
toast.loading('Sending request...', {
  style: {
    background: 'hsl(var(--card))',
    borderColor: 'hsl(var(--border))',
    borderWidth: '1px',
    boxShadow: '0 10px 40px -10px rgba(0,0,0,0.2)',
  },
});
```

### 10. Keyboard Shortcut Badges
Tactile kbd styling with shadows.

```tsx
<kbd className={cn(
  "px-2 py-1 rounded-md text-[10px] font-mono font-medium",
  "bg-muted/50 border border-border/50",
  "shadow-[0_2px_0_0_hsl(var(--border))]",
  "hover:translate-y-0.5 hover:shadow-none transition-all"
)}>
  ⌘K
</kbd>
```

### 11. Scroll Area Enhancements
- Add fade gradients at scroll boundaries
- Smooth momentum scrolling

### 12. Dropdown Menu Animations
- Stagger animation for menu items
- Subtle scale on hover

---

## Design Patterns

### Consistent Elevation System
```css
.elevation-1: /* Sidebar items, cards */
.elevation-2: /* Dropdowns, popovers */
.elevation-3: /* Dialogs, modals */
.elevation-4: /* Command palette */
```

### Interactive State Pattern
```tsx
className={cn(
  "transition-all duration-200",
  "hover:scale-[1.02] hover:-translate-y-0.5",
  "active:scale-[0.98]",
  "focus-visible:ring-2 focus-visible:ring-ring"
)}
```

### Color Intensity Scale
For status indicators (success/error/warning):
- Backgrounds: 10% opacity
- Borders: 20-30% opacity
- Text: Full color
- Hover: Increase background to 20%

### Motion Guidelines
- **Micro-interactions**: `duration-150`, `ease-out`
- **UI feedback**: `duration-200`, `ease-in-out`
- **Page transitions**: `duration-300`, spring physics
- **Stagger children**: 50-100ms delay

---

## Files to Modify

### Phase 1
- `src/components/RequestBuilder.tsx` - Send button, method selector
- `src/components/ResponseViewer.tsx` - Response animations
- `src/components/ui/tabs.tsx` - Animated indicator

### Phase 2
- `src/components/Sidebar.tsx` - Hover effects
- `src/components/Header.tsx` - Gradient accent
- `src/components/ui/input.tsx` - Focus states
- Various empty states throughout

### Phase 3
- `src/components/ui/sonner.tsx` or toast config
- `src/components/ui/kbd.tsx` - Keyboard shortcuts
- `src/components/ui/scroll-area.tsx` - Scroll enhancements
- `src/components/ui/dropdown-menu.tsx` - Animations

---

## CSS Utilities to Add

```css
/* Shadow glow utilities */
.shadow-glow-green {
  box-shadow: 0 0 20px -5px rgba(34, 197, 94, 0.3);
}

.shadow-glow-red {
  box-shadow: 0 0 20px -5px rgba(239, 68, 68, 0.3);
}

.shadow-glow-blue {
  box-shadow: 0 0 20px -5px rgba(59, 130, 246, 0.3);
}
```

---

## Implementation Notes

1. Test all changes in both light and dark modes
2. Verify animations respect `prefers-reduced-motion`
3. Maintain accessibility standards (focus states, ARIA)
4. Test performance - avoid layout thrashing with transforms
5. Keep bundle size in check - Framer Motion tree-shakes well

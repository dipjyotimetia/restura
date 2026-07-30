# Web Native Download Banner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Help web users discover and download Restura's native macOS, Windows, and Linux applications.

**Architecture:** Add a small renderer-only component at the Home shell boundary, immediately below the application chrome. It detects Electron through the existing platform helper and returns nothing there; on the web it exposes canonical release links for each desktop operating system.

**Tech Stack:** React, TypeScript, Tailwind CSS, Lucide icons, Vitest, React Testing Library.

## Global Constraints

- Render only when `isElectron()` is false.
- Link only to `https://github.com/dipjyotimetia/restura/releases/latest`.
- Preserve the existing Electron window chrome and app layout.
- Provide native semantic links and accessible labels for all actions.

---

### Task 1: Add and integrate the web-native download banner

**Files:**
- Create: `src/components/shared/WebNativeDownloadBanner.tsx`
- Create: `src/components/shared/__tests__/WebNativeDownloadBanner.test.tsx`
- Modify: `src/routes/index.tsx`

**Interfaces:**
- Consumes: `isElectron(): boolean` from `@/lib/shared/platform`.
- Produces: `WebNativeDownloadBanner(): ReactElement | null`.

- [ ] **Step 1: Write the failing test**

```tsx
it('shows native app links on the web and hides them in Electron', () => {
  vi.mocked(isElectron).mockReturnValue(false);
  const { rerender } = render(<WebNativeDownloadBanner />);
  expect(screen.getByRole('complementary', { name: /native app download/i })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /download for macos/i })).toHaveAttribute('href', RELEASE_URL);

  vi.mocked(isElectron).mockReturnValue(true);
  rerender(<WebNativeDownloadBanner />);
  expect(screen.queryByRole('complementary', { name: /native app download/i })).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:run -- src/components/shared/__tests__/WebNativeDownloadBanner.test.tsx`
Expected: FAIL because the new component module does not exist.

- [ ] **Step 3: Write minimal implementation**

```tsx
export function WebNativeDownloadBanner(): ReactElement | null {
  if (isElectron()) return null;
  return <aside aria-label="Native app download">...</aside>;
}
```

Render the banner directly after `TopBar` in `Home` so it sits at the top of the web workspace but is excluded from the AI Lab route.

- [ ] **Step 4: Run focused test and static checks**

Run: `npm run test:run -- src/components/shared/__tests__/WebNativeDownloadBanner.test.tsx && npm run type-check && npm run lint -- src/components/shared/WebNativeDownloadBanner.tsx src/routes/index.tsx`
Expected: PASS with no diagnostics.

- [ ] **Step 5: Review scope and commit**

Inspect `git diff --check` and `git diff -- src/components/shared/WebNativeDownloadBanner.tsx src/components/shared/__tests__/WebNativeDownloadBanner.test.tsx src/routes/index.tsx`. Commit only the feature files when the user authorizes a commit.

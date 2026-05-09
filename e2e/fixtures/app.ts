import { test as base, expect, type Page } from '@playwright/test';

type AppFixtures = {
  app: Page;
};

const ONBOARDING_KEY = 'restura-onboarding-completed';

async function seedSkipOnboarding(page: Page) {
  await page.addInitScript((key: string) => {
    try {
      window.localStorage.setItem(key, 'true');
    } catch {
      // localStorage may not be available before navigation; ignore.
    }
  }, ONBOARDING_KEY);
}

export const test = base.extend<AppFixtures>({
  app: async ({ page }, use) => {
    await seedSkipOnboarding(page);
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByRole('button', { name: 'Switch to HTTP mode' })).toBeVisible();
    await use(page);
  },
});

export { expect };

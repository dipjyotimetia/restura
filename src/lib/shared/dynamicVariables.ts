import { v4 as uuidv4 } from 'uuid';
// Use the locale-scoped entry point — `@faker-js/faker` (no locale) pulls every
// locale into the renderer bundle (~3 MB). The `/locale/en` entry tree-shakes
// to ~1 MB and is sufficient for Postman dynamic-var parity (all $random*
// helpers we surface are locale-agnostic strings).
import { faker } from '@faker-js/faker/locale/en';
import { generateTraceparent } from '@/lib/shared/utils';

const FIRST_NAMES = ['alice', 'bob', 'carol', 'dave', 'eve', 'frank', 'grace', 'henry'];
const DOMAINS = ['example.com', 'test.io', 'sample.net', 'demo.dev'];

type Generator = () => string;

const HELPERS: Record<string, Generator> = {
  // --- Built-ins (kept for back-compat with prior tests/callers) ---
  timestamp: () => String(Date.now()),
  isoTimestamp: () => new Date().toISOString(),
  randomInt: () => String(Math.floor(Math.random() * 1000)),
  guid: () => uuidv4(),
  randomUUID: () => uuidv4(),
  randomAlphaNumeric: () => Math.random().toString(36).slice(2, 10),
  traceparent: () => generateTraceparent(),
  // randomEmail keeps the legacy hand-rolled shape so existing tests still pass.
  // For richer Postman parity use $randomFullName + $randomEmailFaker, etc.
  randomEmail: () => {
    const name = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)] ?? 'user';
    const domain = DOMAINS[Math.floor(Math.random() * DOMAINS.length)] ?? 'example.com';
    const suffix = Math.floor(Math.random() * 1000);
    return `${name}.${suffix}@${domain}`;
  },

  // --- Person ---
  randomFirstName: () => faker.person.firstName(),
  randomLastName: () => faker.person.lastName(),
  randomFullName: () => faker.person.fullName(),
  randomJobTitle: () => faker.person.jobTitle(),

  // --- Internet / Network ---
  randomPhoneNumber: () => faker.phone.number(),
  randomUserAgent: () => faker.internet.userAgent(),
  randomURL: () => faker.internet.url(),
  randomDomainName: () => faker.internet.domainName(),
  randomIP: () => faker.internet.ipv4(),
  randomIPV6: () => faker.internet.ipv6(),
  randomMacAddress: () => faker.internet.mac(),

  // --- Location ---
  randomCity: () => faker.location.city(),
  randomCountry: () => faker.location.country(),
  randomLatitude: () => String(faker.location.latitude()),
  randomLongitude: () => String(faker.location.longitude()),

  // --- Company / Commerce ---
  randomCompanyName: () => faker.company.name(),
  randomCurrencyCode: () => faker.finance.currencyCode(),
  randomCurrencySymbol: () => faker.finance.currencySymbol(),
  // creditCardNumber masks all but last 4 (e.g. "**** **** **** 1234").
  randomCreditCardMask: () => {
    const num = faker.finance.creditCardNumber({ issuer: 'visa' }).replace(/\D/g, '');
    const last4 = num.slice(-4).padStart(4, '0');
    return `**** **** **** ${last4}`;
  },
  randomBankAccount: () => faker.finance.accountNumber(),

  // --- Lorem ---
  randomLoremWord: () => faker.lorem.word(),
  randomLoremSentence: () => faker.lorem.sentence(),
  randomLoremParagraph: () => faker.lorem.paragraph(),

  // --- Color ---
  randomColor: () => faker.color.human(),
  randomHexColor: () => faker.color.rgb(),

  // --- Files ---
  randomFileExt: () => faker.system.fileExt(),
  randomFileName: () => faker.system.fileName(),

  // --- Dates ---
  randomDateRecent: () => faker.date.recent().toISOString(),
  randomDateFuture: () => faker.date.future().toISOString(),
};

const PATTERN = /\{\{\s*\$([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

/**
 * Counter for {{$randomXxx}} or {{$xxx}} references encountered during the
 * most recent applyDynamicVariables call(s) where we don't have a generator
 * registered. Callers that care (importers, the substitution telemetry) can
 * read and reset via getAndResetUnknownDynamicVarCount(). Mirrors the
 * unrecognizedBodyCount pattern in opencollection/to-internal.ts so warnings
 * surface uniformly.
 */
const unknownDynamicVarCounts = new Map<string, number>();

export function applyDynamicVariables(text: string): string {
  return text.replace(PATTERN, (match, name: string) => {
    const generator = HELPERS[name];
    if (generator) return generator();
    // Track the unrecognized name and leave the literal in place so the user
    // can see what didn't expand.
    unknownDynamicVarCounts.set(name, (unknownDynamicVarCounts.get(name) ?? 0) + 1);
    return match;
  });
}

/**
 * Returns the per-name counts of unknown dynamic variables seen since the
 * last reset, then clears the counter. Importers convert each entry into a
 * single `unknown-dynamic-var` warning per unique name.
 */
export function getAndResetUnknownDynamicVarCounts(): Array<{ name: string; count: number }> {
  const out = Array.from(unknownDynamicVarCounts.entries()).map(([name, count]) => ({
    name,
    count,
  }));
  unknownDynamicVarCounts.clear();
  return out;
}

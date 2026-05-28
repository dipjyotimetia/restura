import { v4 as uuidv4 } from 'uuid';
import { faker } from '@faker-js/faker/locale/en';
import { generateTraceparent } from '@/lib/shared/utils';

type Generator = () => string;

export const HELPERS: Record<string, Generator> = {
  timestamp: () => String(Math.floor(Date.now() / 1000)),
  isoTimestamp: () => new Date().toISOString(),
  guid: () => uuidv4(),
  randomUUID: () => faker.string.uuid(),
  randomAlphaNumeric: () => faker.string.alphanumeric(1),
  randomBoolean: () => String(faker.datatype.boolean()),
  randomInt: () => String(faker.number.int({ min: 0, max: 1000 })),
  randomColor: () => faker.color.human(),
  randomHexColor: () => faker.color.rgb(),
  randomAbbreviation: () => faker.hacker.abbreviation(),
  randomIP: () => faker.internet.ipv4(),
  randomIPV6: () => faker.internet.ipv6(),
  randomMACAddress: () => faker.internet.mac(),
  randomPassword: () => faker.internet.password({ length: 15 }),
  randomLocale: () => faker.location.countryCode('alpha-2').toLowerCase(),
  randomUserAgent: () => faker.internet.userAgent(),
  randomProtocol: () => faker.internet.protocol(),
  randomSemver: () => faker.system.semver(),
  randomFirstName: () => faker.person.firstName(),
  randomLastName: () => faker.person.lastName(),
  randomFullName: () => faker.person.fullName(),
  randomNamePrefix: () => faker.person.prefix(),
  randomNameSuffix: () => faker.person.suffix(),
  randomJobArea: () => faker.person.jobArea(),
  randomJobDescriptor: () => faker.person.jobDescriptor(),
  randomJobTitle: () => faker.person.jobTitle(),
  randomJobType: () => faker.person.jobType(),
  randomPhoneNumber: () => faker.phone.number(),
  randomPhoneNumberExt: () => faker.phone.number({ style: 'national' }),
  randomCity: () => faker.location.city(),
  randomStreetName: () => faker.location.street(),
  randomStreetAddress: () => faker.location.streetAddress(),
  randomCountry: () => faker.location.country(),
  randomCountryCode: () => faker.location.countryCode('alpha-2'),
  randomLatitude: () => String(faker.location.latitude()),
  randomLongitude: () => String(faker.location.longitude()),
  randomAvatarImage: () => faker.image.avatar(),
  randomImageUrl: () => faker.image.url(),
  randomAbstractImage: () => faker.image.url(),
  randomAnimalsImage: () => faker.image.url(),
  randomBusinessImage: () => faker.image.url(),
  randomCatsImage: () => faker.image.url(),
  randomCityImage: () => faker.image.url(),
  randomFoodImage: () => faker.image.url(),
  randomNightlifeImage: () => faker.image.url(),
  randomFashionImage: () => faker.image.url(),
  randomPeopleImage: () => faker.image.url(),
  randomNatureImage: () => faker.image.url(),
  randomSportsImage: () => faker.image.url(),
  randomTransportImage: () => faker.image.url(),
  randomImageDataUri: () => faker.image.dataUri(),
  randomBankAccount: () => faker.finance.accountNumber(8),
  randomBankAccountName: () => faker.finance.accountName(),
  randomCreditCardMask: () => faker.finance.creditCardNumber().slice(-4),
  randomBankAccountBic: () => faker.finance.bic(),
  randomBankAccountIban: () => faker.finance.iban(),
  randomTransactionType: () => faker.finance.transactionType(),
  randomCurrencyCode: () => faker.finance.currencyCode(),
  randomCurrencyName: () => faker.finance.currency().name,
  randomCurrencySymbol: () => faker.finance.currencySymbol(),
  randomBitcoin: () => faker.finance.bitcoinAddress(),
  randomCompanyName: () => faker.company.name(),
  randomCompanySuffix: () => faker.company.catchPhraseDescriptor(),
  randomBs: () => faker.company.buzzPhrase(),
  randomBsAdjective: () => faker.company.buzzAdjective(),
  randomBsBuzz: () => faker.company.buzzVerb(),
  randomBsNoun: () => faker.company.buzzNoun(),
  randomCatchPhrase: () => faker.company.catchPhrase(),
  randomCatchPhraseAdjective: () => faker.company.catchPhraseAdjective(),
  randomCatchPhraseDescriptor: () => faker.company.catchPhraseDescriptor(),
  randomCatchPhraseNoun: () => faker.company.catchPhraseNoun(),
  randomDatabaseColumn: () => faker.database.column(),
  randomDatabaseType: () => faker.database.type(),
  randomDatabaseCollation: () => faker.database.collation(),
  randomDatabaseEngine: () => faker.database.engine(),
  randomDatePast: () => faker.date.past().toISOString(),
  randomDateFuture: () => faker.date.future().toISOString(),
  randomDateRecent: () => faker.date.recent().toISOString(),
  randomMonth: () => faker.date.month(),
  randomWeekday: () => faker.date.weekday(),
  randomDomainName: () => faker.internet.domainName(),
  randomDomainSuffix: () => faker.internet.domainSuffix(),
  randomDomainWord: () => faker.internet.domainWord(),
  randomEmail: () => faker.internet.email(),
  randomExampleEmail: () => faker.internet.exampleEmail(),
  randomUserName: () => faker.internet.username(),
  randomUrl: () => faker.internet.url(),
  randomFileName: () => faker.system.fileName(),
  randomCommonFileName: () => faker.system.commonFileName(),
  randomCommonFileType: () => faker.system.commonFileType(),
  randomCommonFileExt: () => faker.system.commonFileExt(),
  randomFileType: () => faker.system.fileType(),
  randomFileExt: () => faker.system.fileExt(),
  randomMimeType: () => faker.system.mimeType(),
  randomDirectoryPath: () => faker.system.directoryPath(),
  randomFilePath: () => faker.system.filePath(),
  randomLoremWord: () => faker.lorem.word(),
  randomLoremWords: () => faker.lorem.words(),
  randomLoremSentence: () => faker.lorem.sentence(),
  randomLoremSentences: () => faker.lorem.sentences(),
  randomLoremParagraph: () => faker.lorem.paragraph(),
  randomLoremParagraphs: () => faker.lorem.paragraphs(),
  randomLoremText: () => faker.lorem.text(),
  randomLoremSlug: () => faker.lorem.slug(),
  randomLoremLines: () => faker.lorem.lines(),
  traceparent: () => generateTraceparent(),
};

export const POSTMAN_VARIABLES = Object.keys(HELPERS).map((name) => ({
  name: `$${name}`,
  description: `Generates a random ${name.replace('random', '')}`,
}));

const PATTERN = /\{\{\s*\$([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

const unknownDynamicVarCounts = new Map<string, number>();

export function applyDynamicVariables(text: string): string {
  return text.replace(PATTERN, (match, name: string) => {
    const generator = HELPERS[name];
    if (generator) return generator();
    unknownDynamicVarCounts.set(name, (unknownDynamicVarCounts.get(name) ?? 0) + 1);
    return match;
  });
}

export function getAndResetUnknownDynamicVarCounts(): Array<{ name: string; count: number }> {
  const out = Array.from(unknownDynamicVarCounts.entries()).map(([name, count]) => ({
    name,
    count,
  }));
  unknownDynamicVarCounts.clear();
  return out;
}

import { describe, expect, it } from 'vitest';
import {
  CATEGORIES, GROUP_LABELS, GROUP_ORDER, LIABILITY_GROUPS, accountGroup, categoryLabel, isCategoryKey,
  kindOf, mapCategory, normalizeMerchant,
} from './categories';

describe('mapCategory (spec §4)', () => {
  it.each([
    ['FOOD_AND_DRINK', 'FOOD_AND_DRINK_GROCERIES', 'groceries'],
    ['FOOD_AND_DRINK', 'FOOD_AND_DRINK_RESTAURANT', 'dining'],
    ['FOOD_AND_DRINK', 'FOOD_AND_DRINK_COFFEE', 'dining'],
    ['FOOD_AND_DRINK', null, 'dining'],
    ['TRANSPORTATION', 'TRANSPORTATION_GAS', 'transport'],
    ['GENERAL_MERCHANDISE', 'GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES', 'shopping'],
    ['RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_GAS_AND_ELECTRICITY', 'bills'],
    ['HOME_IMPROVEMENT', 'HOME_IMPROVEMENT_FURNITURE', 'home'],
    ['MEDICAL', 'MEDICAL_PHARMACIES_AND_SUPPLEMENTS', 'health'],
    ['PERSONAL_CARE', 'PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS', 'personal'],
    ['ENTERTAINMENT', 'ENTERTAINMENT_MUSIC_AND_AUDIO', 'entertainment'],
    ['TRAVEL', 'TRAVEL_FLIGHTS', 'travel'],
    ['GENERAL_SERVICES', 'GENERAL_SERVICES_INSURANCE', 'services'],
    ['GOVERNMENT_AND_NON_PROFIT', 'GOVERNMENT_AND_NON_PROFIT_DONATIONS', 'giving'],
    ['BANK_FEES', 'BANK_FEES_OVERDRAFT_FEES', 'fees'],
    ['INCOME', 'INCOME_WAGES', 'income'],
    ['TRANSFER_IN', 'TRANSFER_IN_DEPOSIT', 'transfer'],
    ['TRANSFER_OUT', 'TRANSFER_OUT_ACCOUNT_TRANSFER', 'transfer'],
  ])('%s / %s -> %s', (primary, detailed, expected) => {
    expect(mapCategory(primary, detailed)).toBe(expected);
  });

  it('maps FOOD_AND_DRINK_GROCERIES to groceries, but other FOOD_AND_DRINK to dining', () => {
    expect(mapCategory('FOOD_AND_DRINK', 'FOOD_AND_DRINK_GROCERIES')).toBe('groceries');
    expect(mapCategory('FOOD_AND_DRINK', 'FOOD_AND_DRINK_RESTAURANT')).toBe('dining');
  });

  it('maps LOAN_PAYMENTS_CREDIT_CARD_PAYMENT to transfer', () => {
    expect(mapCategory('LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT')).toBe('transfer');
  });

  it('maps other LOAN_PAYMENTS detail values to loans', () => {
    expect(mapCategory('LOAN_PAYMENTS', 'LOAN_PAYMENTS_MORTGAGE_PAYMENT')).toBe('loans');
    expect(mapCategory('LOAN_PAYMENTS', 'LOAN_PAYMENTS_CAR_PAYMENT')).toBe('loans');
    expect(mapCategory('LOAN_PAYMENTS', null)).toBe('loans');
  });

  it('maps unknown or missing primaries to other', () => {
    expect(mapCategory('SOMETHING_NEW', 'SOMETHING_NEW_DETAIL')).toBe('other');
    expect(mapCategory(null, null)).toBe('other');
    expect(mapCategory(undefined, undefined)).toBe('other');
    expect(mapCategory('')).toBe('other');
  });

  it('is case-insensitive on the primary and detailed values', () => {
    expect(mapCategory('food_and_drink', 'food_and_drink_groceries')).toBe('groceries');
    expect(mapCategory('loan_payments', 'loan_payments_credit_card_payment')).toBe('transfer');
  });

  it('only ever returns a known category key', () => {
    for (const p of ['FOOD_AND_DRINK', 'TRANSPORTATION', 'INCOME', 'TRANSFER_IN', 'NOPE']) {
      expect(isCategoryKey(mapCategory(p, null))).toBe(true);
    }
  });
});

describe('kindOf', () => {
  it('classifies spend, income and transfer categories', () => {
    expect(kindOf('groceries')).toBe('spend');
    expect(kindOf('loans')).toBe('spend');
    expect(kindOf('other')).toBe('spend');
    expect(kindOf('income')).toBe('income');
    expect(kindOf('transfer')).toBe('transfer');
  });

  it('defaults unknown keys to spend', () => {
    expect(kindOf('not-a-category')).toBe('spend');
  });

  it('agrees with the declared kind of every category', () => {
    for (const c of CATEGORIES) expect(kindOf(c.key)).toBe(c.kind);
  });

  it('marks transfer and income mappings as non-spend', () => {
    expect(kindOf(mapCategory('TRANSFER_OUT'))).toBe('transfer');
    expect(kindOf(mapCategory('INCOME'))).toBe('income');
    expect(kindOf(mapCategory('LOAN_PAYMENTS', 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'))).toBe('transfer');
  });
});

describe('category labels', () => {
  it('uses the spec labels', () => {
    expect(categoryLabel('groceries')).toBe('Groceries');
    expect(categoryLabel('dining')).toBe('Dining out');
    expect(categoryLabel('giving')).toBe('Gifts & giving');
    expect(categoryLabel('loans')).toBe('Loan payments');
    expect(categoryLabel('fees')).toBe('Fees');
  });

  it('falls back to Other for unknown keys', () => {
    expect(categoryLabel('bogus')).toBe('Other');
  });
});

describe('accountGroup (spec §4)', () => {
  it('maps depository to cash', () => {
    expect(accountGroup('depository', 'checking')).toBe('cash');
    expect(accountGroup('depository', 'savings')).toBe('cash');
    expect(accountGroup('depository', null)).toBe('cash');
  });

  it('maps credit to credit and loan to loans', () => {
    expect(accountGroup('credit', 'credit card')).toBe('credit');
    expect(accountGroup('loan', 'mortgage')).toBe('loans');
  });

  it.each([
    '401k', '401a', '403b', '457b', 'ira', 'roth', 'roth 401k', 'sep ira',
    'simple ira', 'pension', 'retirement', 'keogh', 'thrift savings plan',
  ])('maps investment subtype "%s" to retirement', (subtype) => {
    expect(accountGroup('investment', subtype)).toBe('retirement');
  });

  it('matches retirement subtypes case-insensitively', () => {
    expect(accountGroup('investment', '403B')).toBe('retirement');
    expect(accountGroup('investment', 'Roth 401K')).toBe('retirement');
    expect(accountGroup('investment', 'Thrift Savings Plan')).toBe('retirement');
  });

  it('maps other investment subtypes (and no subtype) to investments', () => {
    expect(accountGroup('investment', 'brokerage')).toBe('investments');
    expect(accountGroup('investment', '529')).toBe('investments');
    expect(accountGroup('investment', 'hsa')).toBe('investments');
    expect(accountGroup('investment', null)).toBe('investments');
    expect(accountGroup('investment', undefined)).toBe('investments');
  });

  it('maps anything else to other', () => {
    expect(accountGroup('other', null)).toBe('other');
    expect(accountGroup('brokerage-unknown', null)).toBe('other');
    expect(accountGroup(null, null)).toBe('other');
    expect(accountGroup(undefined, undefined)).toBe('other');
  });

  it('matches the account type case-insensitively', () => {
    expect(accountGroup('Depository', 'checking')).toBe('cash');
    expect(accountGroup('CREDIT', null)).toBe('credit');
  });

  it('treats credit and loans as liabilities and nothing else', () => {
    expect([...LIABILITY_GROUPS].sort()).toEqual(['credit', 'loans']);
    expect(GROUP_ORDER).toEqual(['cash', 'investments', 'retirement', 'credit', 'loans', 'other']);
    expect(Object.keys(GROUP_LABELS).sort()).toEqual([...GROUP_ORDER].sort());
  });
});

describe('normalizeMerchant', () => {
  it('lowercases and collapses punctuation and whitespace into hyphens', () => {
    expect(normalizeMerchant("Trader Joe's")).toBe('trader-joe-s');
    expect(normalizeMerchant('  STARBUCKS #1234  ')).toBe('starbucks-1234');
    expect(normalizeMerchant('Amazon.com*AB12')).toBe('amazon-com-ab12');
  });

  it('returns an empty string for missing or symbol-only names', () => {
    expect(normalizeMerchant(null)).toBe('');
    expect(normalizeMerchant(undefined)).toBe('');
    expect(normalizeMerchant('')).toBe('');
    expect(normalizeMerchant('!!! ###')).toBe('');
  });

  it('caps the id at 100 characters without a trailing hyphen from the cut', () => {
    const long = 'a'.repeat(99) + ' b';
    const id = normalizeMerchant(long);
    expect(id.length).toBeLessThanOrEqual(100);
    expect(id.startsWith('a'.repeat(99))).toBe(true);
    expect(normalizeMerchant('x'.repeat(250))).toHaveLength(100);
  });

  it('is idempotent', () => {
    const once = normalizeMerchant("McDonald's #42");
    expect(normalizeMerchant(once)).toBe(once);
  });
});

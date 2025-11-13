export const COUNTRIES = [
  'Australia', 'Austria', 'Belgium', 'Canada', 'Czechia', 'Denmark', 'Finland',
  'France', 'Germany', 'HongKong', 'Ireland', 'Israel', 'Italy', 'Japan',
  'Liechtenstein', 'Luxembourg', 'Netherlands', 'NewZealand', 'Norway', 'Singapore',
  'Spain', 'Sweden', 'Switzerland', 'Taiwan', 'UnitedArabEmirates', 'UnitedKingdom'
] as const

export const NAME_TO_CC: Record<string, string> = {
  Australia: 'AU', Austria: 'AT', Belgium: 'BE', Canada: 'CA', Czechia: 'CZ',
  Denmark: 'DK', Finland: 'FI', France: 'FR', Germany: 'DE', HongKong: 'HK',
  Ireland: 'IE', Israel: 'IL', Italy: 'IT', Japan: 'JP', Liechtenstein: 'LI',
  Luxembourg: 'LU', Netherlands: 'NL', NewZealand: 'NZ', Norway: 'NO',
  Singapore: 'SG', Spain: 'ES', Sweden: 'SE', Switzerland: 'CH', Taiwan: 'TW',
  UnitedArabEmirates: 'AE', UnitedKingdom: 'GB'
}

export function pickRandomCountry(): string {
  return COUNTRIES[Math.floor(Math.random() * COUNTRIES.length)]
}

export const COUNTRY_TO_LOCALE: Record<string, string> = {
  Australia: 'en-AU',
  Austria: 'de-AT',
  Belgium: 'nl-BE',
  Canada: 'en-CA',
  Czechia: 'cs-CZ',
  Denmark: 'da-DK',
  Finland: 'fi-FI',
  France: 'fr-FR',
  Germany: 'de-DE',
  HongKong: 'zh-HK',
  Ireland: 'en-IE',
  Israel: 'he-IL',
  Italy: 'it-IT',
  Japan: 'ja-JP',
  Liechtenstein: 'de-LI',
  Luxembourg: 'lb-LU',
  Netherlands: 'nl-NL',
  NewZealand: 'en-NZ',
  Norway: 'nb-NO',
  Singapore: 'en-SG',
  Spain: 'es-ES',
  Sweden: 'sv-SE',
  Switzerland: 'de-CH',
  Taiwan: 'zh-TW',
  UnitedArabEmirates: 'ar-AE',
  UnitedKingdom: 'en-GB'
}



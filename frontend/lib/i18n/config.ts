export const locales = ['en', 'hi', 'tl', 'es', 'bn', 'ur', 'ar'] as const
export type Locale = (typeof locales)[number]
export const defaultLocale: Locale = 'en'
export const rtlLocales: Locale[] = ['ar', 'ur']

export const localeNames: Record<Locale, string> = {
  en: 'English',
  hi: 'हिन्दी',
  tl: 'Filipino',
  es: 'Español',
  bn: 'বাংলা',
  ur: 'اردو',
  ar: 'العربية',
}

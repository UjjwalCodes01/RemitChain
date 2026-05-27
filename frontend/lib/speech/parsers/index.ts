import { parseEnglishAmount } from './en'
import { parseHindiAmount } from './hi'

export function parseVoiceAmount(text: string, lang: string): number | null {
  // First try to extract a plain number from the text
  const numMatch = text.match(/[\d,]+(\.\d+)?/)
  if (numMatch) {
    const n = parseFloat(numMatch[0].replace(/,/g, ''))
    if (!isNaN(n) && n > 0) return n
  }

  // Language-specific word parsers
  if (lang.startsWith('hi')) return parseHindiAmount(text)

  // Default: English
  return parseEnglishAmount(text)
}

// TODO(native-review): Add parsers for tl-PH (Tagalog), es-MX (Spanish), bn-BD (Bengali), ur-PK (Urdu), ar-SA (Arabic)

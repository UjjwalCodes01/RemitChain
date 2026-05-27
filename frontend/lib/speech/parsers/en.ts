/**
 * English voice number parser.
 * "five thousand two hundred" → 5200
 * "one lakh" → 100000
 */
const ONES: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
}
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
}
const MULTS: Record<string, number> = {
  hundred: 100, thousand: 1000, lakh: 100_000, million: 1_000_000,
}

export function parseEnglishAmount(text: string): number | null {
  const words = text.toLowerCase().replace(/[^a-z\s]/g, '').trim().split(/\s+/)
  let result = 0
  let current = 0

  for (const word of words) {
    if (ONES[word] !== undefined) {
      current += ONES[word]
    } else if (TENS[word] !== undefined) {
      current += TENS[word]
    } else if (word === 'hundred') {
      current = current === 0 ? 100 : current * 100
    } else if (MULTS[word]) {
      result += (current === 0 ? 1 : current) * MULTS[word]
      current = 0
    }
  }
  result += current
  return result > 0 ? result : null
}

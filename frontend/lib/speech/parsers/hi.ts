/**
 * Hindi voice number parser.
 * "paanch hazaar" → 5000, "do sau" → 200, "ek lakh" → 100000
 */
const HINDI_ONES: Record<string, number> = {
  ek: 1, do: 2, teen: 3, char: 4, paanch: 5, chhe: 6, saat: 7, aath: 8, nau: 9, das: 10,
  gyarah: 11, barah: 12, terah: 13, chaudah: 14, pandrah: 15,
  solah: 16, satrah: 17, atharah: 18, unnees: 19, bees: 20,
  'tees': 30, 'chaalees': 40, 'pachaas': 50, 'saath': 60, 'sattar': 70, 'assi': 80, 'nabbe': 90,
}
const HINDI_MULTS: Record<string, number> = {
  sau: 100, hazaar: 1000, lakh: 100_000, crore: 10_000_000,
}

export function parseHindiAmount(text: string): number | null {
  const words = text.toLowerCase().trim().split(/\s+/)
  let result = 0
  let current = 0

  for (const word of words) {
    if (HINDI_ONES[word] !== undefined) {
      current += HINDI_ONES[word]
    } else if (word === 'sau') {
      current = (current === 0 ? 1 : current) * 100
    } else if (HINDI_MULTS[word]) {
      result += (current === 0 ? 1 : current) * HINDI_MULTS[word]
      current = 0
    }
  }
  result += current
  return result > 0 ? result : null
}

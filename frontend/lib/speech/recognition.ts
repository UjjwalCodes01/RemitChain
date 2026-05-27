export type RecognitionState = 'idle' | 'listening' | 'error'

interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList
  resultIndex: number
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string
}

interface SpeechRecognitionInstance extends EventTarget {
  lang: string
  interimResults: boolean
  maxAlternatives: number
  continuous: boolean
  start(): void
  stop(): void
  abort(): void
  onresult: ((e: SpeechRecognitionEvent) => void) | null
  onerror: ((e: SpeechRecognitionErrorEvent) => void) | null
  onend: (() => void) | null
}

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionInstance
    webkitSpeechRecognition?: new () => SpeechRecognitionInstance
  }
}

export function isSpeechSupported(): boolean {
  return typeof window !== 'undefined' && !!(window.SpeechRecognition || window.webkitSpeechRecognition)
}

export function createRecognition(lang: string): SpeechRecognitionInstance | null {
  const SpeechRecognition = window.SpeechRecognition ?? window.webkitSpeechRecognition
  if (!SpeechRecognition) return null
  const rec = new SpeechRecognition()
  rec.lang = lang
  rec.interimResults = true
  rec.maxAlternatives = 1
  rec.continuous = false
  return rec
}

'use client'

import { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { Mic, MicOff, X } from 'lucide-react'
import { isSpeechSupported, createRecognition } from '@/lib/speech/recognition'
import { parseVoiceAmount } from '@/lib/speech/parsers'

interface VoiceInputProps {
  lang?: string
  onAmount: (amount: number) => void
}

export function VoiceInput({ lang = 'en-IN', onAmount }: VoiceInputProps) {
  const [listening, setListening] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [error, setError] = useState('')
  const [supported, setSupported] = useState(false)
  const recRef = useRef<ReturnType<typeof createRecognition>>(null)

  useEffect(() => {
    setSupported(isSpeechSupported())
  }, [])

  if (!supported) return null

  const startListening = () => {
    setError('')
    setTranscript('')
    const rec = createRecognition(lang)
    if (!rec) return

    rec.onresult = (e) => {
      const text = Array.from(e.results)
        .map(r => r[0].transcript)
        .join(' ')
      setTranscript(text)

      if (e.results[e.results.length - 1].isFinal) {
        const amount = parseVoiceAmount(text, lang)
        if (amount !== null) {
          onAmount(amount)
          stopListening()
        }
      }
    }

    rec.onerror = (e) => {
      setError(e.error === 'no-speech' ? 'No speech detected' : 'Mic error')
      setListening(false)
    }

    rec.onend = () => setListening(false)

    recRef.current = rec
    rec.start()
    setListening(true)
    if (navigator.vibrate) navigator.vibrate(15)
  }

  const stopListening = () => {
    recRef.current?.stop()
    setListening(false)
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <button
        onClick={listening ? stopListening : startListening}
        className="relative w-12 h-12 rounded-full flex items-center justify-center press-scale transition-all"
        style={{
          background: listening ? 'var(--color-mint)' : 'var(--color-surface-elevated)',
          boxShadow: listening ? '0 0 0 0 var(--color-mint-glow)' : 'none',
        }}
        aria-label={listening ? 'Stop listening' : 'Start voice input'}
        aria-pressed={listening}
      >
        {listening ? (
          <>
            <motion.div
              className="absolute inset-0 rounded-full"
              animate={{ scale: [1, 1.5, 1], opacity: [0.6, 0, 0.6] }}
              transition={{ repeat: Infinity, duration: 1.5 }}
              style={{ background: 'var(--color-mint)', opacity: 0.3 }}
            />
            <Mic className="w-5 h-5 relative z-10" style={{ color: 'var(--color-ink)' }} />
          </>
        ) : (
          <Mic className="w-5 h-5" style={{ color: 'var(--color-text-secondary)' }} />
        )}
      </button>

      <AnimatePresence>
        {(transcript || error) && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="text-center"
          >
            {transcript && (
              <p className="text-xs italic" style={{ color: 'var(--color-text-tertiary)' }}>
                &ldquo;{transcript}&rdquo;
              </p>
            )}
            {error && (
              <p className="text-xs" style={{ color: 'var(--color-coral)' }}>{error}</p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

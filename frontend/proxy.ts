import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { defaultLocale, locales } from './lib/i18n/config'

export function proxy(request: NextRequest) {
  // Check if NEXT_LOCALE cookie exists
  const hasLocale = request.cookies.has('NEXT_LOCALE')
  
  if (!hasLocale) {
    // Check accept-language header
    const acceptLang = request.headers.get('accept-language')
    let detectedLocale = defaultLocale
    
    if (acceptLang) {
      const preferred = acceptLang.split(',')[0].split('-')[0]
      if ((locales as readonly string[]).includes(preferred)) {
        detectedLocale = preferred as typeof defaultLocale
      }
    }
    
    // Set cookie on response
    const response = NextResponse.next()
    response.cookies.set('NEXT_LOCALE', detectedLocale, {
      path: '/',
      maxAge: 31536000,
      sameSite: 'lax',
    })
    return response
  }
  
  return NextResponse.next()
}

export const config = {
  matcher: [
    '/((?!api|_next/static|_next/image|favicon.ico|sw.js|manifest.json|icons).*)',
  ]
}

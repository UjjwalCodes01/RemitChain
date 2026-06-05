/**
 * lib/notify/templates/email.ts
 *
 * Branded HTML + plaintext email templates for OTP delivery via Resend.
 *
 * Design goals:
 *   - Mobile-first, renders well in Gmail, Outlook, Apple Mail
 *   - No tracking pixels, no marketing footer — purely transactional
 *   - Lands in inbox, not spam (transactional sender, unsubscribe not needed)
 *   - Prominent 6-digit OTP in a monospace box
 *   - "Claim your money" CTA button
 *   - Localized (en + hi to start)
 */

export interface EmailTemplateData {
  otp: string
  amount: string       // formatted e.g. "50.00 QUSD (~₹4,150)"
  senderName?: string  // optional — "You've received from Rahul" or generic
  claimUrl: string
  expiresInHours?: number // default 48
  locale?: 'en' | 'hi'
}

const BRAND_COLOR = '#00D68F'  // mint green
const DARK_BG     = '#0A0A0B'
const SURFACE     = '#131415'
const TEXT_PRIMARY = '#FFFFFF'
const TEXT_SECONDARY = '#A0A0A5'

export function buildOtpEmailHtml(data: EmailTemplateData): string {
  const { otp, amount, senderName, claimUrl, expiresInHours = 48, locale = 'en' } = data

  const t = TRANSLATIONS[locale] ?? TRANSLATIONS.en
  const fromLine = senderName
    ? t.fromLine.replace('{name}', senderName)
    : t.fromLineGeneric

  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>${t.subject.replace('{amount}', amount)}</title>
  <!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
  <style>
    body { margin: 0; padding: 0; background: ${DARK_BG}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; }
    .container { max-width: 520px; margin: 0 auto; padding: 24px 16px; }
    .card { background: ${SURFACE}; border-radius: 20px; overflow: hidden; border: 1px solid rgba(255,255,255,0.06); }
    .header { background: ${BRAND_COLOR}; padding: 28px 32px; text-align: center; }
    .header-logo { font-size: 22px; font-weight: 800; color: #000; letter-spacing: -0.03em; }
    .header-tagline { font-size: 12px; color: rgba(0,0,0,0.6); margin-top: 4px; }
    .body { padding: 32px; }
    .amount-badge { background: rgba(0,214,143,0.1); border: 1px solid rgba(0,214,143,0.3); border-radius: 12px; padding: 16px; text-align: center; margin-bottom: 24px; }
    .amount-value { font-size: 28px; font-weight: 800; color: ${BRAND_COLOR}; letter-spacing: -0.02em; }
    .amount-from { font-size: 13px; color: ${TEXT_SECONDARY}; margin-top: 4px; }
    .section-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.1em; color: ${TEXT_SECONDARY}; margin-bottom: 12px; }
    .otp-box { background: ${DARK_BG}; border: 1px solid rgba(0,214,143,0.2); border-radius: 12px; padding: 20px; text-align: center; margin-bottom: 24px; }
    .otp-code { font-family: 'Courier New', Courier, monospace; font-size: 40px; font-weight: 900; letter-spacing: 0.18em; color: ${TEXT_PRIMARY}; }
    .otp-warning { font-size: 12px; color: ${TEXT_SECONDARY}; margin-top: 8px; }
    .cta-btn { display: block; background: ${BRAND_COLOR}; color: #000; text-decoration: none; text-align: center; font-weight: 700; font-size: 15px; padding: 16px 24px; border-radius: 12px; margin-bottom: 24px; }
    .steps { background: rgba(255,255,255,0.03); border-radius: 12px; padding: 16px 20px; margin-bottom: 24px; }
    .step { display: flex; gap: 12px; align-items: flex-start; margin-bottom: 12px; }
    .step:last-child { margin-bottom: 0; }
    .step-num { background: rgba(0,214,143,0.15); color: ${BRAND_COLOR}; font-weight: 700; font-size: 12px; min-width: 22px; height: 22px; border-radius: 50%; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .step-text { font-size: 13px; color: ${TEXT_SECONDARY}; line-height: 1.5; }
    .expiry-note { font-size: 12px; color: ${TEXT_SECONDARY}; text-align: center; margin-bottom: 20px; }
    .divider { height: 1px; background: rgba(255,255,255,0.06); margin: 20px 0; }
    .footer { padding: 0 32px 24px; text-align: center; }
    .footer-text { font-size: 11px; color: rgba(255,255,255,0.2); line-height: 1.6; }
    .claim-link { font-family: 'Courier New', monospace; font-size: 10px; color: rgba(255,255,255,0.15); word-break: break-all; }
    @media (max-width: 480px) {
      .body { padding: 24px 20px; }
      .otp-code { font-size: 32px; }
      .amount-value { font-size: 22px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- Header -->
    <div class="card">
      <div class="header">
        <div class="header-logo">⚡ RemitChain</div>
        <div class="header-tagline">${t.tagline}</div>
      </div>

      <!-- Body -->
      <div class="body">
        <h2 style="font-size:20px;font-weight:700;color:${TEXT_PRIMARY};margin:0 0 8px;letter-spacing:-0.02em">${t.headline}</h2>
        <p style="font-size:14px;color:${TEXT_SECONDARY};margin:0 0 24px;line-height:1.6">${fromLine}</p>

        <!-- Amount -->
        <div class="amount-badge">
          <div class="amount-value">${amount}</div>
          <div class="amount-from">${t.awaitingClaim}</div>
        </div>

        <!-- OTP -->
        <div class="section-label">${t.yourCode}</div>
        <div class="otp-box">
          <div class="otp-code">${otp}</div>
          <div class="otp-warning">${t.keepSecret}</div>
        </div>

        <!-- CTA -->
        <a href="${claimUrl}" class="cta-btn">${t.claimBtn} →</a>

        <!-- Steps -->
        <div class="section-label">${t.howItWorks}</div>
        <div class="steps">
          <div class="step">
            <div class="step-num">1</div>
            <div class="step-text">${t.step1}</div>
          </div>
          <div class="step">
            <div class="step-num">2</div>
            <div class="step-text">${t.step2}</div>
          </div>
          <div class="step">
            <div class="step-num">3</div>
            <div class="step-text">${t.step3}</div>
          </div>
        </div>

        <!-- Expiry -->
        <p class="expiry-note">⏳ ${t.expires.replace('{h}', String(expiresInHours))}</p>

        <div class="divider"></div>

        <!-- Fallback link -->
        <p style="font-size:12px;color:${TEXT_SECONDARY};text-align:center;margin-bottom:8px">${t.buttonNotWorking}</p>
        <p class="claim-link">${claimUrl}</p>
      </div>

      <!-- Footer -->
      <div class="footer">
        <p class="footer-text">
          ${t.footer}<br/>
          ${t.noReply}
        </p>
      </div>
    </div>

    <!-- Bottom spacer -->
    <p style="text-align:center;font-size:10px;color:rgba(255,255,255,0.08);margin-top:16px">
      RemitChain · QIE Blockchain · 0.1% fee
    </p>
  </div>
</body>
</html>`
}

export function buildOtpEmailPlaintext(data: EmailTemplateData): string {
  const { otp, amount, senderName, claimUrl, expiresInHours = 48, locale = 'en' } = data
  const t = TRANSLATIONS[locale] ?? TRANSLATIONS.en
  const fromLine = senderName
    ? t.fromLine.replace('{name}', senderName)
    : t.fromLineGeneric

  return `RemitChain — ${t.headline}

${fromLine}

Amount: ${amount}

YOUR CLAIM CODE: ${otp}

${t.keepSecret}

Claim your money here:
${claimUrl}

Steps:
1. ${t.step1}
2. ${t.step2}
3. ${t.step3}

${t.expires.replace('{h}', String(expiresInHours))}

---
RemitChain · QIE Blockchain · 0.1% fee
${t.noReply}
`
}

// ── Translations ──────────────────────────────────────────────────────────────

interface Translations {
  subject: string
  tagline: string
  headline: string
  fromLine: string       // includes {name}
  fromLineGeneric: string
  awaitingClaim: string
  yourCode: string
  keepSecret: string
  claimBtn: string
  howItWorks: string
  step1: string
  step2: string
  step3: string
  expires: string        // includes {h}
  buttonNotWorking: string
  footer: string
  noReply: string
}

const TRANSLATIONS: Record<'en' | 'hi', Translations> = {
  en: {
    subject: "You've received {amount} on RemitChain",
    tagline: 'Near-zero fees · Pay anyone by phone',
    headline: "You've received money!",
    fromLine: '{name} sent you funds via RemitChain.',
    fromLineGeneric: 'Someone sent you funds via RemitChain.',
    awaitingClaim: 'Awaiting your claim',
    yourCode: 'Your 6-digit claim code',
    keepSecret: 'Keep this code secret — anyone with it can claim your funds.',
    claimBtn: 'Claim your money',
    howItWorks: 'How to claim',
    step1: 'Click the "Claim your money" button above.',
    step2: 'Enter your phone number and the 6-digit code above.',
    step3: "Funds are released instantly — no wallet needed.",
    expires: 'This code expires in {h} hours.',
    buttonNotWorking: "Button not working? Paste this link in your browser:",
    footer: 'This is a transactional email from RemitChain. You received this because someone sent you funds.',
    noReply: 'Do not reply to this email.',
  },
  hi: {
    subject: "RemitChain पर आपको {amount} प्राप्त हुए",
    tagline: 'न्यूनतम शुल्क · किसी को भी फोन से भुगतान',
    headline: "आपको पैसे मिले हैं!",
    fromLine: '{name} ने RemitChain के माध्यम से आपको पैसे भेजे हैं।',
    fromLineGeneric: 'किसी ने RemitChain के माध्यम से आपको पैसे भेजे हैं।',
    awaitingClaim: 'आपके क्लेम की प्रतीक्षा है',
    yourCode: 'आपका 6-अंकीय क्लेम कोड',
    keepSecret: 'यह कोड गुप्त रखें — इसके साथ कोई भी आपके पैसे ले सकता है।',
    claimBtn: 'अपने पैसे लें',
    howItWorks: 'कैसे क्लेम करें',
    step1: 'ऊपर दिए "अपने पैसे लें" बटन पर क्लिक करें।',
    step2: 'अपना फोन नंबर और ऊपर दिया 6-अंकीय कोड दर्ज करें।',
    step3: 'पैसे तुरंत जारी होते हैं — किसी वॉलेट की आवश्यकता नहीं।',
    expires: 'यह कोड {h} घंटों में समाप्त हो जाएगा।',
    buttonNotWorking: 'बटन काम नहीं कर रहा? इस लिंक को ब्राउज़र में पेस्ट करें:',
    footer: 'यह RemitChain से एक लेनदेन ईमेल है। आपको यह इसलिए मिला क्योंकि किसी ने आपको पैसे भेजे।',
    noReply: 'इस ईमेल का जवाब न दें।',
  },
}

export function getEmailSubject(amount: string, locale: 'en' | 'hi' = 'en'): string {
  return (TRANSLATIONS[locale] ?? TRANSLATIONS.en).subject.replace('{amount}', amount)
}

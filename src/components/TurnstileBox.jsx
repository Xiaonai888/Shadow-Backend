import { useEffect, useRef, useState } from 'react'

export default function TurnstileBox({ siteKey, refreshKey, onVerify, onExpire, onError }) {
  const containerRef = useRef(null)
  const widgetRef = useRef(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (window.turnstile) {
      setReady(true)
      return
    }

    const existingScript = document.querySelector('script[src="https://challenges.cloudflare.com/turnstile/v0/api.js"]')

    if (existingScript) {
      existingScript.addEventListener('load', () => setReady(true), { once: true })
      return
    }

    const script = document.createElement('script')
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js'
    script.async = true
    script.defer = true
    script.onload = () => setReady(true)
    document.body.appendChild(script)
  }, [])

  useEffect(() => {
    if (!ready || !siteKey || !containerRef.current || !window.turnstile) return

    if (widgetRef.current) {
      window.turnstile.remove(widgetRef.current)
      widgetRef.current = null
    }

    widgetRef.current = window.turnstile.render(containerRef.current, {
      sitekey: siteKey,
      callback: onVerify,
      'expired-callback': onExpire,
      'error-callback': onError,
      theme: 'light',
    })

    return () => {
      if (widgetRef.current && window.turnstile) {
        window.turnstile.remove(widgetRef.current)
        widgetRef.current = null
      }
    }
  }, [ready, siteKey, refreshKey, onVerify, onExpire, onError])

  if (!siteKey) {
    return (
      <div className="rounded-[14px] bg-[#fff1f1] px-4 py-3 text-[12px] font-bold text-[#e5484d]">
        Turnstile site key is missing.
      </div>
    )
  }

  return <div ref={containerRef} />
}

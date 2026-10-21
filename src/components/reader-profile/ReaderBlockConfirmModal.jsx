import { useEffect, useRef } from 'react'
import ReaderBlockAvatar from './ReaderBlockAvatar'

export default function ReaderBlockConfirmModal({
  open,
  target,
  shouldBlock = true,
  onConfirm,
  onCancel,
  busy = false,
  error = '',
  t,
}) {
  const cancelRef = useRef(null)
  const onCancelRef = useRef(onCancel)
  const busyRef = useRef(busy)
  onCancelRef.current = onCancel
  busyRef.current = busy

  useEffect(() => {
    if (!open) return undefined
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    cancelRef.current?.focus()

    function onKeyDown(event) {
      if (event.key === 'Escape' && !busyRef.current) onCancelRef.current?.()
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  if (!open || !target) return null

  const name = String(target.name || target.page_name || target.username || target.page_username || '')
  const title = t(shouldBlock ? 'readerBlockedAccounts.blockTitle' : 'readerBlockedAccounts.unblockTitle', { name })
  const description = t(shouldBlock ? 'readerBlockedAccounts.blockQuestion' : 'readerBlockedAccounts.unblockQuestion', { name })

  return (
    <div className="fixed inset-0 z-[320] flex items-center justify-center bg-black/60 px-5" role="presentation">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="reader-block-confirm-title"
        aria-describedby="reader-block-confirm-description"
        className="w-full max-w-[350px] rounded-[20px] bg-[var(--shadow-bg-surface)] px-[17px] pb-[17px] pt-5 text-center text-[var(--shadow-text-primary)]"
      >
        <div className="flex justify-center">
          <ReaderBlockAvatar size="lg" src={target.avatar_url} name={name} />
        </div>
        <h2 id="reader-block-confirm-title" className="mt-3 text-[16px] font-bold leading-6">
          {title}
        </h2>
        <p id="reader-block-confirm-description" className="mt-3 text-[12px] leading-5 text-[var(--shadow-text-secondary)]">
          {description}
        </p>
        {error ? (
          <p role="alert" className="mt-3 text-[12px] text-[#f43f5e]">{error}</p>
        ) : null}
        <div className="mt-5 flex flex-col gap-2">
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="min-h-[36px] w-full rounded-full bg-[#ff4d70] px-4 text-[12px] font-semibold text-white active:opacity-90 disabled:opacity-60"
          >
            {busy ? t('readerBlockedAccounts.saving') : t(shouldBlock ? 'readerBlockedAccounts.block' : 'readerBlockedAccounts.unblock')}
          </button>
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="min-h-[36px] w-full rounded-full border border-[var(--shadow-border)] bg-[var(--shadow-bg-surface)] px-4 text-[12px] font-medium text-[var(--shadow-text-primary)] active:bg-[var(--shadow-bg-soft)] disabled:opacity-60"
          >
            {t('readerBlockedAccounts.cancel')}
          </button>
        </div>
      </section>
    </div>
  )
}

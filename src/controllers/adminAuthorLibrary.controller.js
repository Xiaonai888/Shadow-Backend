import React, { useCallback, useEffect, useRef, useState } from 'react'
import AdminLayout from '../components/AdminLayout'

const API = import.meta.env.VITE_API_URL || 'https://shadow-backend-kucw.onrender.com'
const TTL = 60_000
const styles = `
  .al-wrap{max-width:1120px;margin:0 auto;color:#17243b}
  .al-tools{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 18px}
  .al-search,.al-input{border:1px solid #dce4f2;border-radius:11px;padding:11px 13px;outline:none;font:inherit;background:#fff;color:#182641;min-width:0}
  .al-search{flex:1;min-width:200px}
  .al-tabs{display:flex;gap:5px;align-items:center}
  .al-btn{border:1px solid #dce4f2;border-radius:11px;background:#fff;color:#17243b;padding:10px 13px;font:inherit;font-weight:700;cursor:pointer}
  .al-btn.active,.al-btn.primary{background:#4f46e5;color:#fff;border-color:#4f46e5}
  .al-btn:disabled{opacity:.55;cursor:default}
  .al-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px}
  .al-card,.al-detail,.al-empty,.al-metrics{border:1px solid #dce4f2;border-radius:17px;background:#fff;padding:14px}
  .al-card{display:flex;gap:12px;text-align:left;min-width:0;cursor:pointer;color:inherit;font:inherit}
  .al-card.selected{border-color:#4f46e5;box-shadow:0 0 0 2px #e6e7ff}
  .al-cover{width:66px;height:90px;border-radius:9px;object-fit:cover;background:#eef2ff;flex-shrink:0}
  .al-name{font-size:14px;font-weight:700;line-height:1.45;overflow-wrap:anywhere}
  .al-muted{color:#697991;font-size:12px;line-height:1.55;margin-top:5px;overflow-wrap:anywhere}
  .al-chip{display:inline-flex;max-width:100%;align-items:center;border-radius:7px;padding:4px 7px;margin:5px 4px 0 0;font-size:11px;font-weight:700;background:#edf2ff;color:#3c4f85}
  .al-chip.good{background:#ecfdf3;color:#15734c}.al-chip.warn{background:#fff4e7;color:#9a5600}
  .al-detail{margin-top:17px;overflow-wrap:anywhere}.al-detail h2{font-size:18px;margin:0 0 10px;font-weight:700}
  .al-detail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-bottom:14px}
  .al-detail-grid div{padding:9px;border-radius:9px;background:#f7f9fd;font-size:13px}
  .al-detail-grid span{display:block;color:#697991;font-size:11px;margin-bottom:4px}
  .al-foot{display:flex;justify-content:space-between;align-items:center;gap:10px;margin:17px 0;flex-wrap:wrap}
  .al-overlay{position:fixed;inset:0;z-index:9000;display:grid;place-items:center;background:rgba(12,23,45,.65);padding:16px}
  .al-modal{width:min(440px,100%);border-radius:19px;background:#fff;padding:22px;display:grid;gap:12px;box-shadow:0 18px 50px #0003}
  .al-modal h2{font-size:18px;margin:0}.al-modal p{font-size:13px;color:#66728b;line-height:1.6;margin:0}
  .al-error{color:#b91c1c;margin:9px 0;font-size:13px}.al-actions{display:flex;justify-content:flex-end;gap:8px}
  @media(max-width:540px){.al-detail-grid{grid-template-columns:1fr}.al-tools{flex-direction:column}.al-tabs{justify-content:space-between}.al-card{min-width:0}}
`

function headers() {
  const token = sessionStorage.getItem('shadow_admin_token') || localStorage.getItem('shadow_admin_token') || ''
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function money(value) { return `$${Number(value || 0).toFixed(2)}` }
function statusLabel(item) {
  if (item.product_type === 'book') return 'Physical book'
  return item.access_rule || 'Access rule unknown'
}

export default function AdminAuthorLibraryPage() {
  const [type, setType] = useState('all')
  const [input, setInput] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [hasNext, setHasNext] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [modal, setModal] = useState(false)
  const [pin, setPin] = useState('')
  const [showPin, setShowPin] = useState(false)
  const [intent, setIntent] = useState('download')
  const [preview, setPreview] = useState(null)
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState('')
  const reqId = useRef(0)
  const cacheRef = useRef(new Map())
  const previewUrlRef = useRef('')
  const selected = items.find(item => item.id === selectedId) || null

  useEffect(() => {
    const timer = setTimeout(() => { setSearch(input.trim()); setPage(1); setSelectedId('') }, 350)
    return () => clearTimeout(timer)
  }, [input])

  const load = useCallback(async (force = false) => {
    const current = ++reqId.current
    const key = `${headers().Authorization || ''}|${type}|${search}|${page}`
    const saved = cacheRef.current.get(key)
    if (!force && saved && Date.now() - saved.time < TTL) {
      setItems(saved.data.items); setTotal(saved.data.total); setHasNext(saved.data.has_next); setError(''); setLoading(false)
      return
    }
    setLoading(true); setError('')
    try {
      const params = new URLSearchParams({ type, q: search, page: String(page) })
      const response = await fetch(`${API}/api/admin/income/author-library?${params}`, { headers: headers(), cache: 'no-store' })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || !body.ok || !Array.isArray(body.items)) throw new Error(body.message || 'Unable to load Author Library')
      if (current !== reqId.current) return
      cacheRef.current.set(key, { time: Date.now(), data: body })
      if (cacheRef.current.size > 30) cacheRef.current.delete(cacheRef.current.keys().next().value)
      setItems(body.items); setTotal(body.total); setHasNext(body.has_next)
    } catch (reason) {
      if (current === reqId.current) { setError(reason.message || 'Unable to load library'); setItems([]); setTotal(0); setHasNext(false) }
    } finally { if (current === reqId.current) setLoading(false) }
  }, [type, search, page])

  useEffect(() => { void load(); return () => { reqId.current += 1 } }, [load])

  function switchType(value) { setType(value); setPage(1); setSelectedId(''); setError('') }
  function openProtected(nextIntent) { setIntent(nextIntent); setPin(''); setShowPin(false); setDownloadError(''); setModal(true) }
  function closeDownload() { if (!downloading) { setModal(false); setPin(''); setShowPin(false); setDownloadError('') } }
  function closePreview() { if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current); previewUrlRef.current = ''; setPreview(null) }
  useEffect(() => () => { if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current) }, [])

  async function download(event) {
    event.preventDefault()
    if (!selected || downloading) return
    const id = selected.id
    const fileName = selected.pdf_file_name || `author-pdf-${id}.pdf`
    const fileTitle = selected.title || 'PDF'
    const action = intent
    setDownloading(true); setDownloadError('')
    try {
      const response = await fetch(`${API}/api/admin/income/author-library/${encodeURIComponent(id)}/${action}`, {
        method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' },
        cache: 'no-store', body: JSON.stringify({ pin }),
      })
      setPin('')
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.message || 'PDF verification failed')
      }
      const file = await response.blob()
      if (file.size < 5 || !file.type.toLowerCase().includes('application/pdf')) throw new Error('Server did not return a PDF')
      const url = URL.createObjectURL(file)
      if (action === 'read') {
        closePreview()
        previewUrlRef.current = url
        setPreview({ url, title: fileTitle })
        setModal(false)
        return
      }
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = fileName.replace(/[\\/]/g, '_')
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 60000)
      setModal(false)
    } catch (reason) { setDownloadError(reason.message || 'PDF download failed') }
    finally { setDownloading(false) }
  }

  return (
    <AdminLayout title="Author Library" subtitle="Review author products and inspect private PDFs securely">
      <style>{styles}</style>
      <div className="al-wrap">
        <div className="al-tools">
          <input className="al-search" aria-label="Search author products" placeholder="Search title, author, Author Page…" value={input} onChange={event => setInput(event.target.value)} maxLength={60} />
          <div className="al-tabs">{['all', 'book', 'pdf'].map(value => <button className={`al-btn ${type === value ? 'active' : ''}`} type="button" key={value} onClick={() => switchType(value)}>{value === 'all' ? 'All' : value === 'book' ? 'Book' : 'PDF'}</button>)}</div>
          <button className="al-btn" type="button" disabled={loading} onClick={() => { cacheRef.current.clear(); void load(true) }}>Refresh</button>
        </div>
        <p className="al-muted">{loading ? 'Loading…' : `${total} products · page ${page} · 20 per page`} · Private PDF files are never cached</p>
        {error ? <p className="al-error" role="alert">{error}</p> : null}
        <div className="al-list">
          {!loading && !error && !items.length ? <div className="al-empty">No products found.</div> : null}
          {items.map(item => <button key={item.id} type="button" className={`al-card ${selectedId === item.id ? 'selected' : ''}`} onClick={() => setSelectedId(item.id)}>
            {item.cover_url ? <img className="al-cover" src={item.cover_url} alt="" loading="lazy" /> : <div className="al-cover" />}
            <div style={{ minWidth: 0 }}><div className="al-name">{item.title || 'Untitled'}</div><div className="al-muted">{item.author_page_name || item.author_page_username || 'Unknown Author Page'} · {item.author_name || 'Author unspecified'}</div>
              <span className="al-chip">{item.product_type?.toUpperCase()}</span><span className="al-chip">{statusLabel(item)}</span>
              {item.product_type === 'pdf' ? <span className={`al-chip ${item.file_recorded ? 'good' : 'warn'}`}>{item.file_recorded ? 'PDF recorded · not inspected' : 'No PDF file'}</span> : null}
              <div className="al-muted">{money(item.price_usd)} · {item.status || 'Unknown status'}</div>
            </div>
          </button>)}
        </div>
        <div className="al-foot"><span className="al-muted">Page {page} of {Math.max(1, Math.ceil(total / 20))}</span><div style={{ display: 'flex', gap: 8 }}><button className="al-btn" type="button" disabled={loading || page < 2} onClick={() => { setPage(page - 1); setSelectedId('') }}>Previous</button><button className="al-btn primary" type="button" disabled={loading || !hasNext} onClick={() => { setPage(page + 1); setSelectedId('') }}>Load more</button></div></div>
        {selected ? <section className="al-detail" aria-label="Product details">
          <h2>{selected.title}</h2>
          <div className="al-detail-grid">
            <div><span>Author Page</span>{selected.author_page_name || selected.author_page_username || '-'}</div>
            <div><span>Author</span>{selected.author_name || '-'}</div>
            <div><span>Type / access</span>{selected.product_type?.toUpperCase()} · {statusLabel(selected)}</div>
            <div><span>Price / status</span>{money(selected.price_usd)} · {selected.status}</div>
            <div><span>File name / size</span>{selected.product_type === 'pdf' ? `${selected.pdf_file_name || '-'} · ${selected.pdf_size_bytes ? Math.round(selected.pdf_size_bytes / 1024).toLocaleString() + ' KB' : 'Unknown size'}` : 'Physical book · no PDF'}</div>
            <div><span>Storage record</span>{selected.product_type === 'pdf' ? selected.file_recorded ? selected.pdf_private ? 'Private PDF record · actual file unverified' : 'Public/legacy PDF · admin download unavailable' : 'No PDF attached' : `Stock: ${selected.stock_quantity ?? 0}`}</div>
          </div>
          {selected.product_type === 'pdf' && selected.pdf_private && selected.file_recorded ? <div className="al-actions" style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }}><button className="al-btn" type="button" onClick={() => openProtected('read')}>Read Online · Passkey</button><button className="al-btn primary" type="button" onClick={() => openProtected('download')}>Download PDF · Passkey</button></div> : <p className="al-muted">{selected.product_type === 'book' ? 'Physical books do not have a PDF download.' : 'Secure download requires a private PDF file.'}</p>}
          <p className="al-muted">An Admin inspection download does not change a reader’s Read Online Only access rights. A PDF signature check is not a guarantee that its pages and content are correct; inspect the downloaded file.</p>
        </section> : null}
      </div>
      {preview ? <div className="al-overlay" role="dialog" aria-modal="true" aria-label={`Read ${preview.title}`} style={{ padding: 8 }}><div style={{ width: 'min(100%, 1050px)', height: 'min(96dvh, 1100px)', background: '#fff', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' }}><div style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'space-between', padding: 12 }}><strong style={{ fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis' }}>{preview.title}</strong><button className="al-btn" type="button" onClick={closePreview}>Close</button></div><iframe title={preview.title} src={preview.url} style={{ width: '100%', flex: 1, border: 0, background: '#fff' }} /></div></div> : null}
      {modal && selected ? <div className="al-overlay" role="presentation"><form className="al-modal" onSubmit={download} aria-label="Verify PDF inspection download">
        <h2>{intent === 'read' ? 'Read PDF online' : 'Confirm PDF inspection'}</h2><p>{selected.title}</p><p>Enter your existing Admin Passkey PIN. Backend checks it every time before sending a private PDF.</p>
        <label htmlFor="al-pin">Admin Passkey PIN (6 digits)</label>
        <div style={{ position: 'relative' }}><input id="al-pin" className="al-input" style={{ width: '100%', boxSizing: 'border-box', paddingRight: 48 }} value={pin} onChange={event => setPin(event.target.value.replace(/\D/g, '').slice(0, 6))} type={showPin ? 'text' : 'password'} autoComplete="off" inputMode="numeric" maxLength={6} required />
          <button type="button" onClick={() => setShowPin(value => !value)} aria-label={showPin ? 'Hide Passkey PIN' : 'Show Passkey PIN'} aria-pressed={showPin} title={showPin ? 'Hide PIN' : 'Show PIN'} style={{ position: 'absolute', right: 5, top: 3, width: 39, height: 39, display: 'grid', placeItems: 'center', border: 0, background: 'transparent', color: '#516079', cursor: 'pointer' }}>
            <svg aria-hidden="true" width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>{showPin ? null : <path d="M3 3l18 18"/>}</svg>
          </button>
        </div>
        {downloadError ? <p className="al-error" role="alert">{downloadError}</p> : null}
        <div className="al-actions"><button type="button" className="al-btn" disabled={downloading} onClick={closeDownload}>Cancel</button><button className="al-btn primary" type="submit" disabled={downloading || pin.length !== 6}>{downloading ? 'Verifying…' : intent === 'read' ? 'Verify & Read' : 'Verify & Download'}</button></div>
      </form></div> : null}
    </AdminLayout>
  )
}

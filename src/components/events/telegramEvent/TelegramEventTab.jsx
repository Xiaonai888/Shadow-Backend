import React,{useEffect,useRef,useState} from 'react'
import {eventApi,eventLanguages,eventLocalTime} from '../../../services/telegramEventAdminApi'
import TelegramEventEditor from './TelegramEventEditor'
import './telegramEvent.css'
const labels={all:'All',reader:'Reader',author:'Author'}
export default function TelegramEventTab({onEditorChange,onChannels,onHistory,onPostNow}){
  const [language,setLanguage]=useState('km')
  const [audience,setAudience]=useState('all')
  const [page,setPage]=useState(1)
  const [rows,setRows]=useState([])
  const [more,setMore]=useState(false)
  const [loading,setLoading]=useState(true)
  const [error,setError]=useState('')
  const [refresh,setRefresh]=useState(0)
  const [editor,setEditor]=useState(null)
  const [busy,setBusy]=useState(false)
  const action=useRef(false)
  const detailController=useRef(null)
  const editorOpen=Boolean(editor)
  useEffect(()=>{onEditorChange?.(editorOpen);return()=>{onEditorChange?.(false)}},[editorOpen,onEditorChange])
  useEffect(()=>()=>detailController.current?.abort(),[])
  useEffect(()=>{
    if(editorOpen)return
    const controller=new AbortController()
    setLoading(true);setError('');setRows([]);setMore(false)
    eventApi.list({language,audience,page},controller.signal).then(data=>{if(!controller.signal.aborted){setRows(data.items||[]);setMore(Boolean(data.has_more))}}).catch(e=>{if(!controller.signal.aborted)setError(e.message)}).finally(()=>{if(!controller.signal.aborted)setLoading(false)})
    return()=>controller.abort()
  },[language,audience,page,refresh,editorOpen])
  const reload=()=>setRefresh(v=>v+1)
  async function run(fn){if(action.current)return;action.current=true;setBusy(true);setError('');try{await fn()}catch(e){if(e.name!=='AbortError')setError(e.message)}finally{action.current=false;setBusy(false)}}
  function open(row){void run(async()=>{const controller=new AbortController();detailController.current=controller;const data=await eventApi.detail(row.id,controller.signal);if(!controller.signal.aborted)setEditor({row:data.item})})}
  function duplicate(row){if(window.confirm(`Create a draft copy of ${row.name}?`))void run(async()=>{await eventApi.duplicate(row.id,Number(row.revision));setPage(1);reload()})}
  function archive(row){if(window.confirm(`Archive ${row.name} and stop future posts?`))void run(async()=>{await eventApi.archive(row.id,Number(row.revision));setPage(1);reload()})}
  function pause(row){if(!window.confirm(`Pause ${row.name} in every language?`))return;void run(async()=>{const {item}=await eventApi.detail(row.id);await eventApi.save(item.id,{name:item.name,audience:item.audience,status:'paused',schedule_mode:item.schedule_mode,schedule_slots:item.schedule_slots,starts_on:item.starts_on,ends_on:item.ends_on,revision:Number(item.revision),contents:[]});reload()})}
  if(editor)return <TelegramEventEditor row={editor.row} language={language} audience={audience==='all'?'reader':audience} onBack={()=>setEditor(null)} onSaved={()=>{setEditor(null);setPage(1);reload()}}/>
  const selected=eventLanguages.find(l=>l.code===language)
  return <section className="te-shell">
    <header className="te-head"><div><h2>Telegram Event</h2><p>Manage scheduled announcements by language.</p></div><div className="te-actions">{onChannels&&<button type="button" disabled={busy} onClick={()=>onChannels(language)}>Channel Settings</button>}{onHistory&&<button type="button" disabled={busy} onClick={()=>onHistory(language)}>Action History</button>}</div></header>
    <div className="te-languages" aria-label="Event language">{eventLanguages.map(l=><button type="button" key={l.code} disabled={busy} className={`te-language ${language===l.code?'selected':''}`} aria-pressed={language===l.code} onClick={()=>{if(language!==l.code){setLanguage(l.code);setPage(1)}}}><span className="te-flag">{l.flag}</span><span><strong>{l.name}</strong><small>{l.code===language?'Selected':'Manage'}</small></span>{l.code===language&&<span className="te-tick" aria-hidden="true">✓</span>}</button>)}</div>
    <div className="te-panel"><header className="te-head"><div><h3>{selected.name} Events</h3><p>All times in Cambodia (UTC+7)</p></div><button type="button" className="te-primary" disabled={busy} onClick={()=>setEditor({row:null})}>+ Create Event</button></header><div className="te-filters" aria-label="Event type">{Object.entries(labels).map(([v,t])=><button type="button" key={v} disabled={busy} className={audience===v?'te-primary':''} aria-pressed={audience===v} onClick={()=>{if(audience!==v){setAudience(v);setPage(1)}}}>{t}</button>)}</div>
    {error&&<div role="alert" className="te-error">{error} <button type="button" disabled={busy} onClick={reload}>Retry</button></div>}
    {loading?<p className="te-note" role="status">Loading events…</p>:!rows.length&&!error?<p className="te-note">No events for this language and filter.</p>:<div className="te-list">{rows.map(row=>{const content=row.contents?.[0];return <article key={row.id} className="te-event"><div className="te-event-top">{content?.image_url?<img className="te-thumb" src={content.image_url} alt="" loading="lazy"/>:<div className="te-thumb te-placeholder" aria-hidden="true">{row.audience==='author'?'A':'R'}</div>}<div className="te-event-info"><h3>{row.name}</h3><p>{labels[row.audience]} · {row.schedule_mode==='weekly'?'Weekly':'Specific dates'} · {row.schedule_mode==='weekly'&&!row.ends_on&&row.schedule_slots?.length?'Forever':row.ends_on||`${row.schedule_slots?.length||0} slots`}</p><p>Next event: {eventLocalTime(row.next_publish_at)}</p><small>{row.status} · {content?.enabled?'Language enabled':'Language disabled'}</small></div></div><div className="te-actions"><button type="button" disabled={busy} onClick={()=>open(row)}>Edit</button>{row.status==='active'&&<button type="button" disabled={busy} onClick={()=>pause(row)}>Pause Event</button>}<button type="button" disabled={busy} onClick={()=>duplicate(row)}>Duplicate</button>{onPostNow&&<button type="button" disabled={busy||!content?.enabled||row.status!=='active'} onClick={()=>onPostNow(row,language)}>Post Now</button>}<button type="button" disabled={busy} onClick={()=>archive(row)}>Archive</button></div></article>})}</div>}
    <div className="te-pagination"><button type="button" disabled={busy||loading||page===1} onClick={()=>setPage(p=>p-1)}>Previous</button><span>Page {page}</span><button type="button" disabled={busy||loading||!more} onClick={()=>setPage(p=>p+1)}>Next</button></div></div>
  </section>
}

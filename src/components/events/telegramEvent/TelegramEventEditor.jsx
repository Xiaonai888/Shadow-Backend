import React,{useEffect,useRef,useState} from 'react'
import ImageDropZone from '../../common/ImageDropZone'
import {eventApi,eventLanguages} from '../../../services/telegramEventAdminApi'
import useTelegramEventImages from './useTelegramEventImages'
const weekdays=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
const today=()=>new Date(Date.now()+7*3600000).toISOString().slice(0,10)
const blank=language=>({language,enabled:false,message:'',image_url:null,image_key:null,button_label:null,button_url:null})
const contentFrom=c=>({language:c.language,enabled:c.enabled,message:c.message||'',image_url:c.image_url||null,image_key:c.image_key||null,button_label:c.button_label||null,button_url:c.button_url||null})
function initial(row,language,audience){return {name:row?.name||'',audience:row?.audience||audience||'reader',schedule_mode:row?.schedule_mode||'weekly',schedule_slots:row?.schedule_slots||[],starts_on:row?.starts_on||'',ends_on:row?.ends_on||'',contents:Object.fromEntries((row?.contents||[blank(language)]).map(c=>[c.language,contentFrom(c)]))}}
export default function TelegramEventEditor({row,language,audience,onBack,onSaved}){
  const [form,setForm]=useState(()=>initial(row,language,audience))
  const [selected,setSelected]=useState(language)
  const [saving,setSaving]=useState(false)
  const [error,setError]=useState('')
  const [preview,setPreview]=useState(false)
  const dirty=useRef(false)
  const busy=useRef(false)
  const input=useRef(null)
  const update=patch=>{dirty.current=true;setForm(old=>({...old,...patch}))}
  const changeContent=(lang,patch)=>{dirty.current=true;setForm(old=>({...old,contents:{...old.contents,[lang]:{...(old.contents[lang]||blank(lang)),...patch}}}))}
  const images=useTelegramEventImages(changeContent)
  const content=form.contents[selected]||blank(selected)
  const job=images.jobs[selected]
  const image=job?.preview||content.image_url
  useEffect(()=>{const warn=e=>{if(dirty.current||busy.current){e.preventDefault();e.returnValue=''}};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn)},[])
  const back=()=>{if(!busy.current&&(!dirty.current||window.confirm('Discard unsaved changes?')))onBack()}
  function pick(file){setError('');try{images.start(selected,file);dirty.current=true}catch(e){setError(e.message)}}
  function addSlot(){const slot=form.schedule_mode==='weekly'?{day:0,time:'08:00'}:{date:today(),time:'08:00'};update({schedule_slots:[...form.schedule_slots,slot],...(form.schedule_mode==='weekly'&&!form.starts_on?{starts_on:today()}: {})})}
  function patchSlot(i,patch){update({schedule_slots:form.schedule_slots.map((s,j)=>i===j?{...s,...patch}:s)})}
  async function save(status){
    if(busy.current||images.blocked)return
    busy.current=true;setSaving(true);setError('')
    try{
      const contents=Object.values(form.contents).map(c=>({...c,button_label:c.button_label?.trim()||null,button_url:c.button_url?.trim()||null}))
      if(!contents.length)contents.push(blank(selected))
      const result=await eventApi.save(row?.id,{name:form.name.trim(),audience:form.audience,status,schedule_mode:form.schedule_mode,schedule_slots:form.schedule_slots,starts_on:form.schedule_mode==='weekly'&&form.schedule_slots.length?form.starts_on||null:null,ends_on:form.schedule_mode==='weekly'&&form.schedule_slots.length?form.ends_on||null:null,contents,...(row?{revision:Number(row.revision)}:{})})
      dirty.current=false;onSaved(result.id)
    }catch(e){setError(e.message)}finally{busy.current=false;setSaving(false)}
  }
  return <section className="te-shell te-editor">
    <header className="te-head"><div><button className="te-back" type="button" onClick={back} disabled={saving}>‹ Back</button><h2>{row?'Edit':'Create'} Telegram Event</h2><p>Shared schedule · Independent language content</p></div></header>
    {error&&<div className="te-error" role="alert">{error}</div>}
    <fieldset disabled={saving} className="te-panel"><legend>General information</legend><div className="te-two"><label>Event name<input value={form.name} maxLength={200} onChange={e=>update({name:e.target.value})}/></label><label>Event type<select value={form.audience} onChange={e=>update({audience:e.target.value})}><option value="reader">Reader</option><option value="author">Author</option></select></label></div></fieldset>
    <fieldset disabled={saving} className="te-panel"><legend>Event content</legend><div className="te-languages">{eventLanguages.map(l=><button key={l.code} type="button" className={`te-language ${selected===l.code?'selected':''}`} onClick={()=>setSelected(l.code)} aria-pressed={selected===l.code}><span className="te-flag">{l.flag}</span><span><strong>{l.name}</strong><small>{images.jobs[l.code]&&images.jobs[l.code].status!=='ready'?'Uploading / pending':form.contents[l.code]?.enabled?'Enabled':form.contents[l.code]?'Draft':'Not set'}</small></span></button>)}</div>
    <label className="te-check"><input type="checkbox" checked={content.enabled} onChange={e=>changeContent(selected,{enabled:e.target.checked})}/> Enable this language</label>
    <ImageDropZone className="te-drop" onFiles={files=>pick(files[0])} disabled={saving} label="Drop event image"><input hidden ref={input} type="file" accept="image/png,image/jpeg,image/webp" onChange={e=>{const f=e.target.files?.[0];e.target.value='';if(f)pick(f)}}/>{image?<img className="te-preview-image" src={image} alt="Event preview"/>:<div className="te-drop-empty"><span>＋</span><strong>Drag & drop an image</strong><small>PNG, JPEG, WEBP · No crop</small></div>}<div className="te-actions"><button type="button" onClick={()=>input.current?.click()}>{image?'Replace image':'Choose image'}</button>{image&&<button type="button" onClick={()=>{images.remove(selected);changeContent(selected,{image_url:null,image_key:null})}}>Remove image</button>}</div></ImageDropZone>
    {job&&<div className="te-progress"><span>{job.name} · {job.status} {job.progress}%</span><progress max="100" value={job.progress}/>{job.status==='error'?<div role="alert">{job.error} <button type="button" onClick={()=>images.retry(selected)}>Retry</button> <button type="button" onClick={()=>images.remove(selected)}>Discard replacement</button></div>:<small>You can continue editing while the image uploads.</small>}</div>}
    <label>Telegram message<textarea rows="6" value={content.message} onChange={e=>changeContent(selected,{message:e.target.value})}/><small>{Array.from(content.message).length} / {image?1000:4000}</small></label>
    <div className="te-two"><label>Button label (optional)<input value={content.button_label||''} maxLength={64} onChange={e=>changeContent(selected,{button_label:e.target.value})}/></label><label>Button HTTPS link<input type="url" value={content.button_url||''} onChange={e=>changeContent(selected,{button_url:e.target.value})}/></label></div>
    </fieldset>
    <fieldset disabled={saving} className="te-panel"><legend>Schedule · Cambodia (UTC+7)</legend><div className="te-actions">{[['dates','Specific dates'],['weekly','Weekly']].map(([v,t])=><button key={v} type="button" aria-pressed={form.schedule_mode===v} className={form.schedule_mode===v?'te-primary':''} onClick={()=>{if(form.schedule_mode!==v&&(!form.schedule_slots.length||window.confirm('Replace current schedule?')))update({schedule_mode:v,schedule_slots:[],starts_on:'',ends_on:''})}}>{t}</button>)}</div>
    {form.schedule_slots.map((slot,i)=><div className="te-slot" key={i}>{form.schedule_mode==='weekly'?<select aria-label="Weekday" value={slot.day} onChange={e=>patchSlot(i,{day:Number(e.target.value)})}>{weekdays.map((day,n)=><option key={n} value={n}>{day}</option>)}</select>:<input aria-label="Publish date" type="date" value={slot.date} onChange={e=>patchSlot(i,{date:e.target.value})}/>}<input aria-label="Publish time" type="time" value={slot.time} onChange={e=>patchSlot(i,{time:e.target.value})}/><button type="button" onClick={()=>update({schedule_slots:form.schedule_slots.filter((_,n)=>n!==i)})}>Remove</button></div>)}
    <button type="button" disabled={form.schedule_slots.length>=100} onClick={addSlot}>+ Add Schedule</button>
    {form.schedule_mode==='weekly'&&<><div className="te-two"><label>Start date<input type="date" value={form.starts_on} onChange={e=>update({starts_on:e.target.value})}/></label><label className="te-check"><input type="checkbox" checked={!form.ends_on} onChange={e=>update({ends_on:e.target.checked?'':form.starts_on||today()})}/> Forever</label></div>{form.ends_on&&<label>End date<input type="date" min={form.starts_on||undefined} value={form.ends_on} onChange={e=>update({ends_on:e.target.value||form.starts_on||today()})}/></label>}</>}
    </fieldset>
    {images.blocked&&<p className="te-note" role="status">Complete or discard pending image uploads before saving.</p>}
    <footer className="te-save"><button type="button" onClick={()=>setPreview(true)}>Preview</button><button type="button" disabled={saving||images.blocked} onClick={()=>save(row?.status==='active'?'paused':'draft')}>{row?.status==='active'?'Save & Pause':'Save Draft'}</button><button type="button" className="te-primary" disabled={saving||images.blocked} onClick={()=>save('active')}>{saving?'Saving…':'Save & Activate'}</button></footer>
    {preview&&<div className="te-overlay" onClick={()=>setPreview(false)}><div className="te-modal" role="dialog" aria-modal="true" aria-label="Telegram preview" onClick={e=>e.stopPropagation()}><header className="te-head"><strong>Telegram Preview · {eventLanguages.find(l=>l.code===selected)?.name}</strong><button type="button" onClick={()=>setPreview(false)}>Close</button></header>{image&&<img className="te-preview-image" src={image} alt="Event preview"/>}<p className="te-message">{content.message}</p>{content.button_label&&<div className="te-preview-button">{content.button_label}</div>}</div></div>}
  </section>
}

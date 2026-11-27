import React,{useEffect,useRef,useState} from 'react'
import {testLocalKnowledge} from '../../services/shadowLocalAiAdminApi'
import {localPanel,localButton,localPrimary,localInput,localMuted} from './ShadowLocalKnowledgeEditor'
export default function ShadowLocalPlayground({aliases,canManage,useDraftInitially=false}) {
  const [task,setTask]=useState('reader_message'),[scenario,setScenario]=useState('empty'),[text,setText]=useState(''),[useDraft,setUseDraft]=useState(useDraftInitially),[result,setResult]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  const current=useRef(null)
  useEffect(()=>()=>{current.current?.abort();current.current=null},[])
  const clear=()=>{setResult(null);setError('')}
  async function run(e){e.preventDefault();if(!canManage||current.current||!text.trim())return
    const ctrl=new AbortController();current.current=ctrl;setBusy(true);clear()
    try{const data=await testLocalKnowledge({task,text,scenario,...(useDraft?{aliases}:{})},ctrl.signal)
      if(!ctrl.signal.aborted){if(data.test_only!==true||data.external_requests!==0||data.order_created!==false||data.payment_created!==false||data.inventory_reserved!==false)throw new Error('Unexpected playground response.');setResult(data)}
    }catch(e){if(!ctrl.signal.aborted)setError(e.message)}finally{if(current.current===ctrl){current.current=null;setBusy(false)}}
  }
  return <section style={{...localPanel,display:'grid',gap:12}}><h3 style={{margin:0}}>Test Playground</h3><p style={localMuted}>Synthetic catalog only: Moon (Normal / Limited), រឿងព្រេង (Normal), J&amp;T, VET. No orders, inventory holds, payments or external AI calls. Use fictional details only.</p>
    {!canManage?<p>Manage permission is required to run a test.</p>:<form onSubmit={run} style={{display:'grid',gap:10}}><fieldset disabled={busy} style={{border:0,padding:0,margin:0,display:'grid',gap:10}}>
      <label>Task<select style={localInput} value={task} onChange={e=>{setTask(e.target.value);setText('');clear()}}><option value="reader_message">Reader booking</option><option value="author_requirements">Author requirements</option></select></label>
      {task==='reader_message'&&<label>Conversation context<select style={localInput} value={scenario} onChange={e=>{setScenario(e.target.value);clear()}}><option value="empty">New conversation</option><option value="book_selected">Moon selected</option><option value="edition_selected">Moon Limited selected</option></select></label>}
      <label><input type="checkbox" checked={useDraft} onChange={e=>{setUseDraft(e.target.checked);clear()}}/> Use current knowledge draft (not published)</label>
      <label>Test text<textarea style={{...localInput,resize:'vertical'}} rows={4} maxLength={task==='reader_message'?2000:300} required value={text} onChange={e=>{setText(e.target.value);clear()}}/></label>
      <button type="button" style={localButton} onClick={()=>{setText(task==='reader_message'?'ចង់កក់ Moon Limited ២ក្បាល':'ត្រូវការ Telegram សម្រាប់ Limited');clear()}}>Use example</button>
      <button type="submit" style={localPrimary} disabled={!text.trim()||busy}>{busy?'Testing…':'Run local test'}</button>
    </fieldset></form>}
    {error&&<p role="alert" style={{color:'#b91c1c'}}>{error}</p>}
    {result&&<div style={{...localPanel,background:'transparent'}}><strong>Local test result</strong><p style={localMuted}>{result.model} · {result.processing_ms} ms · External requests: 0 · {result.dictionary_version}</p><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',fontSize:12,maxHeight:420,overflow:'auto'}}>{JSON.stringify(result.result,null,2)}</pre></div>}
  </section>
}

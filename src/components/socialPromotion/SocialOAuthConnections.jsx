import React,{useEffect,useRef,useState} from 'react'
import {socialOAuthApi as oauth} from '../../services/socialOAuthApi.js'
import {prepareSocialOAuth} from '../../services/socialOAuthSession.js'

const platforms={facebook:'Facebook',instagram:'Instagram',threads:'Threads',tiktok:'TikTok'}
const canConnect=platform=>['facebook','instagram','threads'].includes(platform)
const providerFor=platform=>platform==='threads'?'threads':'facebook'
const statusOf=row=>row.status==='connected'&&row.token_expires_at&&Date.parse(row.token_expires_at)<=Date.now()?'reauth_required':row.status
const symbols={facebook:'f',instagram:'◎',threads:'@'}
function Brand({platform}){
  return <span aria-hidden="true" className={`sp-brand ${platform==='threads'?'tiktok':platform}`}>{platform==='tiktok'?<svg aria-hidden="true" width="23" height="23" viewBox="0 0 24 24" fill="none"><path d="M14 3v12a4.5 4.5 0 1 1-4.5-4.5h1M14 3c.4 4.1 2.8 6 6 6" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"/></svg>:symbols[platform]}</span>
}
export default function SocialOAuthConnections({api,items=[],page=1,hasMore,onPage,onReload,loading,onBusyChange}){
  const [assignments,setAssignments]=useState([]),[assignmentLoading,setAssignmentLoading]=useState(false),[assignmentError,setAssignmentError]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[retry,setRetry]=useState(0)
  const lock=useRef(false)
  const ids=items.map(row=>row.id).join(',')
  useEffect(()=>{
    let active=true;const ctrl=new AbortController();setAssignments([]);setAssignmentError('')
    if(loading||!ids){setAssignmentLoading(false);return()=>ctrl.abort()}
    setAssignmentLoading(true)
    oauth.assignments(ids.split(','),ctrl.signal).then(result=>{if(active){if(!Array.isArray(result.items))throw new Error('SOCIAL_BOT_RESPONSE_INVALID');setAssignments(result.items)}}).catch(e=>{if(active&&!ctrl.signal.aborted)setAssignmentError(e.message)}).finally(()=>{if(active)setAssignmentLoading(false)})
    return()=>{active=false;ctrl.abort()}
  },[ids,loading,retry])
  async function action(fn){
    if(lock.current)return
    lock.current=true;setBusy(true);onBusyChange?.(true);setError('');setNotice('')
    try{await fn()}catch(e){setError(e.message)}finally{lock.current=false;setBusy(false);onBusyChange?.(false)}
  }
  function connect(platform,connectionId=null){
    if(!canConnect(platform))return
    action(async()=>{
      const provider=providerFor(platform),data=await oauth.start(provider,connectionId)
      const url=prepareSocialOAuth({provider,connectionId,authorizationUrl:data.authorizationUrl,origin:window.location.origin,storage:sessionStorage})
      window.location.assign(url)
    })
  }
  function assign(row,bot,assigned){
    if(!assigned&&bot==='promotion'&&!window.confirm('Remove Promotion assignment? Enabled rules will be disabled and queued jobs cancelled. A post already in progress may still finish.'))return
    action(async()=>{
      const result=await oauth.assign(row.id,bot,assigned)
      setAssignments(old=>{const rest=old.filter(x=>x.connectionId!==row.id||x.bot!==bot);return assigned?[...rest,{connectionId:row.id,bot}]:rest})
      setNotice(assigned?'Account assigned. No automatic rule was created.':`Assignment removed. Rules disabled: ${result.disabledRules||0}. Queued jobs cancelled: ${result.cancelledJobs||0}.`)
    })
  }
  function disconnect(row){
    if(!window.confirm(`Disconnect ${row.display_name} locally? Reconnect will be required before posting.`))return
    action(async()=>{await api.revoke(row.id);setNotice('Account disconnected locally.');onReload()})
  }
  return <div className="sp-stack"><section className="sp-panel sp-stack"><h3>Connect social accounts</h3><div className="sp-cards">{Object.entries(platforms).map(([platform,name])=><button key={platform} type="button" className="sp-choice" disabled={busy||!canConnect(platform)} onClick={canConnect(platform)?()=>connect(platform):undefined}><Brand platform={platform}/><strong>{canConnect(platform)?`Connect ${name}`:name}</strong><small>{platform==='tiktok'?'Coming Soon':platform==='instagram'?'Via linked Facebook Page':'OAuth login'}</small></button>)}</div><button type="button" className="sp-primary" disabled={busy} onClick={()=>connect('facebook')}>Sync Facebook & Instagram Accounts</button><p className="sp-muted">Sync opens Meta authorization again and imports permitted Pages and linked professional Instagram accounts. New accounts have no bot assignment. Threads accounts connect separately.</p></section>{error&&<p className="sp-error" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}<section className="sp-panel sp-stack"><div className="sp-heading"><h3>Shared Connections</h3><button type="button" disabled={busy||loading} onClick={onReload}>Refresh</button></div>{assignmentError&&<div className="sp-stack"><p role="alert" className="sp-error">{assignmentError}</p><button type="button" disabled={busy} onClick={()=>setRetry(n=>n+1)}>Retry assignments</button></div>}{!loading&&!items.length&&<p>No accounts yet.</p>}{items.map(row=>{const status=statusOf(row),active=status==='connected';return <div className="sp-record" key={row.id}><div><strong>{row.display_name}</strong><small>{platforms[row.platform]||row.platform} · {row.external_id} · {status.replaceAll('_',' ')}</small><small>{assignmentLoading?'Loading assignments…':assignmentError?'Assignments unavailable':assignments.some(a=>a.connectionId===row.id)?'Assigned':'Standby'}</small><div className="sp-inline">{['promotion','event'].map(bot=><label key={bot} className="sp-inline"><input type="checkbox" checked={assignments.some(a=>a.connectionId===row.id&&a.bot===bot)} disabled={busy||loading||assignmentLoading||Boolean(assignmentError)||(!active&&!assignments.some(a=>a.connectionId===row.id&&a.bot===bot))} onChange={e=>assign(row,bot,e.target.checked)}/>{bot==='promotion'?'Promotion Bot':'Event Bot'}</label>)}</div></div><div className="sp-inline"><button type="button" disabled={busy||loading||!canConnect(row.platform)} onClick={()=>connect(row.platform,row.id)}>Reconnect</button><button type="button" disabled={busy||loading||row.status==='revoked'} onClick={()=>disconnect(row)}>Disconnect</button></div></div>})}<div className="sp-pagination"><button type="button" disabled={busy||loading||page<=1} onClick={()=>onPage(page-1)}>Previous</button><span>Page {page}</span><button type="button" disabled={busy||loading||!hasMore} onClick={()=>onPage(page+1)}>Next</button></div><p className="sp-muted">Event assignment only records permission to use an account; Event publishing is not enabled by this page.</p></section></div>
}

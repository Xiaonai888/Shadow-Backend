import React,{useEffect,useRef,useState} from 'react'
import {loadLocalKnowledge,publishLocalKnowledge,rollbackLocalKnowledge} from '../../services/shadowLocalAiAdminApi'
import ShadowLocalKnowledgeEditor,{localPanel,localButton,localPrimary,localMuted} from './ShadowLocalKnowledgeEditor'
import ShadowLocalPlayground from './ShadowLocalPlayground'
import ShadowLocalKnowledgeHistory from './ShadowLocalKnowledgeHistory'
export default function ShadowLocalAiManagement({canManage=false}) {
  const [snapshot,setSnapshot]=useState(null),[aliases,setAliases]=useState([]),[tab,setTab]=useState('knowledge'),[busy,setBusy]=useState(true),[error,setError]=useState(''),[notice,setNotice]=useState(''),[draftTest,setDraftTest]=useState(false),[confirm,setConfirm]=useState(null),[revision,setRevision]=useState(0)
  const current=useRef(null)
  const dirty=!!snapshot&&JSON.stringify(snapshot.aliases)!==JSON.stringify(aliases)
  function accept(data){if(!Number.isSafeInteger(data?.version)||data.version<1||!Array.isArray(data.aliases)||data.aliases.length>250)throw new Error('Invalid knowledge snapshot.');setSnapshot(data);setAliases(data.aliases)}
  useEffect(()=>{const ctrl=new AbortController();current.current=ctrl;setBusy(true);setError('');loadLocalKnowledge(ctrl.signal).then(data=>{if(!ctrl.signal.aborted)accept(data)}).catch(e=>{if(!ctrl.signal.aborted)setError(e.message)}).finally(()=>{if(current.current===ctrl){current.current=null;setBusy(false)}});return()=>{current.current?.abort();current.current=null}},[revision])
  async function mutate(){if(!confirm||!canManage||current.current||!snapshot)return
    const action=confirm;setConfirm(null);const ctrl=new AbortController();current.current=ctrl;setBusy(true);setError('');setNotice('')
    try{if(action.type==='publish'){if(!dirty)return;await publishLocalKnowledge(snapshot.version,aliases,ctrl.signal)}else{if(dirty)return;await rollbackLocalKnowledge(snapshot.version,action.version,ctrl.signal)}
      const fresh=await loadLocalKnowledge(ctrl.signal);if(!ctrl.signal.aborted){accept(fresh);setNotice('Knowledge updated.');setTab('knowledge')}
    }catch(e){if(!ctrl.signal.aborted)setError(e.code==='SHADOW_AI_KNOWLEDGE_CONFLICT'?'Another admin changed the active version. Preserve your draft separately, then reload before publishing.':e.message)}finally{if(current.current===ctrl){current.current=null;setBusy(false)}}
  }
  return <div style={{display:'grid',gap:12}}><section style={localPanel}><h3 style={{margin:0}}>Shadow Local AI</h3><p style={localMuted}>Local rule-based engine · No external AI API in these tools. Knowledge is shared only after publishing.</p><div style={{display:'flex',gap:8,flexWrap:'wrap'}}>{[['knowledge','Knowledge & Training'],['playground','Test Playground'],['history','Version History']].map(([key,label])=><button key={key} style={tab===key?localPrimary:localButton} disabled={busy||!!confirm||!snapshot} aria-pressed={tab===key} onClick={()=>{setDraftTest(false);setTab(key);setError('')}}>{label}</button>)}<button style={localButton} disabled={busy||dirty||!!confirm} onClick={()=>{setNotice('');setRevision(x=>x+1)}}>Refresh</button></div></section>
    {error&&<div role="alert" style={{...localPanel,color:'#b91c1c'}}>{error}</div>}{notice&&<div role="status" style={localPanel}>{notice}</div>}{busy&&<p role="status">Loading local AI…</p>}
    {confirm&&<section style={localPanel} role="alert"><strong>{confirm.type==='publish'?'Publish the current dictionary draft?':`Restore version ${confirm.version} as a new version?`}</strong><p style={localMuted}>This will change the shared knowledge used by Shadow AI.</p><button style={localPrimary} disabled={busy||!canManage} onClick={mutate}>Confirm</button>{' '}<button style={localButton} disabled={busy} onClick={()=>setConfirm(null)}>Cancel</button></section>}
    {snapshot&&tab==='knowledge'&&<ShadowLocalKnowledgeEditor aliases={aliases} version={snapshot.version} dirty={dirty} canManage={canManage} busy={busy||!!confirm} onChange={setAliases} onReset={()=>{setAliases(snapshot.aliases);setError('')}} onPublish={()=>setConfirm({type:'publish'})} onTest={()=>{setDraftTest(true);setTab('playground')}}/>}
    {snapshot&&tab==='playground'&&<ShadowLocalPlayground aliases={aliases} canManage={canManage} useDraftInitially={draftTest}/>}
    {snapshot&&tab==='history'&&<ShadowLocalKnowledgeHistory version={snapshot.version} canManage={canManage} dirty={dirty} busy={busy||!!confirm} onRollback={version=>setConfirm({type:'rollback',version})}/>}
    {!canManage&&<p style={localMuted}>Read-only access.</p>}
  </div>
}

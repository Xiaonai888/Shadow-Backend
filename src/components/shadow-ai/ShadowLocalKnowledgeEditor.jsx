import React, {useState} from 'react'

export const localPanel={background:'var(--shadow-admin-card,#fff)',border:'1px solid var(--shadow-admin-border,#e2e8f0)',borderRadius:16,padding:16,minWidth:0}
export const localButton={border:'1px solid var(--shadow-admin-border,#e2e8f0)',background:'var(--shadow-admin-card,#fff)',color:'inherit',borderRadius:8,padding:'8px 12px',font:'inherit',cursor:'pointer'}
export const localPrimary={...localButton,background:'#4f46e5',borderColor:'#4f46e5',color:'#fff'}
export const localInput={...localButton,width:'100%',boxSizing:'border-box',cursor:'text'}
export const localMuted={fontSize:12,color:'var(--shadow-admin-muted,#64748b)'}
const groups={fields:['name','phone_number','delivery_address','second_phone','telegram_username','facebook_link','signature_name','english_buyer_name','english_signature_name','detailed_address','buyer_note','delivery_company_key','signature_requested','book','edition','quantity'],editions:['standard','limited'],questions:['books','price','stock','delivery','signature','schedule','requirements']}
const matchKey=v=>v.normalize('NFKC').replace(/[\u200b-\u200d\ufeff]/gu,'').toLowerCase().trim().replace(/\s+/gu,' ')
const aliasValid=v=>v.length>=2&&v.length<=80&&/^\p{L}[\p{L}\p{M} ]*$/u.test(v)
export default function ShadowLocalKnowledgeEditor({aliases,version,dirty,canManage,busy,onChange,onPublish,onReset,onTest}) {
  const [group,setGroup]=useState('questions'),[canonical,setCanonical]=useState('price'),[alias,setAlias]=useState(''),[error,setError]=useState(''),[page,setPage]=useState(0)
  const safePage=Math.min(page,Math.max(0,Math.ceil(aliases.length/20)-1))
  function add(e){e.preventDefault();setError('');const value=matchKey(alias)
    if(!aliasValid(value)){setError('Use 2–80 letters, marks or spaces only. No personal details.');return}
    if(aliases.length>=250){setError('Maximum 250 aliases.');return}
    if(aliases.some(r=>r.group===group&&matchKey(r.alias)===value)){setError('This alias already exists in the selected group.');return}
    onChange([...aliases,{group,alias:value,canonical}]);setAlias('');setPage(Math.floor(aliases.length/20))
  }
  return <section style={{...localPanel,display:'grid',gap:12}}>
    <div><h3 style={{margin:0}}>Knowledge & Dictionary</h3><p style={localMuted}>Active version {version} · {aliases.length}/250 aliases · {dirty?'Unsaved draft':'Published'}.</p><p style={localMuted}>Add only general words or phrases. Never enter names, addresses, contact information or private chat messages. Existing built-in meanings cannot be overridden.</p></div>
    {canManage&&<form onSubmit={add} style={{display:'grid',gap:10}}><fieldset disabled={busy} style={{border:0,margin:0,padding:0,display:'grid',gap:8,gridTemplateColumns:'repeat(auto-fit,minmax(140px,1fr))'}}>
      <label>Group<select style={localInput} value={group} onChange={e=>{setGroup(e.target.value);setCanonical(groups[e.target.value][0])}}>{Object.keys(groups).map(k=><option key={k}>{k}</option>)}</select></label>
      <label>Meaning<select style={localInput} value={canonical} onChange={e=>setCanonical(e.target.value)}>{groups[group].map(k=><option key={k}>{k}</option>)}</select></label>
      <label>New word / phrase<input style={localInput} value={alias} maxLength={80} required onChange={e=>setAlias(e.target.value)}/></label><button style={localButton} type="submit">Add to draft</button>
    </fieldset></form>}
    {error&&<p role="alert" style={{color:'#b91c1c'}}>{error}</p>}
    <div style={{overflowX:'auto'}}><table style={{width:'100%',borderCollapse:'collapse',textAlign:'left',fontSize:13}}><thead><tr><th>Group</th><th>Alias</th><th>Meaning</th>{canManage&&<th>Action</th>}</tr></thead><tbody>{aliases.slice(safePage*20,safePage*20+20).map((row,i)=><tr key={`${row.group}:${row.alias}`}><td>{row.group}</td><td style={{overflowWrap:'anywhere'}}>{row.alias}</td><td>{row.canonical}</td>{canManage&&<td><button style={localButton} disabled={busy} onClick={()=>onChange(aliases.filter((_,index)=>index!==safePage*20+i))}>Remove</button></td>}</tr>)}</tbody></table></div>
    {!aliases.length&&<p style={localMuted}>No custom aliases yet. Built-in dictionary remains available.</p>}
    <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center'}}><button style={localButton} disabled={safePage===0} onClick={()=>setPage(safePage-1)}>Previous</button><span style={localMuted}>Page {safePage+1}</span><button style={localButton} disabled={(safePage+1)*20>=aliases.length} onClick={()=>setPage(safePage+1)}>Next</button></div>
    {canManage&&<div style={{display:'flex',gap:8,flexWrap:'wrap'}}><button style={localButton} disabled={busy} onClick={onTest}>Test draft</button><button style={localButton} disabled={busy||!dirty} onClick={onReset}>Discard draft</button><button style={localPrimary} disabled={busy||!dirty} onClick={onPublish}>Publish knowledge</button></div>}
  </section>
}

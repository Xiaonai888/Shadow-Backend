import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import AdminLayout from '../components/AdminLayout'

const API_URL = import.meta.env.VITE_API_URL || 'https://shadow-backend-kucw.onrender.com'
const token = () => sessionStorage.getItem('shadow_admin_token') || localStorage.getItem('shadow_admin_token') || ''
const num = (v) => Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 0
const fmt = (v) => num(v).toLocaleString()
const data = (mb) => num(mb) >= 1024 ? `${(num(mb)/1024).toFixed(2)} GB` : `${num(mb).toFixed(2)} MB`
const auth = () => ({ credentials:'include', headers:{ Authorization:`Bearer ${token()}` } })

const css=`.pr{display:grid;gap:18px}.top{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}.search,.btn{min-height:34px;border:1px solid #E2E8F0;border-radius:10px;background:#fff}.search{padding:0 11px;min-width:260px}.btn{padding:0 12px;font-weight:900;cursor:pointer}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.card,.block{border:1px solid #E2E8F0;border-radius:18px;background:#fff}.card{padding:16px}.label{color:#64748B;font-size:10px;font-weight:900}.value{margin-top:8px;font-size:27px;font-weight:950}.head{padding:15px 16px;border-bottom:1px solid #EEF2F7;font-weight:950}.list{padding:12px;display:grid;gap:9px}.item{display:grid;grid-template-columns:90px 1fr 1.6fr 110px 110px;gap:10px;align-items:center;padding:12px;border:1px solid #EEF2F7;border-radius:12px;cursor:pointer}.item:hover{background:#FCFAFF;border-color:#DDD6FE}.pill{width:fit-content;padding:5px 8px;border-radius:999px;font-size:8px;font-weight:950;text-transform:uppercase}.high{background:#FEF2F2;color:#B91C1C}.medium{background:#FFF7ED;color:#C2410C}.low{background:#EFF6FF;color:#2563EB}.status{background:#F1F5F9;color:#475569}.err{padding:12px;background:#FEF2F2;color:#B91C1C;border-radius:12px}@media(max-width:900px){.cards{grid-template-columns:repeat(2,1fr)}.list{overflow-x:auto}.item{min-width:760px}}`
export default function AdminSystemProblemReportsPage(){
 const nav=useNavigate(),[items,setItems]=useState([]),[q,setQ]=useState(''),[loading,setLoading]=useState(false),[error,setError]=useState('')
 const load=useCallback(async()=>{try{setLoading(true);const r=await fetch(`${API_URL}/api/admin/system-control/incidents?limit=50`,auth());const j=await r.json();if(!r.ok||!j.ok)throw new Error(j.message||'Failed');setItems(Array.isArray(j.incidents)?j.incidents:[]);setError('')}catch(e){setError(e.message)}finally{setLoading(false)}},[])
 useEffect(()=>{load();const i=setInterval(()=>document.visibilityState==='visible'&&load(),60000);return()=>clearInterval(i)},[load])
 const visible=useMemo(()=>items.filter(x=>!q.trim()||[x.feature,x.source_route,x.dependency,x.status,x.severity].some(v=>String(v||'').toLowerCase().includes(q.toLowerCase()))),[items,q])
 const c=s=>items.filter(x=>String(x.status).toUpperCase()===s).length
 const sev=v=>{const s=String(v||'').toLowerCase();return s==='critical'||s==='high'?'high':s==='medium'?'medium':'low'}
 return <AdminLayout title="Problem Reports" subtitle="System Control incidents and abnormal-event archive."><style>{css}</style><div className="pr">
  <div className="top"><input className="search" value={q} onChange={e=>setQ(e.target.value)} placeholder="Search feature, route, dependency…"/><button className="btn" onClick={load} disabled={loading}>{loading?'Refreshing…':'Refresh'}</button></div>
  {error&&<div className="err">{error}</div>}
  <div className="cards"><div className="card"><div className="label">All</div><div className="value">{items.length}</div></div><div className="card"><div className="label">Open</div><div className="value">{c('OPEN')}</div></div><div className="card"><div className="label">Investigating</div><div className="value">{c('INVESTIGATING')}</div></div><div className="card"><div className="label">Resolved</div><div className="value">{c('RESOLVED')}</div></div></div>
  <section className="block"><div className="head">Incident Archive</div><div className="list">{visible.map(x=><div className="item" key={x.id} onClick={()=>nav(`/alerts/system-control/problems/${x.id}`)}><span className={`pill ${sev(x.severity)}`}>{x.severity||'info'}</span><strong>{x.feature||'unknown'}</strong><span>{x.source_route||'UNKNOWN'}</span><span>{x.dependency||'UNKNOWN'}</span><span className="pill status">{x.status||'OPEN'}</span></div>)}{!visible.length&&<div className="label">No matching reports.</div>}</div></section>
 </div></AdminLayout>
}

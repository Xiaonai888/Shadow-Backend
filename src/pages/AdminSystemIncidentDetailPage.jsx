import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import AdminLayout from '../components/AdminLayout'

const API_URL = import.meta.env.VITE_API_URL || 'https://shadow-backend-kucw.onrender.com'
const token = () => sessionStorage.getItem('shadow_admin_token') || localStorage.getItem('shadow_admin_token') || ''
const num = (v) => Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 0
const fmt = (v) => num(v).toLocaleString()
const data = (mb) => num(mb) >= 1024 ? `${(num(mb)/1024).toFixed(2)} GB` : `${num(mb).toFixed(2)} MB`
const auth = () => ({ credentials:'include', headers:{ Authorization:`Bearer ${token()}` } })

const css=`.id{display:grid;gap:18px}.top{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}.btn{min-height:34px;padding:0 12px;border:1px solid #E2E8F0;border-radius:10px;background:#fff;font-weight:900;cursor:pointer}.hero,.block{border:1px solid #E2E8F0;border-radius:18px;background:#fff}.hero{padding:18px}.kicker{color:#94A3B8;font-size:9px;font-weight:950}.title{margin-top:6px;font-size:24px;font-weight:950}.sub{margin-top:6px;color:#64748B;font-size:10px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.head{padding:15px 16px;border-bottom:1px solid #EEF2F7;font-weight:950}.body{padding:14px}.kv{display:grid;grid-template-columns:150px 1fr;gap:10px;padding:10px 0;border-bottom:1px solid #F1F5F9}.key{color:#94A3B8;font-size:9px;font-weight:900}.val{color:#334155;font-size:9px;font-weight:850;word-break:break-word}.code{max-height:360px;overflow:auto;padding:14px;border-radius:12px;background:#0F172A;color:#E2E8F0;font-size:10px;white-space:pre-wrap}.err{padding:12px;background:#FEF2F2;color:#B91C1C;border-radius:12px}@media(max-width:850px){.grid{grid-template-columns:1fr}}`
export default function AdminSystemIncidentDetailPage(){
 const {incidentId}=useParams(),nav=useNavigate(),[item,setItem]=useState(null),[loading,setLoading]=useState(false),[error,setError]=useState('')
 const load=useCallback(async()=>{try{setLoading(true);const r=await fetch(`${API_URL}/api/admin/system-control/incidents?limit=50`,auth());const j=await r.json();if(!r.ok||!j.ok)throw new Error(j.message||'Failed');const x=(Array.isArray(j.incidents)?j.incidents:[]).find(v=>String(v.id)===String(incidentId));if(!x)throw new Error('Incident not found.');setItem(x);setError('')}catch(e){setError(e.message)}finally{setLoading(false)}},[incidentId])
 useEffect(()=>{load()},[load])
 const e=item?.evidence||{},raw=useMemo(()=>item?JSON.stringify(item,null,2):'',[item])
 return <AdminLayout title="Incident Detail" subtitle="Root cause, baseline, protection and evidence."><style>{css}</style><div className="id">
  <div className="top"><button className="btn" onClick={()=>nav('/alerts/system-control/problems')}>← Problem Reports</button><div><button className="btn" onClick={load} disabled={loading}>{loading?'Refreshing…':'Refresh'}</button> <button className="btn" onClick={()=>navigator.clipboard?.writeText(raw)} disabled={!item}>Copy Evidence</button></div></div>
  {error&&<div className="err">{error}</div>}
  {item&&<><section className="hero"><div className="kicker">Incident #{item.id}</div><div className="title">{item.feature||'Unknown Feature'}</div><div className="sub">{item.source_route||'UNKNOWN'} · {item.dependency||'UNKNOWN'} · {item.status||'OPEN'} · {item.severity||'info'}</div></section>
  <div className="grid"><section className="block"><div className="head">Root Cause</div><div className="body"><div className="kv"><div className="key">Classification</div><div className="val">{e.classification||'—'}</div></div><div className="kv"><div className="key">Signals</div><div className="val">{Array.isArray(e.signals)?e.signals.join(', ').replaceAll('_',' '):'—'}</div></div><div className="kv"><div className="key">Top Driver</div><div className="val">{e?.top_driver?.source_route||item.source_route||'—'}</div></div></div></section>
  <section className="block"><div className="head">History</div><div className="body"><div className="kv"><div className="key">First Seen</div><div className="val">{item.first_seen_at?new Date(item.first_seen_at).toLocaleString():'—'}</div></div><div className="kv"><div className="key">Last Seen</div><div className="val">{item.last_seen_at?new Date(item.last_seen_at).toLocaleString():'—'}</div></div><div className="kv"><div className="key">Recurrence</div><div className="val">{item.recurrence_count??0}</div></div></div></section></div>
  <section className="block"><div className="head">Protection</div><div className="body"><div className="kv"><div className="key">Status</div><div className="val">{e?.protection?.status||'inactive'}</div></div><div className="kv"><div className="key">Type</div><div className="val">{e?.protection?.kind||'—'}</div></div><div className="kv"><div className="key">Target</div><div className="val">{e?.protection?.method||'—'} {e?.protection?.path||''}</div></div><div className="kv"><div className="key">Reason</div><div className="val">{e?.protection?.plan?.reason||'—'}</div></div></div></section>
  <section className="block"><div className="head">Evidence Archive Copy</div><div className="body"><pre className="code">{raw}</pre></div></section></>}
 </div></AdminLayout>
}

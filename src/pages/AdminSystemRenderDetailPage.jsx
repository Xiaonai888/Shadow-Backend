import React, { useCallback, useEffect, useMemo, useState } from 'react'
import AdminLayout from '../components/AdminLayout'

const API_URL = import.meta.env.VITE_API_URL || 'https://shadow-backend-kucw.onrender.com'
const token = () => sessionStorage.getItem('shadow_admin_token') || localStorage.getItem('shadow_admin_token') || ''
const num = (v) => Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 0
const fmt = (v) => num(v).toLocaleString()
const data = (mb) => num(mb) >= 1024 ? `${(num(mb)/1024).toFixed(2)} GB` : `${num(mb).toFixed(2)} MB`
const auth = () => ({ credentials:'include', headers:{ Authorization:`Bearer ${token()}` } })

const css=`.scx{display:grid;gap:18px}.cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.card,.block{border:1px solid #E2E8F0;border-radius:18px;background:#fff}.card{padding:16px}.label{color:#64748B;font-size:10px;font-weight:900}.value{margin-top:8px;font-size:27px;font-weight:950;color:#0F172A}.note{margin-top:6px;color:#94A3B8;font-size:9px;font-weight:800}.head{padding:15px 16px;border-bottom:1px solid #EEF2F7;font-weight:950}.rows{padding:12px;display:grid;gap:9px}.row{padding:11px 12px;border:1px solid #EEF2F7;border-radius:12px;display:flex;justify-content:space-between;gap:12px;font-size:10px;font-weight:850}.btn{min-height:34px;padding:0 12px;border:1px solid #E2E8F0;border-radius:10px;background:#fff;font-weight:900;cursor:pointer}.top{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}.err{padding:12px;background:#FEF2F2;color:#B91C1C;border-radius:12px}@media(max-width:900px){.cards{grid-template-columns:repeat(2,1fr)}}@media(max-width:600px){.cards{grid-template-columns:1fr}}`
export default function AdminSystemRenderDetailPage(){
 const [usage,setUsage]=useState(null),[loading,setLoading]=useState(false),[error,setError]=useState('')
 const load=useCallback(async()=>{try{setLoading(true);const r=await fetch(`${API_URL}/api/admin/system-control/snapshot`,auth());const j=await r.json();if(!r.ok||!j.ok)throw new Error(j.message||'Failed');setUsage(j.usage||null);setError('')}catch(e){setError(e.message)}finally{setLoading(false)}},[])
 useEffect(()=>{load();const i=setInterval(()=>document.visibilityState==='visible'&&load(),30000);return()=>clearInterval(i)},[load])
 const rows=useMemo(()=>Array.isArray(usage?.minute?.rows)?usage.minute.rows:[],[usage])
 const http=rows.filter(x=>x.kind==='http_response'),out=rows.filter(x=>x.kind==='external_request')
 const routes=useMemo(()=>{const m=new Map();for(const r of rows){const k=r.source_route||'UNKNOWN',x=m.get(k)||{key:k,count:0,mb:0,errors:0};x.count+=num(r.count);x.mb+=num(r.mb);x.errors+=num(r.errors);m.set(k,x)}return[...m.values()].sort((a,b)=>b.mb-a.mb).slice(0,12)},[rows])
 return <AdminLayout title="Render Detail" subtitle="Measured Render-related backend traffic."><style>{css}</style><div className="scx">
  <div className="top"><strong>Render Traffic</strong><button className="btn" onClick={load} disabled={loading}>{loading?'Refreshing…':'Refresh'}</button></div>
  {error&&<div className="err">{error}</div>}
  <div className="cards"><div className="card"><div className="label">Total Traffic</div><div className="value">{data(usage?.minute?.mb)}</div><div className="note">Current minute</div></div><div className="card"><div className="label">HTTP Responses</div><div className="value">{data(http.reduce((s,x)=>s+num(x.mb),0))}</div></div><div className="card"><div className="label">Service-Initiated</div><div className="value">{data(out.reduce((s,x)=>s+num(x.mb),0))}</div></div><div className="card"><div className="label">Requests</div><div className="value">{fmt(usage?.minute?.count)}</div><div className="note">{fmt(usage?.minute?.errors)} errors</div></div></div>
  <section className="block"><div className="head">Top Routes</div><div className="rows">{routes.map(x=><div className="row" key={x.key}><span>{x.key}</span><span>{data(x.mb)} · {fmt(x.count)} req</span></div>)}{!routes.length&&<div className="note">Waiting for traffic.</div>}</div></section>
 </div></AdminLayout>
}

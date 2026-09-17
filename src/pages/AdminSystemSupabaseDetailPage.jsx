import React, { useCallback, useEffect, useMemo, useState } from 'react'
import AdminLayout from '../components/AdminLayout'

const API_URL = import.meta.env.VITE_API_URL || 'https://shadow-backend-kucw.onrender.com'
const token = () => sessionStorage.getItem('shadow_admin_token') || localStorage.getItem('shadow_admin_token') || ''
const num = (v) => Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 0
const fmt = (v) => num(v).toLocaleString()
const data = (mb) => num(mb) >= 1024 ? `${(num(mb)/1024).toFixed(2)} GB` : `${num(mb).toFixed(2)} MB`
const auth = () => ({ credentials:'include', headers:{ Authorization:`Bearer ${token()}` } })

const css=`.scx{display:grid;gap:18px}.cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.card,.block{border:1px solid #E2E8F0;border-radius:18px;background:#fff}.card{padding:16px}.label{color:#64748B;font-size:10px;font-weight:900}.value{margin-top:8px;font-size:27px;font-weight:950;color:#0F172A}.head{padding:15px 16px;border-bottom:1px solid #EEF2F7;font-weight:950}.rows{padding:12px;display:grid;gap:9px}.row{padding:11px 12px;border:1px solid #EEF2F7;border-radius:12px;display:flex;justify-content:space-between;gap:12px;font-size:10px;font-weight:850}.btn{min-height:34px;padding:0 12px;border:1px solid #E2E8F0;border-radius:10px;background:#fff;font-weight:900;cursor:pointer}.top{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}.err{padding:12px;background:#FEF2F2;color:#B91C1C;border-radius:12px}@media(max-width:900px){.cards{grid-template-columns:repeat(2,1fr)}}@media(max-width:600px){.cards{grid-template-columns:1fr}}`
export default function AdminSystemSupabaseDetailPage(){
 const [usage,setUsage]=useState(null),[loading,setLoading]=useState(false),[error,setError]=useState('')
 const load=useCallback(async()=>{try{setLoading(true);const r=await fetch(`${API_URL}/api/admin/system-control/snapshot`,auth());const j=await r.json();if(!r.ok||!j.ok)throw new Error(j.message||'Failed');setUsage(j.usage||null);setError('')}catch(e){setError(e.message)}finally{setLoading(false)}},[])
 useEffect(()=>{load();const i=setInterval(()=>document.visibilityState==='visible'&&load(),30000);return()=>clearInterval(i)},[load])
 const rows=useMemo(()=>Array.isArray(usage?.minute?.rows)?usage.minute.rows.filter(x=>String(x.dependency).toUpperCase()==='SUPABASE'):[],[usage])
 const calls=rows.reduce((s,x)=>s+num(x.count),0),mb=rows.reduce((s,x)=>s+num(x.mb),0),errors=rows.reduce((s,x)=>s+num(x.errors),0)
 const groups=useMemo(()=>{const m=new Map();for(const r of rows){const k=r.feature||'unknown',x=m.get(k)||{key:k,count:0,mb:0,errors:0};x.count+=num(r.count);x.mb+=num(r.mb);x.errors+=num(r.errors);m.set(k,x)}return[...m.values()].sort((a,b)=>b.count-a.count).slice(0,12)},[rows])
 return <AdminLayout title="Supabase Detail" subtitle="Measured Supabase activity by Shadow feature."><style>{css}</style><div className="scx">
  <div className="top"><strong>Supabase Activity</strong><button className="btn" onClick={load} disabled={loading}>{loading?'Refreshing…':'Refresh'}</button></div>
  {error&&<div className="err">{error}</div>}
  <div className="cards"><div className="card"><div className="label">Calls</div><div className="value">{fmt(calls)}</div></div><div className="card"><div className="label">Data</div><div className="value">{data(mb)}</div></div><div className="card"><div className="label">Errors</div><div className="value">{fmt(errors)}</div></div><div className="card"><div className="label">Error Rate</div><div className="value">{calls?`${((errors/calls)*100).toFixed(2)}%`:'0%'}</div></div></div>
  <section className="block"><div className="head">Calls by Feature</div><div className="rows">{groups.map(x=><div className="row" key={x.key}><span>{x.key}</span><span>{fmt(x.count)} calls · {data(x.mb)} · {fmt(x.errors)} errors</span></div>)}{!groups.length&&<div className="label">Waiting for Supabase traffic.</div>}</div></section>
 </div></AdminLayout>
}

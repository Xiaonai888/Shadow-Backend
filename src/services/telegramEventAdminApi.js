const base=(import.meta.env.VITE_API_URL || 'https://shadow-backend-kucw.onrender.com').replace(/\/+$/,'')
const root='/api/admin/telegram-events'
export const eventLanguages=[{code:'km',short:'KH',name:'Khmer',flag:'🇰🇭'},{code:'en',short:'US',name:'English',flag:'🇺🇸'},{code:'zh',short:'CN',name:'Chinese',flag:'🇨🇳'},{code:'ja',short:'JP',name:'Japanese',flag:'🇯🇵'},{code:'ko',short:'KR',name:'Korean',flag:'🇰🇷'}]
export async function eventRequest(path,{method='GET',body,signal}={}) {
  const token=sessionStorage.getItem('shadow_admin_token')||localStorage.getItem('shadow_admin_token')||''
  if(!token) throw new Error('Please sign in as an Admin')
  const response=await fetch(`${base}${path}`,{method,headers:{Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal,cache:'no-store'})
  const data=await response.json().catch(()=>({}))
  if(!response.ok||data.ok===false) throw Object.assign(new Error(data.message||`Request failed (${response.status})`),{status:response.status,code:data.code})
  return data
}
const query=values=>new URLSearchParams(Object.entries(values).filter(([,v])=>v!==undefined&&v!==null)).toString()
export const eventApi={
  list:(filters,signal)=>eventRequest(`${root}?${query(filters)}`,{signal}),
  detail:(id,signal)=>eventRequest(`${root}/${encodeURIComponent(id)}`,{signal}),
  save:(id,body)=>eventRequest(id?`${root}/${encodeURIComponent(id)}`:root,{method:id?'PUT':'POST',body}),
  duplicate:(id,revision)=>eventRequest(`${root}/${encodeURIComponent(id)}/duplicate`,{method:'POST',body:{revision}}),
  archive:(id,revision)=>eventRequest(`${root}/${encodeURIComponent(id)}/archive`,{method:'POST',body:{revision}}),
  channels:signal=>eventRequest(`${root}/channels`,{signal}),
  updateChannel:(language,body)=>eventRequest(`${root}/channels/${encodeURIComponent(language)}`,{method:'PATCH',body}),
  history:(filters,signal)=>eventRequest(`${root}/history?${query(filters)}`,{signal})
}
export function eventLocalTime(value){
  if(!value)return '—'
  const d=new Date(value)
  return Number.isFinite(+d)?new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Phnom_Penh',dateStyle:'medium',timeStyle:'short'}).format(d):'—'
}

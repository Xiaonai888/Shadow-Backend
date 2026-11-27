const base=(import.meta.env.VITE_API_URL||'https://shadow-backend-kucw.onrender.com').replace(/\/+$/,'')
const root='/api/admin/social-promotion'
const token=()=>sessionStorage.getItem('shadow_admin_token')||localStorage.getItem('shadow_admin_token')||''
async function request(path,{method='GET',body,signal}={}){
  const session=token()
  if(!session)throw new Error('Admin session is missing. Sign in again.')
  const response=await fetch(`${base}${path}`,{method,signal,credentials:'include',cache:'no-store',headers:{Authorization:`Bearer ${session}`,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})})
  const data=await response.json().catch(()=>null)
  if(token()!==session)throw new Error('Admin session changed. Reload this page.')
  if(!response.ok||data?.ok!==true)throw new Error(data?.code||`Request failed (${response.status})`)
  return data
}
const query=(path,params)=>`${path}?${new URLSearchParams(Object.entries(params).filter(([,v])=>v!==''&&v!=null))}`
const id=value=>encodeURIComponent(value)
export const socialPromotionApi={
  connections:(params,signal)=>request(query(`${root}/connections`,params),{signal}),
  connect:body=>request(`${root}/connections`,{method:'POST',body}),
  revoke:value=>request(`${root}/connections/${id(value)}/revoke`,{method:'POST'}),
  rules:(params,signal)=>request(query(`${root}/rules`,params),{signal}),
  createRule:body=>request(`${root}/rules`,{method:'POST',body}),
  replaceRule:(value,rule,revision)=>request(`${root}/rules/${id(value)}`,{method:'PUT',body:{rule,revision}}),
  jobs:(params,signal)=>request(query(`${root}/jobs`,params),{signal}),
  cancel:value=>request(`${root}/jobs/${id(value)}/cancel`,{method:'POST'}),
  search:(q,page,signal)=>request(query('/api/admin/stories/picker',{q,page,limit:10}),{signal})
}

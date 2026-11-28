const base=(import.meta.env.VITE_API_URL||'https://shadow-backend-kucw.onrender.com').replace(/\/+$/,'')
const root='/api/admin/social-oauth'
const session=()=>sessionStorage.getItem('shadow_admin_token')||localStorage.getItem('shadow_admin_token')||''
const providerPath=provider=>{if(provider==='facebook')return root;if(provider==='threads')return root+'/threads';throw new Error('SOCIAL_OAUTH_PROVIDER_INVALID')}
async function request(path,body,{method='POST',signal}={}){
  const token=session()
  if(!token)throw new Error('Admin session is missing. Sign in again.')
  const response=await fetch(base+path,{method,signal,credentials:'include',cache:'no-store',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)})
  const data=await response.json().catch(()=>null)
  if(session()!==token)throw new Error('Admin session changed. Connect again.')
  if(!response.ok||data?.ok!==true)throw new Error(typeof data?.code==='string'&&/^SOCIAL_[A-Z0-9_]{1,90}$/.test(data.code)?data.code:`Request failed (${response.status})`)
  return data
}
export const socialOAuthApi={
  start:(provider,connectionId=null)=>request(providerPath(provider)+'/start',{connectionId}),
  complete:(provider,body)=>request(providerPath(provider)+'/complete',body),
  assignments:(connectionIds,signal)=>request(root+'/assignments/list',{connectionIds},{signal}),
  assign:(connectionId,bot,assigned)=>request(root+'/assignments/'+encodeURIComponent(connectionId),{bot,assigned},{method:'PUT'})
}

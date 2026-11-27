const API_URL = import.meta.env.VITE_API_URL || 'https://shadow-backend-kucw.onrender.com'
const ROOT = `${API_URL.replace(/\/+$/,'')}/api/admin/shadow-ai/local`
const token = () => sessionStorage.getItem('shadow_admin_token') || localStorage.getItem('shadow_admin_token') || ''
async function request(path,{method='GET',body,signal}={}) {
  const initial=token()
  if(!initial) throw new Error('Admin session is missing. Sign in again.')
  const response=await fetch(`${ROOT}${path}`,{method,signal,credentials:'include',cache:'no-store',headers:{Authorization:`Bearer ${initial}`,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})})
  const data=await response.json().catch(()=>null)
  if(token()!==initial) throw new Error('Admin session changed. Refresh the page.')
  if(!response.ok||data?.ok!==true) throw Object.assign(new Error(String(data?.message||`Local AI request failed (${response.status})`).slice(0,300)),{code:data?.code,status:response.status})
  return data
}
const version=v=>{if(!Number.isSafeInteger(v)||v<1||v>2147483647) throw new Error('Invalid version.');return v}
export const loadLocalKnowledge=signal=>request('/knowledge',{signal})
export const loadLocalKnowledgeVersion=(v,signal)=>request(`/knowledge/versions/${version(v)}`,{signal})
export const loadLocalKnowledgeHistory=(before,signal)=>request(`/knowledge/history?limit=20${before==null?'':`&before=${version(before)}`}`,{signal})
export const publishLocalKnowledge=(expected_version,aliases,signal)=>request('/knowledge',{method:'PUT',body:{expected_version:version(expected_version),aliases},signal})
export const rollbackLocalKnowledge=(expected_version,source_version,signal)=>request('/knowledge/rollback',{method:'POST',body:{expected_version:version(expected_version),source_version:version(source_version)},signal})
export const testLocalKnowledge=(input,signal)=>request('/playground',{method:'POST',body:input,signal})

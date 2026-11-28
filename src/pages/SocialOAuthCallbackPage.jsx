import React,{useEffect,useRef,useState} from 'react'
import {useLocation,useNavigate} from 'react-router-dom'
import AdminLayout from '../components/AdminLayout'
import {socialOAuthApi as oauth} from '../services/socialOAuthApi.js'
import {consumeSocialOAuth,oauthCallbackPath} from '../services/socialOAuthSession.js'
import '../components/socialPromotion/socialPromotion.css'

function hasFullAdmin(){try{return JSON.parse(sessionStorage.getItem('shadow_admin_user')||localStorage.getItem('shadow_admin_user')||'{}')?.has_all_permissions===true}catch{return false}}
export default function SocialOAuthCallbackPage(){
  const location=useLocation(),navigate=useNavigate(),task=useRef(null)
  const [result,setResult]=useState(null),[error,setError]=useState('')
  useEffect(()=>{
    let active=true
    if(!task.current){
      task.current=(async()=>{
        const provider=location.pathname===oauthCallbackPath('threads')?'threads':'facebook'
        const search=window.location.search
        window.history.replaceState(window.history.state,'',window.location.pathname)
        if(!hasFullAdmin())throw new Error('SOCIAL_ADMIN_PERMISSION_REQUIRED')
        if(location.pathname!==oauthCallbackPath(provider))throw new Error('SOCIAL_OAUTH_REDIRECT_INVALID')
        const body=consumeSocialOAuth({provider,search,storage:sessionStorage})
        return oauth.complete(provider,body)
      })()
    }
    task.current.then(data=>{if(active)setResult(data)}).catch(e=>{if(active)setError(e.message)})
    return()=>{active=false}
  },[location.pathname])
  return <AdminLayout title="Social Media Connection" subtitle="Secure OAuth"><section className="sp-root sp-panel sp-stack">{error?<><h3>Connection not completed</h3><p role="alert" className="sp-error">{error}</p><p>Return to Social Promotion and start the connection again.</p></>:result?<><h3>Connection completed</h3><p role="status">Saved: {result.saved||0} · Skipped: {result.skipped||0}</p>{result.facebookFound!==undefined&&<p>Facebook: {result.facebookFound} · Instagram: {result.instagramFound}</p>}{result.threadsFound!==undefined&&<p>Threads: {result.threadsFound}</p>}{Boolean(result.disabledRules||result.cancelledJobs)&&<p>Rules disabled: {result.disabledRules||0} · Jobs cancelled: {result.cancelledJobs||0}. Review before enabling posting.</p>}{Boolean(result.skipped)&&<p>Previously disconnected or expired accounts may require individual Reconnect.</p>}</>:<p role="status">Completing connection…</p>}{(result||error)&&<button type="button" className="sp-primary" onClick={()=>navigate('/social-promotion?tab=connections',{replace:true})}>Back to Connections</button>}</section></AdminLayout>
}

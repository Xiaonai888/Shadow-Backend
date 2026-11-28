import {SocialOAuthError} from './socialOAuthState.service.js'

const publishTasks=new Set(['CREATE_CONTENT','MANAGE','PROFILE_PLUS_CREATE_CONTENT','PROFILE_PLUS_FULL_CONTROL','PROFILE_PLUS_MANAGE'])
function assertContext(context){
  if(context?.provider!=='facebook'||typeof context.actorId!=='string'||!context.actorId||context.actorId.length>128||typeof context.sessionBinding!=='string'||!context.sessionBinding||context.sessionBinding.length>16384)throw new SocialOAuthError('SOCIAL_OAUTH_IDENTITY_INVALID')
}
function validToken(x){return typeof x?.token==='string'&&x.token.length>0&&x.token.length<=16384&&!/\s/.test(x.token)&&Number.isSafeInteger(x.expiresIn)&&x.expiresIn>0&&x.expiresIn<=31536000}
export function createSocialOAuthAdmin({stateStore,facebook,grantedPermissions,accountStore,clock=Date.now}={}){
  if(![stateStore?.issue,stateStore?.consume,facebook?.authorizationUrl,facebook?.exchangeCode,facebook?.extendUserToken,facebook?.accountPage,grantedPermissions,accountStore?.importAdmin,clock].every(fn=>typeof fn==='function'))throw new TypeError('SOCIAL_OAUTH_ADMIN_DEPENDENCIES')
  return {
    async start(context){
      assertContext(context)
      const state=await stateStore.issue(context)
      return {authorizationUrl:facebook.authorizationUrl(state)}
    },
    async complete(context,{state,code}={}){
      assertContext(context)
      if(typeof code!=='string'||!code||code.length>8192||/\s/.test(code))throw new SocialOAuthError('SOCIAL_OAUTH_CODE_INVALID')
      await stateStore.consume(context,state)
      const initial=await facebook.exchangeCode(code)
      if(!validToken(initial))throw new SocialOAuthError('SOCIAL_OAUTH_TOKEN_RESPONSE_INVALID',502)
      const extended=await facebook.extendUserToken(initial.token)
      if(!validToken(extended))throw new SocialOAuthError('SOCIAL_OAUTH_TOKEN_RESPONSE_INVALID',502)
      const now=clock()
      if(!Number.isFinite(now))throw new SocialOAuthError('SOCIAL_OAUTH_CLOCK_INVALID',503)
      const expiresAt=new Date(now+extended.expiresIn*1000).toISOString()
      const grants=await grantedPermissions(extended.token)
      if(typeof grants?.facebook!=='boolean'||typeof grants?.instagram!=='boolean')throw new SocialOAuthError('SOCIAL_OAUTH_GRANTS_INVALID',502)
      if(!grants.facebook&&!grants.instagram)throw new SocialOAuthError('SOCIAL_OAUTH_PUBLISH_PERMISSIONS_REQUIRED',403)
      const accounts=new Map(),pages=new Set(),cursors=new Set()
      let after=null,skippedPages=0,facebookCount=0,instagramCount=0
      function add(account){
        const key=`${account.platform}:${account.externalId}`
        if(accounts.has(key))throw new SocialOAuthError('SOCIAL_OAUTH_ACCOUNT_DUPLICATE',502)
        accounts.set(key,account)
      }
      for(let i=0;i<4;i++){
        const result=await facebook.accountPage(extended.token,after)
        if(!Array.isArray(result?.pages)||result.pages.length>25||result.after!==null&&(typeof result.after!=='string'||!result.after||cursors.has(result.after)))throw new SocialOAuthError('SOCIAL_OAUTH_ACCOUNT_RESPONSE_INVALID',502)
        for(const page of result.pages){
          if(pages.has(page.pageId))throw new SocialOAuthError('SOCIAL_OAUTH_ACCOUNT_DUPLICATE',502)
          pages.add(page.pageId)
          if(!Array.isArray(page.tasks)||!page.tasks.some(task=>publishTasks.has(task))){skippedPages++;continue}
          if(grants.facebook){add({platform:'facebook',externalId:page.pageId,displayName:page.displayName,token:page.pageToken,expiresAt:null});facebookCount++}
          if(grants.instagram&&page.instagram){add({platform:'instagram',externalId:page.instagram.id,displayName:page.instagram.username,token:extended.token,expiresAt});instagramCount++}
        }
        after=result.after
        if(after===null)break
        cursors.add(after)
      }
      if(after!==null)throw new SocialOAuthError('SOCIAL_OAUTH_ACCOUNT_LIMIT',422)
      const {saved,skipped}=await accountStore.importAdmin([...accounts.values()])
      return {pagesFound:pages.size,facebookFound:facebookCount,instagramFound:instagramCount,skippedPages,saved,skipped}
    }
  }
}

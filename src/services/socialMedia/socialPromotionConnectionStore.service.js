import { normalizeSocialId } from './socialPromotionRules.service.js'

export const connectionFields='id,platform,external_id,display_name,status,token_expires_at,created_at,updated_at'
const metaId=v=>typeof v==='string'&&/^\d{1,40}$/.test(v)
export class SocialAdminError extends Error {
  constructor(code,status=400){super(code);this.code=code;this.status=status}
}
export function safeConnection(row){
  if(!row)return null
  return Object.fromEntries(connectionFields.split(',').map(k=>[k,row[k]]))
}
export function createSocialPromotionConnectionStore({db,verifyFacebook,verifyInstagram,encryptToken,clock=Date.now}){
  if(!db?.from||![verifyFacebook,verifyInstagram,encryptToken,clock].every(fn=>typeof fn==='function'))throw new TypeError('SOCIAL_CONNECTION_DEPENDENCIES')
  const table=()=>db.from('social_media_connections')
  const scope=q=>q.eq('owner_type','admin').eq('owner_id','shadow')
  return {
    async connect(input={}){
      const {platform,pageId,instagramId,token,expiresAt=null}=input
      const now=clock()
      if(!['facebook','instagram'].includes(platform)||!metaId(pageId)||(platform==='instagram'&&!metaId(instagramId))||typeof token!=='string'||!token||token.length>16384||/\s/.test(token)||!Number.isFinite(now)||(expiresAt!==null&&(typeof expiresAt!=='string'||!Number.isFinite(Date.parse(expiresAt))||Date.parse(expiresAt)<=now)))throw new SocialAdminError('SOCIAL_CONNECTION_INPUT_INVALID')
      const externalId=platform==='facebook'?pageId:instagramId
      let verified
      try{verified=platform==='facebook'?await verifyFacebook({pageId,pageToken:token}):await verifyInstagram({pageId,instagramId,userToken:token})}catch{throw new SocialAdminError('SOCIAL_CONNECTION_VERIFICATION_FAILED',422)}
      if(verified?.platform!==platform||verified.externalId!==externalId||(platform==='instagram'&&verified.linkedPageId!==pageId)||typeof verified.displayName!=='string'||!verified.displayName.trim()||verified.displayName.length>300)throw new SocialAdminError('SOCIAL_CONNECTION_IDENTITY_MISMATCH',422)
      let ciphertext
      try{ciphertext=encryptToken(token,{ownerType:'admin',ownerId:'shadow',platform,externalId})}catch{throw new SocialAdminError('SOCIAL_CONNECTION_VAULT_UNAVAILABLE',503)}
      if(typeof ciphertext!=='string'||!ciphertext||ciphertext===token)throw new SocialAdminError('SOCIAL_CONNECTION_VAULT_UNAVAILABLE',503)
      const row={owner_type:'admin',owner_id:'shadow',platform,external_id:externalId,display_name:verified.displayName.trim(),token_ciphertext:ciphertext,token_expires_at:expiresAt===null?null:new Date(expiresAt).toISOString(),status:'connected',updated_at:new Date(now).toISOString()}
      const {data,error}=await table().upsert(row,{onConflict:'owner_type,owner_id,platform,external_id'}).select(connectionFields).single()
      if(error||!data)throw new SocialAdminError('SOCIAL_CONNECTION_SAVE_FAILED',500)
      return safeConnection(data)
    },
    async revoke(id){
      const {data,error}=await scope(table().update({status:'revoked',token_ciphertext:null,token_expires_at:null,updated_at:new Date(clock()).toISOString()})).eq('id',normalizeSocialId(id)).select(connectionFields).maybeSingle()
      if(error)throw new SocialAdminError('SOCIAL_CONNECTION_REVOKE_FAILED',500)
      if(!data)throw new SocialAdminError('SOCIAL_CONNECTION_NOT_FOUND',404)
      return safeConnection(data)
    }
  }
}

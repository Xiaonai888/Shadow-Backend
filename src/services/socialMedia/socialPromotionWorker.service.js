const idPattern=/^\d{1,40}(?:_\d{1,40})?$/
const codePattern=/^SOCIAL_[A-Z0-9_]{1,90}$/
function safeCode(error){return typeof error?.code==='string'&&codePattern.test(error.code)?error.code:'SOCIAL_WORKER_OPERATION_FAILED'}
function stop(code){const e=new Error(code);e.code=code;return e}
export function createSocialPromotionWorker({store,loadPost,decryptToken,publishFacebook,prepareInstagram,createInstagramCarousel,publishInstagramContainer,prepareMedia,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
  if(!store?.claim||!store?.context||!store?.finish||![loadPost,decryptToken,publishFacebook,prepareInstagram,createInstagramCarousel,publishInstagramContainer,prepareMedia,wait].every(fn=>typeof fn==='function'))throw new TypeError('SOCIAL_WORKER_DEPENDENCIES')
  let running=false
  return {async run(){
    if(running)return {state:'busy'}
    running=true
    try{
      const claimed=await store.claim();if(!claimed)return {state:'idle'}
      const {job,items}=claimed
      let outcome,postId=null,errorCode=null,attempted=false
      try{
        const context=await store.context(job)
        if(!context)throw stop('SOCIAL_WORKER_CONTEXT_CHANGED')
        const {connection,rule}=context
        const platform=connection.platform
        if(!['facebook','instagram'].includes(platform))throw stop('SOCIAL_WORKER_PLATFORM_INVALID')
        let post=await loadPost({job,items,rule,platform})
        if(!post||post.platform!==platform||post.language!==job.language||!['cover','short_preview','cover_group','manga_preview'].includes(post.format)||!Array.isArray(post.storyIds)||!Array.isArray(post.episodeIds)||post.storyIds.length!==items.length||post.episodeIds.length!==items.length||items.some((x,i)=>x.story_id!==post.storyIds[i]||x.episode_id!==post.episodeIds[i])||(job.caption_id??null)!==(post.captionId??null))throw stop('SOCIAL_WORKER_CONTENT_CHANGED')
        post=await prepareMedia({platform,post})
        if(!post||post.platform!==platform)throw stop('SOCIAL_WORKER_MEDIA_INVALID')
        const token=decryptToken(connection.token_ciphertext,{ownerType:'admin',ownerId:'shadow',platform,externalId:connection.external_id})
        const verify=async()=>{
          const fresh=await store.context(job)
          if(!fresh||fresh.connection.platform!==platform||fresh.connection.external_id!==connection.external_id||fresh.connection.token_ciphertext!==connection.token_ciphertext)throw stop('SOCIAL_WORKER_CONTEXT_CHANGED')
        }
        await verify()
        if(platform==='facebook'){
          attempted=true
          const result=await publishFacebook({pageId:connection.external_id,pageToken:token,post})
          postId=result?.postId
        }else{
          const args={instagramId:connection.external_id,userToken:token,post}
          let result=await prepareInstagram(args)
          if(result?.state==='children_created'){
            const childIds=result.childIds
            for(let i=0;i<3;i++){
              result=await createInstagramCarousel({...args,childIds})
              if(result?.state!=='pending')break
              if(i<2)await wait(10000)
            }
          }
          if(result?.state!=='container_created'||!result.containerId)throw stop('SOCIAL_IG_CONTAINER_NOT_READY')
          const containerId=result.containerId
          for(let i=0;i<3;i++){
            await verify()
            attempted=true
            result=await publishInstagramContainer({...args,containerId})
            if(result?.state==='published'){postId=result.postId;break}
            if(result?.state!=='pending')throw stop('SOCIAL_IG_PUBLISH_UNKNOWN')
            attempted=false
            if(i<2)await wait(10000)
          }
          if(!postId)throw stop('SOCIAL_IG_CONTAINER_NOT_READY')
        }
        if(typeof postId!=='string'||!idPattern.test(postId))throw stop('SOCIAL_WORKER_POST_ID_UNKNOWN')
        outcome='published'
      }catch(error){
        errorCode=safeCode(error)
        postId=null
        outcome=error?.uncertain===true||attempted?'needs_review':['SOCIAL_WORKER_CONTEXT_CHANGED','SOCIAL_WORKER_CONTENT_CHANGED'].includes(errorCode)?'cancelled':'failed'
      }
      await store.finish(job,outcome,{postId,errorCode})
      return {state:outcome,jobId:job.id,...(errorCode?{errorCode}:{})}
    }finally{running=false}
  }}
}

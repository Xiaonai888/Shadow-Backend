import {createThreadsGraph,threadsId,threadsToken,ThreadsGraphError} from './threadsGraphTransport.service.js'
import {isIP} from 'node:net'

const fail=(code,status=400,uncertain=false)=>{throw new ThreadsGraphError(code,status,uncertain)}
function photoUrl(value){
  try{
    const u=new URL(value),host=u.hostname.toLowerCase()
    if(typeof value!=='string'||value.length>4096||u.protocol!=='https:'||u.username||u.password||u.port||u.hash||isIP(host)||!host.includes('.')||/(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(host))throw new Error()
    return u.href
  }catch{fail('SOCIAL_THREADS_PHOTO_INVALID')}
}
function validate({threadsId:accountId,userToken,post}){
  if(!threadsId(accountId)||!threadsToken(userToken)||post?.platform!=='threads'||!['photo','carousel'].includes(post.mediaType)||typeof post.caption!=='string'||!post.caption.trim()||[...post.caption].length>500||!Array.isArray(post.photos))fail('SOCIAL_THREADS_POST_INVALID')
  if(post.mediaType==='photo'?post.photos.length!==1:post.photos.length<3||post.photos.length>5)fail('SOCIAL_THREADS_PHOTO_COUNT')
  const photos=post.photos.map(photoUrl)
  if(new Set(photos).size!==photos.length)fail('SOCIAL_THREADS_PHOTO_DUPLICATE')
  return photos
}
function createdId(data,publish=false){if(!threadsId(data?.id))fail('SOCIAL_THREADS_CREATED_ID_INVALID',502,publish);return data.id}
export function createThreadsPromotionPublisher(options={}){
  const request=createThreadsGraph(options)
  async function read(containerId,token){
    if(!threadsId(containerId)||!threadsToken(token))fail('SOCIAL_THREADS_CONTAINER_INVALID')
    const data=await request({path:containerId,token,params:{fields:'id,status'}})
    if(data.id!==containerId||!['FINISHED','IN_PROGRESS','ERROR','EXPIRED','PUBLISHED'].includes(data.status))fail('SOCIAL_THREADS_CONTAINER_STATUS_UNKNOWN',502)
    return data.status
  }
  const create=async(accountId,token,params)=>createdId(await request({path:`${accountId}/threads`,method:'POST',token,params}))
  return {
    async prepare(input){
      const photos=validate(input),{threadsId:accountId,userToken,post}=input
      if(photos.length===1)return {state:'container_created',containerId:await create(accountId,userToken,{media_type:'IMAGE',image_url:photos[0],text:post.caption})}
      const childIds=[]
      for(const image_url of photos)childIds.push(await create(accountId,userToken,{media_type:'IMAGE',image_url,is_carousel_item:'true'}))
      if(new Set(childIds).size!==childIds.length)fail('SOCIAL_THREADS_CHILD_DUPLICATE',502)
      return {state:'children_created',childIds}
    },
    async carousel(input){
      const photos=validate(input),{threadsId:accountId,userToken,post,childIds}=input
      if(post.mediaType!=='carousel'||!Array.isArray(childIds)||childIds.length!==photos.length||new Set(childIds).size!==childIds.length||!childIds.every(threadsId))fail('SOCIAL_THREADS_CHILD_INVALID')
      let pending=false
      for(const id of childIds){const status=await read(id,userToken);if(status==='IN_PROGRESS')pending=true;else if(status!=='FINISHED')fail('SOCIAL_THREADS_CHILD_NOT_READY',422)}
      if(pending)return {state:'pending',childIds:[...childIds]}
      return {state:'container_created',containerId:await create(accountId,userToken,{media_type:'CAROUSEL',children:childIds.join(','),text:post.caption})}
    },
    async publish({threadsId:accountId,userToken,containerId}={}){
      if(!threadsId(accountId)||!threadsToken(userToken))fail('SOCIAL_THREADS_ACCOUNT_INVALID')
      const status=await read(containerId,userToken)
      if(status==='IN_PROGRESS')return {state:'pending',containerId}
      if(status==='PUBLISHED')fail('SOCIAL_THREADS_ALREADY_PUBLISHED',502,true)
      if(status!=='FINISHED')fail('SOCIAL_THREADS_CONTAINER_NOT_READY',422)
      const result=await request({path:`${accountId}/threads_publish`,method:'POST',token:userToken,params:{creation_id:containerId},publishing:true})
      return {state:'published',postId:createdId(result,true)}
    }
  }
}

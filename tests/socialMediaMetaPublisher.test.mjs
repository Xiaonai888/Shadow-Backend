import test from 'node:test'
import assert from 'node:assert/strict'
import { verifyMetaInstagramConnection, verifyMetaFacebookConnection } from '../src/services/socialMedia/metaConnection.service.js'
import { publishFacebookPromotion } from '../src/services/socialMedia/facebookPromotionPublisher.service.js'
import { prepareInstagramPromotion, createInstagramCarousel, publishInstagramContainer } from '../src/services/socialMedia/instagramPromotionPublisher.service.js'
import { requestMetaGraph } from '../src/services/socialMedia/metaGraphTransport.service.js'

process.env.SOCIAL_META_GRAPH_VERSION = 'v27.0'
process.env.SOCIAL_META_APP_SECRET = 'mock-only-secret'
const json = (data, status = 200) => new Response(JSON.stringify(data), { status })
const photos = ['https://cdn.shadow.example.com/a.jpg','https://cdn.shadow.example.com/b.jpg','https://cdn.shadow.example.com/c.jpg']
const post = (platform, list = photos) => ({ platform, mediaType: list.length === 1 ? 'photo' : 'carousel', photos: list, caption: 'Shadow story preview' })
const fb = { pageId:'123', pageToken:'mock-token' }
const ig = { instagramId:'456', userToken:'mock-token' }

test('Facebook and linked Instagram identities are verified without returning a token', async () => {
  const page = await verifyMetaFacebookConnection({ ...fb, fetchImpl: async () => json({ id:'123', name:'Shadow' }) })
  assert.deepEqual(page,{ platform:'facebook', externalId:'123', displayName:'Shadow' })
  const linked = await verifyMetaInstagramConnection({ pageId:'123', ...ig, fetchImpl: async (url,init) => {
    assert.equal(url.pathname,'/v27.0/123')
    assert.equal(url.searchParams.get('fields'),'id,instagram_business_account{id,username}')
    assert.equal(init.headers.Authorization,'Bearer mock-token')
    assert.match(url.searchParams.get('appsecret_proof'),/^[a-f0-9]{64}$/)
    return json({ id:'123',instagram_business_account:{ id:'456',username:'shadow' } })
  } })
  assert.deepEqual(linked,{ platform:'instagram', externalId:'456', displayName:'shadow', linkedPageId:'123' })
  await assert.rejects(verifyMetaInstagramConnection({ pageId:'123', ...ig, fetchImpl: async () => json({ id:'123',instagram_business_account:{ id:'999',username:'other' } }) }),/ACCOUNT_MISMATCH/)
})

test('Facebook single photo reuses existing publisher', async () => {
  const result = await publishFacebookPromotion({ ...fb, post:post('facebook',[photos[0]]), fetchImpl: async (url,init) => {
    assert.equal(url.pathname,'/v27.0/123/photos')
    assert.equal(init.body.get('published'),'true')
    assert.equal(init.body.get('caption'),'Shadow story preview')
    return json({ id:'8',post_id:'123_9' })
  } })
  assert.deepEqual(result,{ postId:'123_9' })
})

test('Facebook carousel uploads unpublished photos sequentially before one public feed post', async () => {
  let calls = 0
  const result = await publishFacebookPromotion({ ...fb, post:post('facebook'), fetchImpl: async (url,init) => {
    assert.equal(init.method,'POST')
    assert.equal(init.redirect,'error')
    calls++
    if (calls <= 3) {
      assert.equal(url.pathname,'/v27.0/123/photos')
      assert.equal(init.body.get('published'),'false')
      assert.equal(init.body.get('temporary'),'true')
      assert.equal(init.body.get('url'),photos[calls-1])
      return json({ id:String(100+calls) })
    }
    assert.equal(url.pathname,'/v27.0/123/feed')
    assert.equal(init.body.get('message'),'Shadow story preview')
    assert.deepEqual([0,1,2].map(i=>JSON.parse(init.body.get(`attached_media[${i}]`)).media_fbid),['101','102','103'])
    return json({ id:'123_77' })
  } })
  assert.equal(calls,4)
  assert.deepEqual(result,{ postId:'123_77' })
})

test('Facebook upload failure stops before any public feed request', async () => {
  let calls = 0
  await assert.rejects(publishFacebookPromotion({ ...fb, post:post('facebook'), fetchImpl: async (url) => {
    assert.equal(url.pathname,'/v27.0/123/photos')
    calls++
    return calls===1?json({id:'100'}):json({error:{code:190,message:'private secret'}},400)
  } }),e=>e.metaCode===190&&!e.message.includes('private'))
  assert.equal(calls,2)
})

test('Facebook final ambiguous response stops with no repeat publish', async () => {
  let calls=0
  await assert.rejects(publishFacebookPromotion({ ...fb, post:post('facebook'), fetchImpl: async (url) => {
    calls++
    if (url.pathname.endsWith('/feed')) throw new Error('private secret')
    return json({ id:String(calls) })
  } }),e=>e.uncertain&&e.code==='SOCIAL_META_RESPONSE_UNKNOWN')
  assert.equal(calls,4)
})

test('Instagram single photo creates container without publishing', async () => {
  const result=await prepareInstagramPromotion({ ...ig, post:post('instagram',[photos[0]]), fetchImpl:async(url,init)=>{
    assert.equal(url.pathname,'/v27.0/456/media')
    assert.equal(init.body.get('image_url'),photos[0])
    assert.equal(init.body.get('caption'),'Shadow story preview')
    return json({id:'80'})
  } })
  assert.deepEqual(result,{state:'container_created',containerId:'80'})
})

test('Instagram carousel stages child containers then checks readiness and creates parent',async()=>{
  const p=post('instagram');let calls=0
  const children=await prepareInstagramPromotion({...ig,post:p,fetchImpl:async(url,init)=>{
    assert.equal(url.pathname,'/v27.0/456/media')
    assert.equal(init.body.get('is_carousel_item'),'true')
    assert.equal(init.body.get('caption'),null)
    assert.equal(init.body.get('image_url'),photos[calls])
    return json({id:String(100+(++calls))})
  }})
  assert.deepEqual(children,{state:'children_created',childIds:['101','102','103']})
  const parent=await createInstagramCarousel({...ig,post:p,childIds:children.childIds,fetchImpl:async(url,init)=>{
    if(init.method==='GET') return json({id:url.pathname.split('/').at(-1),status_code:'FINISHED'})
    assert.equal(url.pathname,'/v27.0/456/media')
    assert.equal(init.body.get('media_type'),'CAROUSEL')
    assert.equal(init.body.get('children'),'101,102,103')
    return json({id:'200'})
  }})
  assert.deepEqual(parent,{state:'container_created',containerId:'200'})
})

test('Instagram pending child and parent do not publish or create another container',async()=>{
  const p=post('instagram')
  const childResult=await createInstagramCarousel({...ig,post:p,childIds:['101','102','103'],fetchImpl:async(url,init)=>{
    assert.equal(init.method,'GET')
    return json({id:url.pathname.split('/').at(-1),status_code:'IN_PROGRESS'})
  }})
  assert.equal(childResult.state,'pending')
  const parentResult=await publishInstagramContainer({...ig,containerId:'200',fetchImpl:async(url,init)=>{
    assert.equal(init.method,'GET')
    return json({id:'200',status_code:'IN_PROGRESS'})
  }})
  assert.deepEqual(parentResult,{state:'pending',containerId:'200'})
})

test('Instagram finished parent publishes once, already published or failed parent stops',async()=>{
  let calls=0
  const result=await publishInstagramContainer({...ig,containerId:'200',fetchImpl:async(url,init)=>{
    calls++
    if(init.method==='GET')return json({id:'200',status_code:'FINISHED'})
    assert.equal(url.pathname,'/v27.0/456/media_publish')
    assert.equal(init.body.get('creation_id'),'200')
    return json({id:'300'})
  }})
  assert.deepEqual(result,{state:'published',postId:'300'})
  assert.equal(calls,2)
  for(const status of ['PUBLISHED','ERROR','EXPIRED'])await assert.rejects(publishInstagramContainer({...ig,containerId:'200',fetchImpl:async(url,init)=>{
    assert.equal(init.method,'GET');return json({id:'200',status_code:status})
  }}),e=>status==='PUBLISHED'?e.uncertain:e.code==='SOCIAL_IG_CONTAINER_NOT_USABLE')
})

test('invalid image, platform and Graph path rejected before request',async()=>{
  const never=async()=>assert.fail('unexpected request')
  await assert.rejects(prepareInstagramPromotion({...ig,post:post('instagram',['https://cdn.shadow.example.com/a.webp']),fetchImpl:never}),/JPEG_REQUIRED/)
  await assert.rejects(publishFacebookPromotion({...fb,post:post('instagram'),fetchImpl:never}),/POST_INVALID/)
  await assert.rejects(publishFacebookPromotion({...fb,post:post('facebook',['https://127.0.0.1/a.jpg']),fetchImpl:never}),/PHOTO_INVALID/)
  await assert.rejects(publishFacebookPromotion({...fb,post:post('facebook',[photos[0],photos[0],photos[1]]),fetchImpl:never}),/PHOTO_DUPLICATE/)
  await assert.rejects(requestMetaGraph({path:'../me',token:'mock-token',fetchImpl:never}),/PATH_INVALID/)
})

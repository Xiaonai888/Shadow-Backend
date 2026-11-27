import {EventAdminError} from './validation.service.js'

const fail=(message,status=400,code='EVENT_DESTINATION_INVALID')=>new EventAdminError(message,status,code)
const username=/^@[A-Za-z][A-Za-z0-9_]{4,31}$/
export function isEventChatId(value){return typeof value==='string'&&/^-[1-9]\d{0,15}$/.test(value)&&Number.isSafeInteger(Number(value))}
export function parseEventDestination(value){
  if(value==null||typeof value==='string'&&!value.trim())return null
  if(typeof value!=='string'||value.length>512)throw fail('Invalid Telegram link or chat ID')
  const input=value.trim()
  if(isEventChatId(input)||username.test(input))return input
  let url
  try{url=new URL(input.startsWith('t.me/')?'https://'+input:input)}catch{throw fail('Use a Telegram public link, @username or numeric chat ID')}
  if(url.protocol!=='https:'||url.hostname!=='t.me'||url.username||url.password||url.port||url.search||url.hash)throw fail('Use a Telegram public link or numeric chat ID')
  const path=url.pathname.replace(/^\//,'').replace(/\/$/,'')
  if(path.startsWith('+')||path.startsWith('joinchat/')||path.startsWith('c/'))throw fail('Private invite links cannot be resolved by bots. Enter the numeric chat ID.')
  if(!username.test('@'+path)||['joinchat','share','proxy','addstickers','addemoji','login','socks','invoice'].includes(path.toLowerCase()))throw fail('Use the public chat link without a message path')
  return '@'+path
}
export function createEventDestinationVerifier({token=()=>'',fetchImpl=globalThis.fetch}={}){
  async function request(secret,method,payload){
    const controller=new AbortController()
    const timer=setTimeout(()=>controller.abort(),8000)
    try{
      let response,data
      try{response=await fetchImpl(`https://api.telegram.org/bot${secret}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),redirect:'error',signal:controller.signal});data=await response.json()}
      catch{throw fail('Telegram verification unavailable. Try again.',502,'EVENT_DESTINATION_UNAVAILABLE')}
      if(!response.ok||data?.ok!==true){
        if(response.status===429||response.status>=500)throw fail('Telegram verification unavailable. Try again.',502,'EVENT_DESTINATION_UNAVAILABLE')
        throw fail('Telegram chat or bot permission could not be verified',422,'EVENT_DESTINATION_NOT_VERIFIED')
      }
      return data.result
    }finally{clearTimeout(timer)}
  }
  return async function verify({channel,group}={}){
    const targets={channel:parseEventDestination(channel),group:parseEventDestination(group)}
    if(!targets.channel&&!targets.group)return {channel:null,group:null}
    const secret=String(typeof token==='function'?token():token||'').trim()
    if(!/^\d+:[A-Za-z0-9_-]+$/.test(secret))throw fail('Configure Event Bot token first',409,'EVENT_BOT_DISABLED')
    const bot=await request(secret,'getMe',{})
    if(!Number.isSafeInteger(bot?.id)||bot.id<=0||bot.is_bot!==true)throw fail('Event Bot identity could not be verified',422)
    async function verifyOne(kind,value){
      if(!value)return null
      const chat=await request(secret,'getChat',{chat_id:value})
      const id=String(chat?.id??'')
      if(!isEventChatId(id)||typeof chat.title!=='string'||!chat.title.trim()||(kind==='channel'?chat.type!=='channel'||!/^\-100\d{5,17}$/.test(id):!['group','supergroup'].includes(chat.type)))throw fail(`The ${kind} field must contain a Telegram ${kind}`,422,'EVENT_DESTINATION_WRONG_TYPE')
      if(isEventChatId(value)&&id!==value)throw fail('Telegram chat ID changed. Enter the current chat ID.',422)
      const member=await request(secret,'getChatMember',{chat_id:id,user_id:bot.id})
      if(member?.user?.id!==bot.id)throw fail('Bot membership could not be verified',422)
      const admin=member.status==='creator'||member.status==='administrator'
      const allowed=kind==='channel'?member.status==='creator'||(admin&&member.can_post_messages===true):admin||(member.status==='member'&&chat.permissions?.can_send_messages===true&&chat.permissions?.can_send_photos===true)||(member.status==='restricted'&&member.is_member===true&&member.can_send_messages===true&&member.can_send_photos===true)
      if(!allowed)throw fail(`Add the Event Bot to the ${kind} and allow text and photo posting`,422,'EVENT_DESTINATION_PERMISSION')
      return {id,name:Array.from(chat.title.trim()).slice(0,200).join(''),type:chat.type}
    }
    const [verifiedChannel,verifiedGroup]=await Promise.all([verifyOne('channel',targets.channel),verifyOne('group',targets.group)])
    if(verifiedChannel&&verifiedGroup&&verifiedChannel.id===verifiedGroup.id)throw fail('Channel and Group must be different chats')
    return {channel:verifiedChannel,group:verifiedGroup}
  }
}

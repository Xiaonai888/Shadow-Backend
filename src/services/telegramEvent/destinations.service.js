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
  async function request(secret,method,payload,kind,deadline){
    const stage=`${kind} ${method}`
    const transient=(reason)=>fail(`Telegram ${stage} unavailable (${reason}). Try again.`,502,'EVENT_DESTINATION_UNAVAILABLE')
    for(let attempt=0;attempt<2;attempt++){
      const remaining=deadline-Date.now()
      if(remaining<=0)throw transient('TIMEOUT')
      const controller=new AbortController()
      const timer=setTimeout(()=>controller.abort(),Math.min(8000,remaining))
      let retryReason=null
      try{
        let response,data
        try{
          response=await fetchImpl(`https://api.telegram.org/bot${secret}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),redirect:'error',signal:controller.signal})
          if(response.status===429)throw fail(`Telegram ${stage} rate limited (429). Try again later.`,429,'EVENT_DESTINATION_UNAVAILABLE')
          if(response.status>=500){retryReason=`HTTP ${response.status}`;await response.body?.cancel().catch(()=>{})}
          else data=await response.json()
        }catch(error){
          if(error instanceof EventAdminError)throw error
          const code=error?.cause?.code??error?.code
          retryReason=['ETIMEDOUT','ECONNRESET','ECONNREFUSED','EAI_AGAIN','ENETUNREACH','UND_ERR_CONNECT_TIMEOUT','UND_ERR_SOCKET','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT'].includes(code)?code:controller.signal.aborted?'TIMEOUT':'NETWORK_OR_RESPONSE_ERROR'
        }
        if(!retryReason){
          if(!response.ok||data?.ok!==true){
            const status=Number(data?.error_code||response.status)
            if(status===429)throw fail(`Telegram ${stage} rate limited (429). Try again later.`,429,'EVENT_DESTINATION_UNAVAILABLE')
            if(status>=500)retryReason=`HTTP ${status}`
            else if(status===401)throw fail('Event Bot token rejected by Telegram (401)',422,'EVENT_DESTINATION_NOT_VERIFIED')
            else throw fail(`Telegram ${stage} could not be verified (HTTP ${response.status}). Check chat and bot permissions.`,422,'EVENT_DESTINATION_NOT_VERIFIED')
          }else return data.result
        }
      }finally{clearTimeout(timer)}
      if(attempt===1||deadline-Date.now()<=350)throw transient(retryReason)
      await new Promise(resolve=>setTimeout(resolve,350))
    }
  }
  return async function verify({channel,group}={}){
    const targets={channel:parseEventDestination(channel),group:parseEventDestination(group)}
    if(!targets.channel&&!targets.group)return {channel:null,group:null}
    const secret=String(typeof token==='function'?token():token||'').trim()
    if(!/^\d+:[A-Za-z0-9_-]+$/.test(secret))throw fail('Configure Event Bot token first',409,'EVENT_BOT_DISABLED')
    const deadline=Date.now()+25000
    const bot=await request(secret,'getMe',{},'Bot',deadline)
    if(!Number.isSafeInteger(bot?.id)||bot.id<=0||bot.is_bot!==true)throw fail('Event Bot identity could not be verified',422)
    async function verifyOne(kind,value){
      if(!value)return null
      const chat=await request(secret,'getChat',{chat_id:value},kind,deadline)
      const id=String(chat?.id??'')
      if(!isEventChatId(id)||typeof chat.title!=='string'||!chat.title.trim()||(kind==='channel'?chat.type!=='channel'||!/^\-100\d{5,17}$/.test(id):!['group','supergroup'].includes(chat.type)))throw fail(`The ${kind} field must contain a Telegram ${kind}`,422,'EVENT_DESTINATION_WRONG_TYPE')
      if(isEventChatId(value)&&id!==value)throw fail('Telegram chat ID changed. Enter the current chat ID.',422)
      const member=await request(secret,'getChatMember',{chat_id:id,user_id:bot.id},kind,deadline)
      if(member?.user?.id!==bot.id)throw fail('Bot membership could not be verified',422)
      const admin=member.status==='creator'||member.status==='administrator'
      const allowed=kind==='channel'?member.status==='creator'||(admin&&member.can_post_messages===true):admin||(member.status==='member'&&chat.permissions?.can_send_messages===true&&chat.permissions?.can_send_photos===true)||(member.status==='restricted'&&member.is_member===true&&member.can_send_messages===true&&member.can_send_photos===true)
      if(!allowed)throw fail(`Add the Event Bot to the ${kind} and allow text and photo posting`,422,'EVENT_DESTINATION_PERMISSION')
      return {id,name:Array.from(chat.title.trim()).slice(0,200).join(''),type:chat.type}
    }
    const verifiedChannel=await verifyOne('channel',targets.channel)
    const verifiedGroup=await verifyOne('group',targets.group)
    if(verifiedChannel&&verifiedGroup&&verifiedChannel.id===verifiedGroup.id)throw fail('Channel and Group must be different chats')
    return {channel:verifiedChannel,group:verifiedGroup}
  }
}

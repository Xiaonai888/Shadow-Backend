export function createCandidateCache({ttlMs=30000,maxEntries=16,maxBytes=1048576,clock=Date.now}={}){
  if(!Number.isSafeInteger(ttlMs)||ttlMs<1||ttlMs>60000||!Number.isSafeInteger(maxEntries)||maxEntries<1||maxEntries>32||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>2097152||typeof clock!=='function')throw new TypeError('Invalid candidate cache configuration')
  const entries=new Map(),pending=new Map()
  let bytes=0,revision=0
  function remove(key){const old=entries.get(key);if(old){bytes-=old.bytes;entries.delete(key)}}
  function prune(){const now=clock();for(const [key,item] of entries)if(item.expires<=now)remove(key)}
  return {
    async get(key,load){
      prune()
      const found=entries.get(key)
      if(found){entries.delete(key);entries.set(key,found);return JSON.parse(found.json)}
      if(pending.has(key))return JSON.parse(await pending.get(key))
      if(pending.size>=8)throw new Error('SMART_CONTENT_SOURCE_BUSY')
      const current=revision
      const promise=Promise.resolve().then(load).then(value=>{
        const json=JSON.stringify(value),size=Buffer.byteLength(json,'utf8')+Buffer.byteLength(key,'utf8')
        if(current===revision&&size<=maxBytes){
          prune();remove(key)
          while(entries.size>=maxEntries||bytes+size>maxBytes)remove(entries.keys().next().value)
          entries.set(key,{json,bytes:size,expires:clock()+ttlMs});bytes+=size
        }
        return json
      })
      pending.set(key,promise)
      try{return JSON.parse(await promise)}finally{if(pending.get(key)===promise)pending.delete(key)}
    },
    clear(){revision++;entries.clear();pending.clear();bytes=0},
    stats(){prune();return {entries:entries.size,bytes,pending:pending.size}}
  }
}

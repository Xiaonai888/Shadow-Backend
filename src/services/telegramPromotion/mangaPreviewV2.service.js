const positive=v=>Number.isSafeInteger(Number(v))&&Number(v)>0?Number(v):null
const position=v=>v!==null&&v!==undefined&&v!==''&&Number.isSafeInteger(Number(v))&&Number(v)>=0?Number(v):null
function ordered(rows,key){
  if(!Array.isArray(rows)||!rows.length)return null
  const values=rows.map(row=>({row,index:position(row?.[key])}))
  if(values.some(v=>v.index===null)||new Set(values.map(v=>v.index)).size!==values.length)return null
  return values.sort((a,b)=>a.index-b.index).map(v=>v.row)
}
function unit(row){
  const width=positive(row?.width),height=positive(row?.height)
  const bytes=row?.file_size==null?null:positive(row.file_size)
  let url
  try{url=new URL(String(row?.image_url||''))}catch{return null}
  if(!width||!height||url.protocol!=='https:'||url.username||url.password)return null
  return {url:url.href,width,height,bytes,length:height/width}
}
function sendable(u){return u.width+u.height<=10000&&Math.max(u.width/u.height,u.height/u.width)<=20&&(u.bytes===null||u.bytes<=10000000)}
export function selectMangaPreview(pages){
  const fallback=reason=>({photos:[],coveragePercent:0,reason})
  const sorted=ordered(pages,'sort_order')
  if(!sorted)return fallback('missing_page_order')
  const units=[]
  for(const page of sorted){
    if(!Array.isArray(page.parts))return fallback('parts_not_loaded')
    const rows=page.parts.length?ordered(page.parts,'part_index'):[page]
    if(!rows)return fallback('invalid_part_order')
    for(const row of rows){const item=unit(row);if(!item)return fallback('missing_media_metadata');units.push(item)}
  }
  if(new Set(units.map(u=>u.url)).size!==units.length)return fallback('duplicate_media')
  const total=units.reduce((sum,u)=>sum+u.length,0)
  if(!Number.isFinite(total)||total<=0)return fallback('invalid_total_length')
  const photos=[];let used=0
  for(const item of units){
    if(photos.length===5||!sendable(item)||used+item.length>total*0.3)break
    photos.push(item.url);used+=item.length
  }
  if(photos.length<3)return fallback('insufficient_safe_preview')
  return {photos,coveragePercent:used/total*100,reason:null}
}

export function resolvePreviewSafety({story,episode,approvedPublicPreview=false,approvedPublicCover=false}={}){
  const adultStory=story?.is_adult===true,adultEpisode=episode?.is_adult===true
  const restricted=adultStory||adultEpisode
  return {allowExcerpt:!adultEpisode||approvedPublicPreview===true,allowCover:!restricted||approvedPublicCover===true,spoiler:adultEpisode,restricted}
}
export function addExcerptSpoiler({caption,entities=[],excerptOffset,excerptLength,enabled=false}){
  if(typeof caption!=='string'||!Array.isArray(entities))throw new TypeError('Invalid caption')
  if(!enabled||!excerptLength)return [...entities]
  if(!Number.isInteger(excerptOffset)||!Number.isInteger(excerptLength)||excerptOffset<0||excerptLength<1||excerptOffset+excerptLength>caption.length)throw new RangeError('Invalid spoiler range')
  for(const e of entities){if(e.offset<excerptOffset+excerptLength&&e.offset+e.length>excerptOffset)throw new RangeError('Overlapping caption entity')}
  return [...entities,{type:'spoiler',offset:excerptOffset,length:excerptLength}].sort((a,b)=>a.offset-b.offset)
}
export function buildMangaAlbum({photos,caption,captionEntities=[],spoiler=false}){
  if(!Array.isArray(photos)||photos.length<3||photos.length>5||new Set(photos).size!==photos.length||typeof caption!=='string'||caption.length>1000||!Array.isArray(captionEntities))throw new TypeError('Invalid Manga album')
  return photos.map((media,i)=>{
    const url=new URL(media)
    if(url.protocol!=='https:'||url.username||url.password)throw new TypeError('Invalid Manga URL')
    return {type:'photo',media:url.href,...(spoiler?{has_spoiler:true}:{}),...(i===0?{caption,caption_entities:captionEntities}:{})}
  })
}

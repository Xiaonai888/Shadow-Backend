import sharp from 'sharp'
import { stat } from 'node:fs/promises'

const [input,output]=process.argv.slice(2)
if(!input||!output||input===output)process.exit(1)
sharp.cache(false)
sharp.concurrency(1)
try{
  const options={limitInputPixels:12000000,failOn:'error',sequentialRead:true,animated:false}
  const meta=await sharp(input,options).metadata()
  if(!['jpeg','png','webp'].includes(meta.format)||!meta.width||!meta.height||(meta.pages||1)>1||meta.width*meta.height>12000000)throw new Error('invalid')
  await sharp(input,options).rotate().flatten({background:'#ffffff'}).resize(1080,1350,{fit:'contain',background:'#ffffff',withoutEnlargement:false}).jpeg({quality:85,mozjpeg:false}).toFile(output)
  const file=await stat(output)
  if(!file.isFile()||file.size<=0||file.size>5*1024*1024)throw new Error('invalid')
}catch{process.exitCode=1}

import test from 'node:test'
import assert from 'node:assert/strict'
import { validateSave, validateChannel, validateContent, validateList } from '../services/telegramEvent/validation.service.js'
import { createEventAdmin } from '../services/telegramEvent/admin.service.js'
const id='12345678-1234-4234-8234-123456789012'
const publicUrl='https://images.example.com'
const input={name:'Sunday Event',audience:'reader',status:'draft',schedule_mode:'weekly',schedule_slots:[{day:0,time:'20:00'},{day:0,time:'08:00'}],starts_on:'2026-11-29',ends_on:null,contents:[{language:'km',enabled:false,message:'Hello'}]}
const validate=v=>validateSave(v,{publicUrl})
test('weekly forever and sorted slots',()=>{const a=validate(input);assert.equal(a.event.ends_on,null);assert.equal(a.event.schedule_slots[0].time,'08:00')})
test('multiple specific dates',()=>{const a=validate({...input,schedule_mode:'dates',starts_on:null,schedule_slots:[{date:'2026-12-01',time:'10:00'},{date:'2026-12-02',time:'09:00'}]});assert.equal(a.event.schedule_slots.length,2)})
test('invalid calendar and duplicate rejected',()=>{assert.throws(()=>validate({...input,starts_on:'2026-02-30'}));assert.throws(()=>validate({...input,schedule_slots:[input.schedule_slots[0],input.schedule_slots[0]]}))})
test('empty schedule draft only',()=>{assert.doesNotThrow(()=>validate({...input,schedule_slots:[],starts_on:null}));assert.throws(()=>validate({...input,status:'active',schedule_slots:[],starts_on:null}))})
test('image namespace and HTTPS validated',()=>{const image_key=`telegram-events/images/admin/123-${id}.png`;assert.equal(validateContent({language:'km',enabled:true,message:'',image_key,image_url:`${publicUrl}/${image_key}`},{publicUrl}).image_key,image_key);assert.throws(()=>validateContent({language:'km',enabled:true,message:'',image_key,image_url:`https://evil.example/${image_key}`},{publicUrl}))})
test('duplicate languages and invalid buttons rejected',()=>{assert.throws(()=>validate({...input,contents:[input.contents[0],input.contents[0]]}));assert.throws(()=>validateContent({...input.contents[0],button_label:'Open',button_url:'http://example.com'}))})
test('channel configuration and pagination',()=>{assert.throws(()=>validateChannel({channel_id:'@name',enabled:true,updated_at:'2026-11-27T00:00:00Z'}));assert.equal(validateList({language:'en'}).page,1);assert.throws(()=>validateList({language:'en',page:1001}))})
test('create and update invoke atomic save',async()=>{const calls=[];const db={rpc:async(name,args)=>{calls.push({name,args});return {data:id}}};const admin=createEventAdmin(db,{publicUrl});assert.deepEqual(await admin.create(input),{id});await admin.update(id,{...input,revision:2});assert.equal(calls[0].name,'telegram_event_admin_save_v1');assert.equal(calls[0].args.p_id,null);assert.equal(calls[1].args.p_revision,2)})
test('database conflict is surfaced without retry',async()=>{const admin=createEventAdmin({rpc:async()=>({error:{message:'EVENT_CONFLICT'}})});await assert.rejects(admin.update(id,{...input,revision:1}),e=>e.status===409)})

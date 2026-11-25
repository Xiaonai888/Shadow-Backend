const test = require('node:test');
const assert = require('node:assert/strict');
const { recentExposureHistory, createPrivateHistoryRecorder } = require('../src/services/taskCenter/smartAuto/privateHistory.cjs');
const now = 1800000000000;

test('private history deduplicates, expires and caps records', () => {
  const rows = Array.from({length: 70}, (_,i) => ({storyId: String(i), seenAt: now-i}));
  rows.push({storyId:'0',seenAt:now-100}, {storyId:'old',seenAt:now-604800001}, {storyId:'future',seenAt:now+1});
  const history = recentExposureHistory(rows,now);
  assert.equal(history.length,64);
  assert.deepEqual(history[0],{storyId:'0',seenAt:now});
  assert.equal(history.some(x => ['old','future'].includes(x.storyId)),false);
});

test('manual and legacy auto never write private history', async () => {
  const record = createPrivateHistoryRecorder({supabase:{rpc:async()=>{throw Error('unexpected RPC')}}});
  for(const mode of ['manual','auto']) assert.equal(await record({mode}),false);
});

test('only visible mission identifiers are sent, deduplicated', async () => {
  const calls=[];
  const record=createPrivateHistoryRecorder({supabase:{rpc:async(...args)=>{calls.push(args);return {data:true,error:null}}}});
  const mission={storyId:'story',windowStart:now,rewardCoins:999};
  assert.equal(await record({readerId:'reader',mode:'smart_auto',visibleMissions:[mission,mission]}),true);
  assert.deepEqual(calls,[['task_center_smart_auto_record_exposure_v1',{p_reader_id:'reader',p_visible_missions:[{storyId:'story',windowStart:now}]}]]);
});

test('empty batch skips RPC and invalid batches reject', async () => {
  const record=createPrivateHistoryRecorder({supabase:{rpc:async()=>{throw Error('unexpected RPC')}}});
  assert.equal(await record({readerId:'r',mode:'smart_auto',visibleMissions:[]}),false);
  await assert.rejects(record({readerId:'r',mode:'smart_auto',visibleMissions:[{}, {}, {}]}),TypeError);
});

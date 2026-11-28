import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const sql = readFileSync(new URL('../../../../sql/20261128_shadow_ai_gemini_learning_approval_v1.sql', import.meta.url), 'utf8')
test('approval RPC restricts execution to service role', () => {
  assert.match(sql, /revoke all on function public\.shadow_ai_gemini_approve_learning_candidates_v1\(text\[\],integer,jsonb,text\) from public, anon, authenticated, service_role/)
  assert.match(sql, /grant execute on function public\.shadow_ai_gemini_approve_learning_candidates_v1\(text\[\],integer,jsonb,text\) to service_role/)
  assert.match(sql, /security definer set search_path = pg_catalog, public/)
})
test('approval locks version and pending candidates before publish and removes only on success', () => {
  const version = sql.indexOf('where id=1 for update'), pending = sql.indexOf('order by example_id for update'), publish = sql.indexOf('v_result := public.shadow_ai_local_knowledge_publish_v1'), check = sql.indexOf("if v_result->'ok' is distinct from 'true'::jsonb"), remove = sql.indexOf('delete from public.shadow_ai_gemini_learning_candidates')
  assert.ok(version >= 0 && version < pending && pending < publish && publish < check && check < remove)
  assert.match(sql, /if v_removed <> v_count then\s+raise exception/)
  assert.match(sql, /p_aliases @> v_old/)
})

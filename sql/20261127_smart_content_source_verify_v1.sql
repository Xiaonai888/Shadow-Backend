begin transaction isolation level repeatable read read only;

with requests(language,topic,seed) as (
 values ('km','solo','shared-source-verify-km'),('en','trending','shared-source-verify-en')
), comparison as materialized (
 select language,topic,
 public.telegram_promotion_v2_candidate_page(language,topic,seed,0) as original,
 public.shadow_smart_content_candidate_page_v1(language,topic,seed,0,'telegram','{}','{}','{}') as shared
 from requests
)
select language,topic,original=shared as exact_match,
 jsonb_array_length(original->'candidates') as original_count,
 jsonb_array_length(shared->'candidates') as shared_count
from comparison;

with requests(language) as (values ('km'),('en'),('zh'),('ja'),('ko')),
 results as materialized (
 select language,public.shadow_smart_content_candidate_page_v1(language,'solo','shared-source-verify',0,'neutral','{}','{}','{}') as data
 from requests
)
select language,(data->>'scanned')::integer as scanned,
 jsonb_array_length(data->'candidates') as candidate_count,
 data->'history'='[]'::jsonb and data->'captions'='[]'::jsonb as isolated_history
from results;

rollback;

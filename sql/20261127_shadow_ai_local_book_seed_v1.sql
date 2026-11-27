begin;
do $seed$
declare
  v_snapshot jsonb;
  v_result jsonb;
  v_aliases jsonb := $aliases$
[
  {
    "group": "editions",
    "alias": "normal edition",
    "canonical": "standard"
  },
  {
    "group": "editions",
    "alias": "កញ្ចប់ limited",
    "canonical": "limited"
  },
  {
    "group": "editions",
    "alias": "ប្រភេទធម្មតា",
    "canonical": "standard"
  },
  {
    "group": "editions",
    "alias": "ប្រភេទមានកំណត់",
    "canonical": "limited"
  },
  {
    "group": "fields",
    "alias": "book edition",
    "canonical": "edition"
  },
  {
    "group": "fields",
    "alias": "contact number",
    "canonical": "phone_number"
  },
  {
    "group": "fields",
    "alias": "courier",
    "canonical": "delivery_company_key"
  },
  {
    "group": "fields",
    "alias": "customer name",
    "canonical": "name"
  },
  {
    "group": "fields",
    "alias": "number of copies",
    "canonical": "quantity"
  },
  {
    "group": "fields",
    "alias": "shipping address",
    "canonical": "delivery_address"
  },
  {
    "group": "fields",
    "alias": "want signature",
    "canonical": "signature_requested"
  },
  {
    "group": "fields",
    "alias": "ក្រុមហ៊ុនដឹក",
    "canonical": "delivery_company_key"
  },
  {
    "group": "fields",
    "alias": "ចង់បានស៊ីញ៉េ",
    "canonical": "signature_requested"
  },
  {
    "group": "fields",
    "alias": "ចំនួនសៀវភៅ",
    "canonical": "quantity"
  },
  {
    "group": "fields",
    "alias": "ឈ្មោះអ្នកកក់",
    "canonical": "name"
  },
  {
    "group": "fields",
    "alias": "ទីតាំងដឹកជញ្ជូន",
    "canonical": "delivery_address"
  },
  {
    "group": "fields",
    "alias": "ប្រភេទសៀវភៅ",
    "canonical": "edition"
  },
  {
    "group": "fields",
    "alias": "លេខទំនាក់ទំនង",
    "canonical": "phone_number"
  },
  {
    "group": "questions",
    "alias": "can i get a signed copy",
    "canonical": "signature"
  },
  {
    "group": "questions",
    "alias": "how much is delivery",
    "canonical": "delivery"
  },
  {
    "group": "questions",
    "alias": "how much is the book",
    "canonical": "price"
  },
  {
    "group": "questions",
    "alias": "how much is the signature",
    "canonical": "signature"
  },
  {
    "group": "questions",
    "alias": "how much per copy",
    "canonical": "price"
  },
  {
    "group": "questions",
    "alias": "is it still in stock",
    "canonical": "stock"
  },
  {
    "group": "questions",
    "alias": "what books can i reserve",
    "canonical": "books"
  },
  {
    "group": "questions",
    "alias": "what details do you need",
    "canonical": "requirements"
  },
  {
    "group": "questions",
    "alias": "what do i need to preorder",
    "canonical": "requirements"
  },
  {
    "group": "questions",
    "alias": "when is the deadline",
    "canonical": "schedule"
  },
  {
    "group": "questions",
    "alias": "when will the books ship",
    "canonical": "schedule"
  },
  {
    "group": "questions",
    "alias": "which books can i preorder",
    "canonical": "books"
  },
  {
    "group": "questions",
    "alias": "which delivery companies",
    "canonical": "delivery"
  },
  {
    "group": "questions",
    "alias": "កក់ដល់ថ្ងៃណា",
    "canonical": "schedule"
  },
  {
    "group": "questions",
    "alias": "កក់ត្រូវការអីខ្លះ",
    "canonical": "requirements"
  },
  {
    "group": "questions",
    "alias": "កក់ត្រូវផ្តល់ព័ត៌មានអ្វីខ្លះ",
    "canonical": "requirements"
  },
  {
    "group": "questions",
    "alias": "ដឹកជញ្ជូនតាមក្រុមហ៊ុនអី",
    "canonical": "delivery"
  },
  {
    "group": "questions",
    "alias": "ដឹកជញ្ជូនពេលណា",
    "canonical": "schedule"
  },
  {
    "group": "questions",
    "alias": "ដឹកតាមក្រុមហ៊ុនណា",
    "canonical": "delivery"
  },
  {
    "group": "questions",
    "alias": "តម្លៃសៀវភៅប៉ុន្មាន",
    "canonical": "price"
  },
  {
    "group": "questions",
    "alias": "ត្រូវផ្ញើព័ត៌មានអីខ្លះ",
    "canonical": "requirements"
  },
  {
    "group": "questions",
    "alias": "ថ្ងៃណាបិទកក់",
    "canonical": "schedule"
  },
  {
    "group": "questions",
    "alias": "ថ្លៃដឹកជញ្ជូនប៉ុន្មាន",
    "canonical": "delivery"
  },
  {
    "group": "questions",
    "alias": "ថ្លៃស៊ីញ៉េប៉ុន្មាន",
    "canonical": "signature"
  },
  {
    "group": "questions",
    "alias": "នៅមានសៀវភៅអត់",
    "canonical": "stock"
  },
  {
    "group": "questions",
    "alias": "នៅសល់សៀវភៅប៉ុន្មាន",
    "canonical": "stock"
  },
  {
    "group": "questions",
    "alias": "នៅអាចកក់បានអត់",
    "canonical": "stock"
  },
  {
    "group": "questions",
    "alias": "ពេលណាបិទកក់",
    "canonical": "schedule"
  },
  {
    "group": "questions",
    "alias": "មាន limited នៅ",
    "canonical": "stock"
  },
  {
    "group": "questions",
    "alias": "មានរឿងអីខ្លះ",
    "canonical": "books"
  },
  {
    "group": "questions",
    "alias": "មានសៀវភៅណាខ្លះ",
    "canonical": "books"
  },
  {
    "group": "questions",
    "alias": "មានស៊ីញេអត់",
    "canonical": "signature"
  },
  {
    "group": "questions",
    "alias": "មានហត្ថលេខាអត់",
    "canonical": "signature"
  },
  {
    "group": "questions",
    "alias": "មួយក្បាលថ្លៃប៉ុន្មាន",
    "canonical": "price"
  },
  {
    "group": "questions",
    "alias": "មួយក្បាលប៉ុន្មាន",
    "canonical": "price"
  },
  {
    "group": "questions",
    "alias": "សៀវភៅតម្លៃប៉ុន្មាន",
    "canonical": "price"
  },
  {
    "group": "questions",
    "alias": "សៀវភៅអីខ្លះអាចកក់បាន",
    "canonical": "books"
  },
  {
    "group": "questions",
    "alias": "អាចស៊ីញ៉េបានអត់",
    "canonical": "signature"
  }
]
$aliases$::jsonb;
begin
  v_snapshot := public.shadow_ai_local_knowledge_read_v1(null);
  if v_snapshot is null then
    raise exception 'SHADOW_AI_KNOWLEDGE_NOT_INSTALLED';
  end if;
  if (v_snapshot->>'version')::integer = 1 and v_snapshot->'aliases' = '[]'::jsonb then
    v_result := public.shadow_ai_local_knowledge_publish_v1(1, v_aliases, 'system-book-starter-v1', null);
    if coalesce((v_result->>'ok')::boolean, false) is not true then
      raise exception 'SHADOW_AI_BOOK_SEED_FAILED';
    end if;
  end if;
end;
$seed$;
commit;

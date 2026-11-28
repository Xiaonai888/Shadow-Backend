export const SHADOW_LOCAL_REPLY_VERSION = 'shadow-local-reply-v1'

const kinds = ['clarify','out_of_scope','missing','review','unavailable','stock_issue','signature_issue','books','price','stock','delivery','signature','schedule','requirements']
const packs = {
  km: [
    'សូមអភ័យទោស ខ្ញុំមិនទាន់យល់ច្បាស់ពីសំណើរបស់អ្នកទេ។ តើអ្នកចង់សួរព័ត៌មានសៀវភៅ ឬចង់កក់សៀវភៅ?',
    'ខ្ញុំអាចជួយអ្នកពាក់ព័ន្ធនឹងការកក់សៀវភៅរបស់អ្នកនិពន្ធនេះ។ តើមានព័ត៌មានអ្វីអំពីសៀវភៅដែលអ្នកចង់ដឹងទេ?',
    'អរគុណសម្រាប់ព័ត៌មានដែលអ្នកបានផ្ដល់។ សូមជួយបំពេញព័ត៌មានដែលនៅខ្វះខាងក្រោម ដើម្បីបន្តការកក់។',
    'ព័ត៌មានសម្រាប់ព្រាងការកក់របស់អ្នកគ្រប់គ្រាន់ហើយ។ សូមពិនិត្យព័ត៌មាន និងតម្លៃក្នុងផ្នែកផ្ទៀងផ្ទាត់ជាមុន។ នេះមិនមែនជាការកក់ឬការបង់ប្រាក់ដែលបានសម្រេចទេ។',
    'សូមអភ័យទោស ខ្ញុំមិនអាចបញ្ជាក់ព័ត៌មាននេះបាននៅពេលនេះទេ។ សូមពិនិត្យម្តងទៀត ឬទាក់ទងអ្នកនិពន្ធប្រសិនបើចាំបាច់។',
    'សូមអភ័យទោស ជម្រើសសៀវភៅ ឬចំនួនដែលអ្នកបានជ្រើសរើសមិនសមនឹងស្តុកបច្ចុប្បន្នទេ។ សូមពិនិត្យប្រភេទ និងចំនួនម្តងទៀត។',
    'សូមអភ័យទោស ជម្រើសសៀវភៅមានស៊ីញ៉េមិនអាចប្រើបានទេ។ តើអ្នកចង់ពិនិត្យជម្រើសមិនមានស៊ីញ៉េវិញទេ?',
    'ខ្ញុំរីករាយជួយអ្នក។ ខាងក្រោមនេះជាព័ត៌មានសៀវភៅដែលមានក្នុងកម្មវិធីបើកកក់នេះ។',
    'ខាងក្រោមនេះជាតម្លៃសៀវភៅតាមប្រភេទនីមួយៗ។ អ្នកអាចពិនិត្យ និងជ្រើសរើសប្រភេទដែលអ្នកចង់បាន។',
    'ខាងក្រោមនេះជាព័ត៌មានស្តុកដែលបានផ្ទៀងផ្ទាត់សម្រាប់សំណួរនេះ។ ចំនួនស្តុកអាចប្រែប្រួលមុនពេលការកក់ពិតត្រូវបានបញ្ជាក់។',
    'ខាងក្រោមនេះជាជម្រើសក្រុមហ៊ុនដឹកជញ្ជូន និងថ្លៃដឹក។ សូមជ្រើសរើសជម្រើសដែលសមស្របសម្រាប់អ្នក។',
    'ខាងក្រោមនេះជាព័ត៌មានអំពីជម្រើសស៊ីញ៉េរបស់កម្មវិធីបើកកក់នេះ។',
    'ខាងក្រោមនេះជាកាលវិភាគនៃកម្មវិធីបើកកក់។ សូមពិនិត្យកាលបរិច្ឆេទដែលបានបញ្ជាក់។',
    'ដើម្បីរៀបចំព្រាងការកក់ សូមពិនិត្យព័ត៌មានដែលត្រូវផ្ដល់ខាងក្រោម។ ខ្ញុំនឹងសួរបន្ថែមនៅពេលមានព័ត៌មានខ្វះ។',
  ],
  en: [
    'Sorry, I am not quite sure what you mean. Would you like information about a book or help preparing a pre-order?',
    'I can help with this author’s pre-orders. Is there anything about the books or booking process you would like to know?',
    'Thank you for the details. Please provide the remaining information shown below so we can continue preparing your pre-order.',
    'Your draft has the required information. Please review the details and price first. This is not a completed order or payment.',
    'Sorry, I cannot verify this information right now. Please check again or contact the author if needed.',
    'Sorry, your selected edition or quantity does not match the current stock. Please review your selection and quantity.',
    'Sorry, the signed-copy option is unavailable. Would you like to consider a copy without a signature?',
    'I am happy to help. Here are the books included in this pre-order.',
    'Here are the book prices by edition. Please review them and choose the edition you prefer.',
    'Here is the stock information verified for this question. Availability may change before an actual order is confirmed.',
    'Here are the delivery options and fees. Please choose the option that suits you.',
    'Here are the signature options for this pre-order.',
    'Here is the pre-order schedule. Please check the listed dates.',
    'Please review the required buyer information below. I will ask for any missing details as we prepare your draft.',
  ],
  zh: [
    '抱歉，我还不太确定您的意思。您是想了解书籍信息，还是需要协助预订？',
    '我可以协助您预订这位作者的书籍。您想了解哪些书籍或预订信息呢？',
    '感谢您提供的信息。请补充下方尚缺的资料，以便继续准备预订。',
    '预订草稿所需的信息已齐全。请先核对详情和价格。这并不代表订单或付款已经完成。',
    '抱歉，目前无法核实这些信息。请稍后重新查看，必要时可联系作者。',
    '抱歉，您选择的版本或数量与当前库存不符。请重新核对版本和数量。',
    '抱歉，目前无法选择签名本。您愿意考虑无签名版本吗？',
    '很高兴为您提供帮助。以下是本次预订活动中的书籍。',
    '以下是各版本的书籍价格。请查看并选择您喜欢的版本。',
    '以下是本次查询核实的库存信息。正式订单确认前，库存可能发生变化。',
    '以下是配送方式和费用。请选择适合您的方式。',
    '以下是本次预订活动的签名选项信息。',
    '以下是预订活动的时间安排。请查看列出的日期。',
    '请查看下方所需的买家信息。在准备草稿时，我会询问尚缺的信息。',
  ],
  ko: [
    '죄송하지만 요청을 정확히 이해하지 못했습니다. 도서 정보를 알고 싶으신가요, 아니면 예약 준비를 원하시나요?',
    '이 작가의 도서 예약을 도와드릴 수 있습니다. 도서나 예약 절차에 대해 궁금한 점이 있으신가요?',
    '정보를 알려 주셔서 감사합니다. 예약 준비를 계속할 수 있도록 아래의 누락된 정보를 입력해 주세요.',
    '예약 초안에 필요한 정보가 모두 준비되었습니다. 먼저 상세 내용과 가격을 확인해 주세요. 주문이나 결제가 완료된 것은 아닙니다.',
    '죄송합니다. 현재 이 정보를 확인할 수 없습니다. 다시 확인하시거나 필요한 경우 작가에게 문의해 주세요.',
    '죄송합니다. 선택하신 판형이나 수량이 현재 재고와 맞지 않습니다. 선택 항목과 수량을 다시 확인해 주세요.',
    '죄송합니다. 현재 사인본을 선택할 수 없습니다. 사인이 없는 도서를 고려해 보시겠어요?',
    '도와드리겠습니다. 아래는 이번 예약에 포함된 도서입니다.',
    '아래는 판형별 도서 가격입니다. 확인하신 후 원하는 판형을 선택해 주세요.',
    '아래는 이번 질문에 대해 확인된 재고 정보입니다. 실제 주문이 확정되기 전에 재고가 달라질 수 있습니다.',
    '아래는 배송 방법과 비용입니다. 적합한 방법을 선택해 주세요.',
    '아래는 이번 예약의 사인 관련 선택 사항입니다.',
    '아래는 예약 일정입니다. 표시된 날짜를 확인해 주세요.',
    '아래의 필수 구매자 정보를 확인해 주세요. 초안을 준비하는 동안 누락된 정보가 있으면 질문하겠습니다.',
  ],
  ja: [
    '申し訳ありませんが、ご希望をまだ正確に把握できていません。本の情報を知りたいですか、それとも予約の準備をご希望ですか？',
    'この著者の書籍予約をお手伝いできます。本や予約方法について知りたいことはありますか？',
    '情報をお知らせいただきありがとうございます。予約準備を続けるため、下に表示された不足情報をご入力ください。',
    '予約の下書きに必要な情報が揃いました。まず内容と価格をご確認ください。注文や決済が完了したわけではありません。',
    '申し訳ありません。現在この情報を確認できません。再度ご確認いただくか、必要に応じて著者にお問い合わせください。',
    '申し訳ありません。選択した版または数量が現在の在庫状況と合っていません。選択内容と数量をご確認ください。',
    '申し訳ありません。現在サイン入りの本は選択できません。サインなしの本をご検討されますか？',
    'お手伝いいたします。こちらが今回の予約対象の書籍です。',
    'こちらが版ごとの書籍価格です。ご確認のうえ、ご希望の版をお選びください。',
    'こちらが今回の質問について確認した在庫情報です。実際の注文が確定するまでに在庫が変動する場合があります。',
    'こちらが配送方法と料金です。ご都合に合う方法をお選びください。',
    'こちらが今回の予約に関するサインの選択肢です。',
    'こちらが予約の日程です。記載された日付をご確認ください。',
    '下に表示された購入者の必要情報をご確認ください。下書きの準備中に不足情報があればお尋ねします。',
  ],
}
const alternatives = {
  km: { clarify: 'សូមជួយបញ្ជាក់បន្តិចបានទេ? ខ្ញុំចង់យល់ឱ្យបានច្បាស់ថាអ្នកកំពុងសួរព័ត៌មាន ឬចង់រៀបចំការកក់។', missing: 'ខ្ញុំបានទទួលសំណើរបស់អ្នកហើយ។ ដើម្បីរៀបចំព្រាងការកក់ឱ្យបានត្រឹមត្រូវ សូមបំពេញតែព័ត៌មានដែលនៅខ្វះខាងក្រោម។' },
  en: { clarify: 'Could you clarify what you would like to do? I can help you check book information or prepare a pre-order.', missing: 'I understand your request. To prepare your draft accurately, please fill in only the missing details listed below.' },
  zh: { clarify: '可以请您再说明一下吗？我可以帮您查询书籍信息或准备预订。', missing: '我已了解您的请求。为了准确准备预订草稿，请仅补充下方缺少的信息。' },
  ko: { clarify: '어떤 도움이 필요하신지 조금 더 알려 주시겠어요? 도서 정보 확인이나 예약 준비를 도와드릴 수 있습니다.', missing: '요청을 이해했습니다. 정확한 예약 초안을 준비할 수 있도록 아래의 부족한 정보만 입력해 주세요.' },
  ja: { clarify: 'もう少し詳しく教えていただけますか？本の情報の確認や予約の準備をお手伝いできます。', missing: 'ご希望を承りました。正確な下書きを準備するため、下に表示された不足情報のみご入力ください。' },
}

export function normalizeShadowReplyLanguage(locale) {
  if (typeof locale !== 'string' || locale.length > 32) return 'km'
  const key = locale.trim().toLowerCase().split(/[-_]/u)[0]
  if (key === 'kh') return 'km'
  return Object.hasOwn(packs, key) ? key : 'en'
}

export function readShadowLocalReply(kind, locale, variant = 0) {
  const language = normalizeShadowReplyLanguage(locale)
  const index = kinds.indexOf(kind)
  const safeKind = index === -1 ? 'unavailable' : kind
  const alternate = Number.isSafeInteger(variant) && variant >= 0 && variant % 2 === 1 ? alternatives[language][safeKind] : null
  return { language, text: alternate ?? packs[language][kinds.indexOf(safeKind)] }
}

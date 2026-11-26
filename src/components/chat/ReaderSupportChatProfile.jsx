import { useEffect, useMemo, useState } from 'react'
import { BadgeCheck, Bell, BellOff, ChevronLeft, ChevronRight, Ellipsis, Image, LoaderCircle, Search, ShieldCheck, UserRound, X } from 'lucide-react'
import ChatAppearanceInfoRow from './ChatAppearanceInfoRow'
import SupportChatPrivateImage from './SupportChatPrivateImage'
import { chatThemeAccount } from '../../services/chatStoryThemes'
import { registerTranslationNamespace } from '../../i18n/registerTranslations'
import { useDisplayTranslation } from '../../utils/displayLanguage'
import { SUPPORT_MUTE_EVENT, isSupportMuted, readSupportMute, saveSupportMute, searchSupportHistory, supportMediaEntries } from './supportChatProfileModel'

registerTranslationNamespace('supportChatProfile', {
  en: { title: 'Chat info', profile: 'Profile', search: 'Search', mute: 'Mute', unmute: 'Unmute', options: 'Options', privacy: 'Privacy & safety', media: 'Shared media', seeAll: 'See all', empty: 'No shared media in loaded messages', official: 'Official Shadow Support', private: 'This conversation is private. Only authorized support staff can access it. Personal staff profiles are not shown.', searchPlaceholder: 'Search messages', noResults: 'No matching messages in loaded history.', older: 'Load earlier messages', close: 'Close', back: 'Back', retry: 'Retry', image: 'Image', refresh: 'Refresh chat', muteNote: 'Save a mute preference on this device. Unread messages remain visible.', hour: '1 hour', eight: '8 hours', day: '1 day', week: '7 days', forever: 'Until turned off', saveError: 'Could not save settings.', blocked: 'Messaging is restricted by Shadow Support.', archived: 'This conversation is archived.', unavailable: 'Start a conversation first.', showMore: 'Show more results' },
  km: { title: 'ព័ត៌មានឆាត', profile: 'Profile', search: 'ស្វែងរក', mute: 'បិទសំឡេង', unmute: 'បើកសំឡេង', options: 'ជម្រើស', privacy: 'ឯកជនភាព និងសុវត្ថិភាព', media: 'រូបភាពដែលបានចែករំលែក', seeAll: 'មើលទាំងអស់', empty: 'មិនមានរូបភាពក្នុងសារដែលបានផ្ទុក', official: 'ក្រុមជំនួយផ្លូវការ Shadow', private: 'ការសន្ទនានេះជាឯកជន។ មានតែបុគ្គលិកជំនួយដែលមានសិទ្ធិប៉ុណ្ណោះអាចចូលមើលបាន។ មិនបង្ហាញ Profile ផ្ទាល់ខ្លួនរបស់បុគ្គលិកទេ។', searchPlaceholder: 'ស្វែងរកសារ', noResults: 'មិនមានសារដែលត្រូវគ្នាក្នុងប្រវត្តិដែលបានផ្ទុក។', older: 'ផ្ទុកសារចាស់ៗ', close: 'បិទ', back: 'ត្រឡប់ក្រោយ', retry: 'ព្យាយាមម្ដងទៀត', image: 'រូបភាព', refresh: 'ផ្ទុកឆាតថ្មី', muteNote: 'រក្សាទុកការកំណត់បិទសំឡេងលើឧបករណ៍នេះ។ សារមិនទាន់អាននៅតែបង្ហាញ។', hour: '១ ម៉ោង', eight: '៨ ម៉ោង', day: '១ ថ្ងៃ', week: '៧ ថ្ងៃ', forever: 'រហូតដល់បើកវិញ', saveError: 'មិនអាចរក្សាទុកការកំណត់បានទេ។', blocked: 'Shadow Support បានកំណត់ការផ្ញើសារ។', archived: 'ការសន្ទនានេះត្រូវបានរក្សាទុកក្នុង Archive។', unavailable: 'សូមចាប់ផ្តើមការសន្ទនាសិន។', showMore: 'បង្ហាញបន្ថែម' },
  zh: { title: '聊天信息', profile: '资料', search: '搜索', mute: '静音', unmute: '取消静音', options: '选项', privacy: '隐私与安全', media: '共享媒体', seeAll: '查看全部', empty: '已加载消息中没有共享媒体', official: 'Shadow 官方客服', private: '这是私人对话。仅授权客服人员可访问。不显示工作人员的个人资料。', searchPlaceholder: '搜索消息', noResults: '已加载历史记录中没有匹配消息。', older: '加载更早的消息', close: '关闭', back: '返回', retry: '重试', image: '图片', refresh: '刷新聊天', muteNote: '在此设备上保存静音偏好。未读消息仍然可见。', hour: '1 小时', eight: '8 小时', day: '1 天', week: '7 天', forever: '直到关闭', saveError: '无法保存设置。', blocked: 'Shadow 客服已限制发消息。', archived: '此对话已归档。', unavailable: '请先开始对话。', showMore: '显示更多结果' },
  ja: { title: 'チャット情報', profile: 'プロフィール', search: '検索', mute: 'ミュート', unmute: 'ミュート解除', options: 'オプション', privacy: 'プライバシーと安全', media: '共有メディア', seeAll: 'すべて見る', empty: '読み込まれたメッセージに共有メディアがありません', official: 'Shadow 公式サポート', private: 'この会話は非公開です。権限のあるサポート担当者のみがアクセスできます。担当者の個人プロフィールは表示されません。', searchPlaceholder: 'メッセージを検索', noResults: '読み込まれた履歴に一致するメッセージがありません。', older: '以前のメッセージを読み込む', close: '閉じる', back: '戻る', retry: '再試行', image: '画像', refresh: 'チャットを更新', muteNote: 'この端末にミュート設定を保存します。未読メッセージは表示されます。', hour: '1 時間', eight: '8 時間', day: '1 日', week: '7 日', forever: '解除するまで', saveError: '設定を保存できませんでした。', blocked: 'Shadow サポートにより送信が制限されています。', archived: 'この会話はアーカイブされています。', unavailable: '先に会話を開始してください。', showMore: 'さらに表示' },
  ko: { title: '채팅 정보', profile: '프로필', search: '검색', mute: '음소거', unmute: '음소거 해제', options: '옵션', privacy: '개인정보 및 안전', media: '공유 미디어', seeAll: '모두 보기', empty: '불러온 메시지에 공유 미디어가 없습니다', official: 'Shadow 공식 지원팀', private: '이 대화는 비공개입니다. 권한이 있는 지원 담당자만 접근할 수 있습니다. 담당자의 개인 프로필은 표시되지 않습니다.', searchPlaceholder: '메시지 검색', noResults: '불러온 기록에 일치하는 메시지가 없습니다.', older: '이전 메시지 불러오기', close: '닫기', back: '뒤로', retry: '다시 시도', image: '이미지', refresh: '채팅 새로고침', muteNote: '이 기기에 음소거 설정을 저장합니다. 읽지 않은 메시지는 계속 표시됩니다.', hour: '1시간', eight: '8시간', day: '1일', week: '7일', forever: '해제할 때까지', saveError: '설정을 저장하지 못했습니다.', blocked: 'Shadow 지원팀이 메시지 전송을 제한했습니다.', archived: '이 대화는 보관되었습니다.', unavailable: '먼저 대화를 시작하세요.', showMore: '더 보기' },
})

const LOGO = '/assets/Icons/Logo%20Shadow%203.png'
const DURATIONS = [['1h', 'hour'], ['8h', 'eight'], ['1d', 'day'], ['7d', 'week'], ['forever', 'forever']]

function Action({ icon: Icon, label, onClick, disabled }) {
  return <button type="button" onClick={onClick} disabled={disabled} className="flex min-w-0 flex-col items-center gap-2 rounded-xl py-3 text-center disabled:opacity-40"><Icon size={23} strokeWidth={2} /><span className="text-[12px] font-normal">{label}</span></button>
}

function Row({ icon: Icon, title, onClick }) {
  return <button type="button" onClick={onClick} className="flex min-h-[58px] w-full items-center gap-4 px-1 text-left"><span className="flex h-9 w-9 shrink-0 items-center justify-center"><Icon size={22} strokeWidth={1.9} /></span><span className="min-w-0 flex-1 text-[14px] font-normal">{title}</span><ChevronRight size={17} className="mr-2 text-[var(--shadow-text-tertiary)]" /></button>
}

export default function ReaderSupportChatProfile({ conversationId, messages = [], hasMore, olderLoading, error, blocked, archived, onLoadOlder, onJump, onRefresh, onClose }) {
  const { t } = useDisplayTranslation()
  const tr = key => t(`supportChatProfile.${key}`)
  const account = chatThemeAccount()
  const [panel, setPanel] = useState('')
  const [query, setQuery] = useState('')
  const [visibleCount, setVisibleCount] = useState(20)
  const [mediaTarget, setMediaTarget] = useState('')
  const [muteUntil, setMuteUntil] = useState(() => readSupportMute(account, conversationId))
  const [saveError, setSaveError] = useState(false)
  const muted = isSupportMuted(muteUntil)
  const media = useMemo(() => supportMediaEntries(messages), [messages])
  const results = useMemo(() => searchSupportHistory(messages, query), [messages, query])
  const activeMedia = media.find(item => item.id === mediaTarget)
  const labels = { image: tr('image'), retry: tr('retry'), close: tr('close') }

  useEffect(() => {
    const sync = () => setMuteUntil(readSupportMute(account, conversationId))
    sync()
    window.addEventListener('storage', sync)
    window.addEventListener('focus', sync)
    window.addEventListener(SUPPORT_MUTE_EVENT, sync)
    return () => { window.removeEventListener('storage', sync); window.removeEventListener('focus', sync); window.removeEventListener(SUPPORT_MUTE_EVENT, sync) }
  }, [account, conversationId])

  useEffect(() => {
    if (muteUntil <= 0) return
    const timer = window.setTimeout(() => setMuteUntil(readSupportMute(account, conversationId)), Math.min(2147483647, Math.max(1, muteUntil - Date.now() + 10)))
    return () => window.clearTimeout(timer)
  }, [muteUntil, account, conversationId])

  function setMute(duration) {
    setSaveError(false)
    try {
      if (chatThemeAccount() !== account) throw new Error('Account changed')
      const until = saveSupportMute(account, conversationId, duration)
      setMuteUntil(until)
      window.dispatchEvent(new CustomEvent(SUPPORT_MUTE_EVENT))
      setPanel('')
    } catch { setSaveError(true) }
  }

  function openPanel(name) { setVisibleCount(name === 'media' ? 10 : 20); setSaveError(false); setPanel(name) }
  function back() { if (mediaTarget) setMediaTarget(''); else if (panel) setPanel(''); else onClose() }
  const identity = <div className="flex flex-col items-center gap-2 py-6"><img src={LOGO} alt="Shadow Admin" className="h-[88px] w-[88px] rounded-full border border-[var(--shadow-border)] object-cover" /><div className="flex items-center gap-1.5 text-[20px] font-semibold">Shadow Admin<BadgeCheck size={18} className="text-blue-500" /></div><p className="text-[12px] text-[var(--shadow-text-secondary)]">{tr('official')}</p></div>
  const older = hasMore && <button type="button" disabled={olderLoading} onClick={onLoadOlder} className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--shadow-bg-soft)] px-3 py-3 text-[12px] disabled:opacity-50">{olderLoading && <LoaderCircle size={16} className="animate-spin" />}{tr('older')}</button>
  const tiles = items => <div className="grid grid-cols-3 gap-2">{items.map(item => item.private ? <div key={item.id} className="aspect-square min-w-0 overflow-hidden rounded-xl bg-[var(--shadow-bg-soft)] [&>div]:!m-0 [&>div]:!w-full [&>div]:!h-full [&_button]:!h-full [&_button]:!min-h-0 [&_img]:!h-full [&_img]:!max-h-none [&_img]:!object-cover"><SupportChatPrivateImage messageId={item.messageId} labels={labels} /></div> : <button type="button" key={item.id} onClick={() => setMediaTarget(item.id)} aria-label={tr('image')} className="aspect-square min-w-0 overflow-hidden rounded-xl bg-[var(--shadow-bg-soft)]"><img src={item.url} alt={tr('image')} loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-cover" /></button>)}</div>

  return <div className="fixed inset-0 z-[165] flex min-h-0 flex-col bg-[var(--shadow-bg-surface)] text-[var(--shadow-text-primary)]" role="dialog" aria-modal="true" aria-label={tr('title')}>
    <header className="flex h-[calc(56px+env(safe-area-inset-top,0px))] shrink-0 items-center gap-2 px-3 pt-[env(safe-area-inset-top,0px)]"><button type="button" onClick={back} aria-label={tr('back')} className="flex h-10 w-10 items-center justify-center rounded-full"><ChevronLeft size={24} /></button>{panel && <h2 className="text-[16px] font-semibold">{tr(panel)}</h2>}</header>
    <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[calc(24px+env(safe-area-inset-bottom,0px))]"><div className="mx-auto max-w-[560px] px-5">
      {!panel && <>{identity}<div className="grid grid-cols-4 gap-1 border-b border-[var(--shadow-border)] pb-4"><Action icon={UserRound} label={tr('profile')} onClick={() => openPanel('profile')} /><Action icon={Search} label={tr('search')} onClick={() => openPanel('search')} /><Action icon={muted ? BellOff : Bell} label={tr(muted ? 'unmute' : 'mute')} disabled={!conversationId} onClick={() => openPanel('mute')} /><Action icon={Ellipsis} label={tr('options')} onClick={() => openPanel('options')} /></div><div className="py-2">{conversationId ? <ChatAppearanceInfoRow conversationId={conversationId} scope="support" accountId={account} /> : <p className="px-2 py-3 text-[12px] text-[var(--shadow-text-secondary)]">{tr('unavailable')}</p>}<Row icon={ShieldCheck} title={tr('privacy')} onClick={() => openPanel('privacy')} /></div><div className="mt-5 flex items-center justify-between"><h2 className="text-[15px] font-semibold">{tr('media')}</h2><button type="button" onClick={() => openPanel('media')} className="px-1 py-2 text-[12px] text-[var(--shadow-text-secondary)]">{tr('seeAll')}</button></div>{media.length ? tiles(media.slice(0, 3)) : <div className="mt-2 flex items-center gap-3 rounded-xl bg-[var(--shadow-bg-soft)] px-4 py-5 text-[12px] text-[var(--shadow-text-secondary)]"><Image size={23} />{tr('empty')}</div>}</>}
      {panel === 'profile' && <>{identity}<p className="rounded-xl bg-[var(--shadow-bg-soft)] p-4 text-[13px] leading-6">{tr('private')}</p></>}
      {panel === 'privacy' && <><p className="rounded-xl bg-[var(--shadow-bg-soft)] p-4 text-[13px] leading-6">{tr('private')}</p>{blocked && <p className="mt-3 text-[13px] text-amber-600">{tr('blocked')}</p>}{archived && <p className="mt-3 text-[13px] text-amber-600">{tr('archived')}</p>}</>}
      {panel === 'options' && <button type="button" onClick={onRefresh} className="w-full rounded-xl bg-[var(--shadow-bg-soft)] p-4 text-left text-[14px]">{tr('refresh')}</button>}
      {panel === 'mute' && <><p className="mb-4 text-[13px] leading-6 text-[var(--shadow-text-secondary)]">{tr('muteNote')}</p>{muted && <button type="button" onClick={() => setMute('off')} className="mb-2 w-full rounded-xl bg-[var(--shadow-bg-soft)] px-4 py-3 text-left text-[14px]">{tr('unmute')}</button>}{DURATIONS.map(([duration, label]) => <button type="button" key={duration} onClick={() => setMute(duration)} className="block w-full border-b border-[var(--shadow-border)] px-4 py-4 text-left text-[14px]">{tr(label)}</button>)}{saveError && <p role="alert" className="mt-3 text-[12px] text-red-600">{tr('saveError')}</p>}</>}
      {panel === 'search' && <><div className="flex items-center gap-2 rounded-full bg-[var(--shadow-bg-soft)] px-4 py-2"><Search size={18} /><input value={query} onChange={event => { setQuery(event.target.value.slice(0, 200)); setVisibleCount(20) }} placeholder={tr('searchPlaceholder')} aria-label={tr('searchPlaceholder')} className="min-w-0 flex-1 bg-transparent py-2 text-[14px] outline-none" /><button type="button" aria-label={tr('close')} onClick={() => setQuery('')}><X size={18} /></button></div>{query.trim() && <>{results.slice(0, visibleCount).map(item => <button key={item.id} type="button" onClick={() => onJump(item.id)} className="block w-full border-b border-[var(--shadow-border)] px-2 py-3 text-left"><span className="line-clamp-3 break-words text-[13px]">{item.message_text}</span><span className="mt-1 block text-[11px] text-[var(--shadow-text-secondary)]">{new Date(item.created_at).toLocaleString()}</span></button>)}{!results.length && <p className="py-5 text-center text-[12px] text-[var(--shadow-text-secondary)]">{tr('noResults')}</p>}{results.length > visibleCount && <button type="button" onClick={() => setVisibleCount(n => n + 20)} className="w-full py-3 text-[13px]">{tr('showMore')}</button>}{older}</>}</>}
      {panel === 'media' && <>{media.length ? tiles(media.slice(0, visibleCount)) : <p className="py-5 text-center text-[12px] text-[var(--shadow-text-secondary)]">{tr('empty')}</p>}{media.length > visibleCount && <button type="button" onClick={() => setVisibleCount(n => n + 10)} className="w-full py-3 text-[13px]">{tr('showMore')}</button>}{older}</>}
      {error && (panel === 'search' || panel === 'media') && <p role="alert" className="mt-3 text-[12px] text-red-600">{error}</p>}
    </div></main>
    {activeMedia && <div className="absolute inset-0 z-10 flex flex-col bg-[var(--shadow-bg-surface)]"><header className="flex h-14 shrink-0 items-center gap-2 px-3"><button type="button" onClick={() => setMediaTarget('')} aria-label={tr('back')} className="rounded-full p-2"><ChevronLeft size={24} /></button>{tr('image')}</header><div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-4">{activeMedia.private ? <SupportChatPrivateImage key={activeMedia.id} messageId={activeMedia.messageId} labels={labels} /> : <img src={activeMedia.url} alt={tr('image')} referrerPolicy="no-referrer" className="max-h-[80dvh] max-w-full rounded-xl object-contain" />}</div></div>}
  </div>
}

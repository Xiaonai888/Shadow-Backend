import { useEffect, useRef, useState } from 'react'
import { useDisplayTranslation } from '../../utils/displayLanguage'
import { drawStudioMangaBalloon, normalizeStudioMangaBalloonOptions } from './StudioMangaBalloonRenderer'

const TEXT = {
  en: ['Manga balloon tool', 'Preview', 'Shape', 'Ellipse', 'Rounded', 'Thought', 'Shout', 'Tail', 'None', 'Bottom', 'Top', 'Left', 'Right', 'Width', 'Height', 'Border', 'Fill', 'Outline', 'Text color', 'Opacity', 'Dialogue (optional)', 'Font', 'Sans serif', 'Serif', 'Monospace', 'Font size', 'Bold', 'Italic', 'Align', 'Add balloon', 'Select an editable layer before placing a balloon.', 'Manga balloon is not connected to the canvas yet.', 'The balloon could not be added.', 'Bubble settings', 'Text settings', 'This is a local preview. Save the design and connect this tool to the active layer later.', 'Left', 'Center', 'Right'],
  km: ['ឧបករណ៍ពពុះសន្ទនា Manga', 'មើលជាមុន', 'ទម្រង់', 'រាងពងក្រពើ', 'ជ្រុងមូល', 'ពពុះគំនិត', 'ពពុះស្រែក', 'កន្ទុយ', 'គ្មាន', 'ក្រោម', 'លើ', 'ឆ្វេង', 'ស្ដាំ', 'ទទឹង', 'កម្ពស់', 'កម្រាស់ស៊ុម', 'ពណ៌ផ្ទៃ', 'ពណ៌ស៊ុម', 'ពណ៌អក្សរ', 'ភាពស្រអាប់', 'អត្ថបទសន្ទនា (មិនបង្ខំ)', 'ពុម្ពអក្សរ', 'អក្សរធម្មតា', 'អក្សរស៊េរីហ្វ', 'អក្សរម៉ូណូ', 'ទំហំអក្សរ', 'ដិត', 'ទ្រេត', 'តម្រឹម', 'ដាក់ពពុះសន្ទនា', 'សូមជ្រើស Layer ដែលអាចកែប្រែបានមុនដាក់ពពុះសន្ទនា។', 'Tool នេះមិនទាន់បានភ្ជាប់ទៅ Canvas ទេ។', 'មិនអាចដាក់ពពុះសន្ទនាបានទេ។', 'ការកំណត់ពពុះ', 'ការកំណត់អក្សរ', 'នេះជារូបមើលជាមុនក្នុងឧបករណ៍។ យើងនឹងភ្ជាប់ទៅ Layer ដែលបានជ្រើសនៅពេលក្រោយ។', 'ឆ្វេង', 'កណ្ដាល', 'ស្ដាំ'],
  zh: ['漫画气泡工具', '预览', '形状', '椭圆', '圆角', '思考', '喊叫', '尾巴', '无', '下', '上', '左', '右', '宽度', '高度', '边框', '填充', '描边颜色', '文字颜色', '不透明度', '对话文字（可选）', '字体', '无衬线', '衬线', '等宽', '字号', '粗体', '斜体', '对齐', '添加气泡', '请先选择可编辑的图层。', '气泡工具尚未连接画布。', '无法添加气泡。', '气泡设置', '文字设置', '这是本地预览。稍后再连接到当前图层。', '左', '居中', '右'],
  ja: ['マンガ吹き出しツール', 'プレビュー', '形状', '楕円', '角丸', '思考', '叫び', 'しっぽ', 'なし', '下', '上', '左', '右', '幅', '高さ', '枠線', '塗り', '線の色', '文字色', '不透明度', '台詞（任意）', 'フォント', 'サンセリフ', 'セリフ', '等幅', '文字サイズ', '太字', '斜体', '整列', '吹き出しを追加', '編集可能なレイヤーを選択してください。', 'まだキャンバスには接続されていません。', '吹き出しを追加できませんでした。', '吹き出し設定', '文字設定', 'これはローカルプレビューです。現在のレイヤーへの接続は後で行います。', '左', '中央', '右'],
  ko: ['만화 말풍선 도구', '미리보기', '모양', '타원', '둥근 모서리', '생각', '외침', '꼬리', '없음', '아래', '위', '왼쪽', '오른쪽', '너비', '높이', '테두리', '채우기', '테두리 색', '글자 색', '불투명도', '대사(선택)', '글꼴', '산세리프', '세리프', '고정폭', '글자 크기', '굵게', '기울임', '정렬', '말풍선 추가', '편집 가능한 레이어를 먼저 선택하세요.', '아직 캔버스에 연결되지 않았습니다.', '말풍선을 추가할 수 없습니다.', '말풍선 설정', '글자 설정', '로컬 미리보기입니다. 현재 레이어와의 연결은 나중에 진행합니다.', '왼쪽', '가운데', '오른쪽'],
}
const SHAPES = [['ellipse', 3], ['rounded', 4], ['thought', 5], ['shout', 6]]
const TAILS = [['none', 8], ['bottom', 9], ['top', 10], ['left', 11], ['right', 12]]
const FONTS = [['sans', 22], ['serif', 23], ['mono', 24]]
const DEFAULT = { shape: 'ellipse', tail: 'bottom', width: 240, height: 160, border: 4, fill: '#FFFFFF', ink: '#111111', textColor: '#111111', opacity: 100, text: '', font: 'sans', fontSize: 24, bold: false, italic: false, align: 'center' }

function Numeric({ label, name, value, min, max, onUpdate }) {
  return <label className="ss-manga-balloon-field"><span>{label}</span><input type="number" name={name} min={min} max={max} step="1" value={value} onChange={(event) => onUpdate(name, Number(event.target.value))} /></label>
}

export default function StudioMangaBalloonTool({ onApply, disabled = false, color = '#111111' }) {
  const { language } = useDisplayTranslation()
  const t = TEXT[language] || TEXT.en
  const [options, setOptions] = useState(() => ({ ...DEFAULT, ink: color, textColor: color }))
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const canvasRef = useRef(null)
  const update = (key, value) => {
    setMessage('')
    setOptions((current) => ({ ...current, [key]: value }))
  }
  const previewWidth = 520
  const previewHeight = 340

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const logicalWidth = Math.max(600, options.width + 150)
    const logicalHeight = Math.max(420, options.height + 150)
    const scale = Math.min(previewWidth / logicalWidth, previewHeight / logicalHeight)
    try {
      const preview = document.createElement('canvas')
      preview.width = logicalWidth
      preview.height = logicalHeight
      const previewCtx = preview.getContext('2d')
      if (!previewCtx) throw new Error('Canvas preview is unavailable.')
      drawStudioMangaBalloon(previewCtx, null, options)
      ctx.drawImage(preview, (previewWidth - logicalWidth * scale) / 2, (previewHeight - logicalHeight * scale) / 2, logicalWidth * scale, logicalHeight * scale)
      setMessage('')
    } catch (error) {
      setMessage(error.message || t[32])
    }
  }, [options, t])

  async function submit(event) {
    event.preventDefault()
    if (disabled || busy || typeof onApply !== 'function') return
    let normalized
    try { normalized = normalizeStudioMangaBalloonOptions(options) }
    catch (error) { setMessage(error.message || t[32]); return }
    setBusy(true)
    setMessage('')
    try { await onApply(normalized) }
    catch (error) { setMessage(error?.message || t[32]) }
    finally { setBusy(false) }
  }

  return <section className="ss-manga-balloon-tool" aria-label={t[0]}>
    <style>{`
      .ss-manga-balloon-tool{min-width:0;color:#e9f2fb;font:inherit}
      .ss-manga-balloon-tool *{box-sizing:border-box}
      .ss-manga-balloon-tool h2{font-size:17px;margin:0 0 13px}
      .ss-manga-balloon-tool h3{font-size:13px;margin:0 0 12px;color:#d8eafa}
      .ss-manga-balloon-preview{max-width:520px;margin:0 auto 14px;border:1px solid #50667c;border-radius:8px;overflow:hidden;background-color:#f3f5f8;background-image:linear-gradient(45deg,#cdd5df 25%,transparent 25%),linear-gradient(-45deg,#cdd5df 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#cdd5df 75%),linear-gradient(-45deg,transparent 75%,#cdd5df 75%);background-size:18px 18px;background-position:0 0,0 9px,9px -9px,-9px 0}
      .ss-manga-balloon-preview canvas{display:block;width:100%;height:auto}
      .ss-manga-balloon-help{font-size:11px;line-height:1.5;color:#b9cee0;margin:4px 0 12px}
      .ss-manga-balloon-tool fieldset{min-width:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:0 0 12px;padding:12px;border:1px solid #51677e;border-radius:8px}
      .ss-manga-balloon-tool legend{padding:0 6px;font-size:13px;font-weight:700}
      .ss-manga-balloon-field{display:grid;min-width:0;gap:5px;font-size:11px}
      .ss-manga-balloon-field input:not([type=checkbox]),.ss-manga-balloon-field select,.ss-manga-balloon-field textarea{width:100%;min-width:0;min-height:36px;border:1px solid #627a93;border-radius:5px;background:#203042;color:#f1f6fc;padding:6px;font:inherit}
      .ss-manga-balloon-field input[type=color]{padding:2px;cursor:pointer}
      .ss-manga-balloon-wide{grid-column:1/-1}
      .ss-manga-balloon-check{display:flex;align-items:center;gap:8px;font-size:12px}
      .ss-manga-balloon-check input{width:17px;height:17px;accent-color:#87baff}
      .ss-manga-balloon-tool button[type=submit]{width:100%;min-height:40px;border:1px solid #87bdfa;border-radius:6px;background:#376fa9;color:#fff;font:inherit;font-weight:700;cursor:pointer}
      .ss-manga-balloon-tool button:disabled{opacity:.45;cursor:not-allowed}
      .ss-manga-balloon-error{color:#ffd0d0;font-size:12px;line-height:1.5}
      @media(max-width:400px){.ss-manga-balloon-tool fieldset{grid-template-columns:minmax(0,1fr)}}
    `}</style>
    <h2>{t[0]}</h2>
    <h3>{t[1]}</h3>
    <div className="ss-manga-balloon-preview"><canvas ref={canvasRef} width={previewWidth} height={previewHeight} aria-label={t[1]} /></div>
    <p className="ss-manga-balloon-help">{t[35]}</p>
    <form onSubmit={submit}>
      <fieldset><legend>{t[33]}</legend>
        <label className="ss-manga-balloon-field"><span>{t[2]}</span><select value={options.shape} onChange={(event) => update('shape', event.target.value)}>{SHAPES.map(([id, label]) => <option key={id} value={id}>{t[label]}</option>)}</select></label>
        <label className="ss-manga-balloon-field"><span>{t[7]}</span><select value={options.tail} onChange={(event) => update('tail', event.target.value)}>{TAILS.map(([id, label]) => <option key={id} value={id}>{t[label]}</option>)}</select></label>
        <Numeric label={t[13]} name="width" value={options.width} min={80} max={1600} onUpdate={update} />
        <Numeric label={t[14]} name="height" value={options.height} min={60} max={1200} onUpdate={update} />
        <Numeric label={t[15]} name="border" value={options.border} min={1} max={30} onUpdate={update} />
        <Numeric label={`${t[19]} (%)`} name="opacity" value={options.opacity} min={1} max={100} onUpdate={update} />
        <label className="ss-manga-balloon-field"><span>{t[16]}</span><input type="color" value={options.fill} onChange={(event) => update('fill', event.target.value)} /></label>
        <label className="ss-manga-balloon-field"><span>{t[17]}</span><input type="color" value={options.ink} onChange={(event) => update('ink', event.target.value)} /></label>
      </fieldset>
      <fieldset><legend>{t[34]}</legend>
        <label className="ss-manga-balloon-field ss-manga-balloon-wide"><span>{t[20]}</span><textarea rows={3} maxLength={1200} value={options.text} onChange={(event) => update('text', event.target.value)} /></label>
        <label className="ss-manga-balloon-field"><span>{t[21]}</span><select value={options.font} onChange={(event) => update('font', event.target.value)}>{FONTS.map(([id, label]) => <option key={id} value={id}>{t[label]}</option>)}</select></label>
        <Numeric label={t[25]} name="fontSize" value={options.fontSize} min={8} max={160} onUpdate={update} />
        <label className="ss-manga-balloon-field"><span>{t[18]}</span><input type="color" value={options.textColor} onChange={(event) => update('textColor', event.target.value)} /></label>
        <label className="ss-manga-balloon-field"><span>{t[28]}</span><select value={options.align} onChange={(event) => update('align', event.target.value)}>{[['left',36],['center',37],['right',38]].map(([id, label]) => <option key={id} value={id}>{t[label]}</option>)}</select></label>
        <label className="ss-manga-balloon-check"><input type="checkbox" checked={options.bold} onChange={(event) => update('bold', event.target.checked)} />{t[26]}</label>
        <label className="ss-manga-balloon-check"><input type="checkbox" checked={options.italic} onChange={(event) => update('italic', event.target.checked)} />{t[27]}</label>
      </fieldset>
      {message ? <p className="ss-manga-balloon-error" role="alert">{message}</p> : null}
      {!onApply ? <p className="ss-manga-balloon-help">{t[31]}</p> : null}
      <button type="submit" disabled={disabled || busy || typeof onApply !== 'function'}>{t[29]}</button>
    </form>
  </section>
}

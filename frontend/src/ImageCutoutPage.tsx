import { useMemo, useRef, useState } from 'react'
import { downloadUrl, imageCutout } from './api'

type CutoutResult = {
  id: string
  preview_url: string
  alpha_url: string
  zip_url: string
  sheet_url?: string
  report_url?: string
  width: number
  height: number
  files_processed: number
  regions: Array<{ name: string; x: number; y: number; w: number; h: number; area: number; url?: string }>
  outputs: Array<{ name: string; url: string; size_bytes: number }>
}

type ViewMode = 'result' | 'alpha' | 'sheet'
type PointMode = 'sample' | 'erase' | 'keep'
type AnnotPoint = { x: number; y: number; radius?: number; kind?: string }

const defaultModes = [
  { value: 'auto', label: '自动检测背景' },
  { value: 'samples', label: '多点采样' },
  { value: 'white', label: '白底抠图' },
  { value: 'black', label: '黑底抠图' },
  { value: 'color', label: '指定纯色' },
  { value: 'alpha', label: '保留透明通道' },
]

function formatSize(size: number) {
  if (!size) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = size
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index++
  }
  return `${value.toFixed(index ? 1 : 0)} ${units[index]}`
}

function readFilePreview(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function markerClass(kind: string) {
  if (kind === 'erase') return 'erase'
  if (kind === 'keep') return 'keep'
  return 'sample'
}

export function ImageCutoutPage() {
  const [files, setFiles] = useState<File[]>([])
  const [sourcePreview, setSourcePreview] = useState('')
  const [sourceSize, setSourceSize] = useState({ width: 0, height: 0 })
  const imageRef = useRef<HTMLImageElement | null>(null)
  const [samplePoints, setSamplePoints] = useState<AnnotPoint[]>([])
  const [erasePoints, setErasePoints] = useState<AnnotPoint[]>([])
  const [keepPoints, setKeepPoints] = useState<AnnotPoint[]>([])
  const [pointMode, setPointMode] = useState<PointMode>('sample')
  const [result, setResult] = useState<CutoutResult | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('result')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState({
    mode: 'samples',
    key_color: '#ffffff',
    tolerance: 30,
    softness: 6,
    erode: 0,
    dilate: 0,
    edge_protect: true,
    decontaminate: 0.92,
    close_gaps: 2,
    trim: true,
    split_assets: true,
    min_area: 160,
    padding: 6,
    output_format: 'png',
    sheet_columns: 6,
    sheet_gap: 8,
    sample_radius: 4,
    erase_radius: 34,
    keep_radius: 34,
    manual_strength: 1,
  })

  const displayUrl = useMemo(() => {
    if (!result) return ''
    if (viewMode === 'alpha') return downloadUrl(result.alpha_url)
    if (viewMode === 'sheet' && result.sheet_url) return downloadUrl(result.sheet_url)
    return downloadUrl(result.preview_url)
  }, [result, viewMode])

  const allMarks = [
    ...samplePoints.map(point => ({ ...point, kind: 'sample' })),
    ...erasePoints.map(point => ({ ...point, kind: 'erase' })),
    ...keepPoints.map(point => ({ ...point, kind: 'keep' })),
  ]

  async function updateFiles(list: FileList | File[]) {
    const picked = Array.from(list).filter(file => file.type.startsWith('image/') || /\.(png|jpe?g|webp|bmp)$/i.test(file.name))
    setFiles(picked)
    setResult(null)
    setError('')
    setViewMode('result')
    setSamplePoints([])
    setErasePoints([])
    setKeepPoints([])
    if (picked[0]) {
      setSourcePreview(await readFilePreview(picked[0]))
    } else {
      setSourcePreview('')
      setSourceSize({ width: 0, height: 0 })
    }
  }

  function handleImageClick(event: React.MouseEvent<HTMLImageElement>) {
    const img = imageRef.current
    if (!img || !img.naturalWidth || !img.naturalHeight) return
    const rect = img.getBoundingClientRect()
    const x = Math.round((event.clientX - rect.left) / rect.width * img.naturalWidth)
    const y = Math.round((event.clientY - rect.top) / rect.height * img.naturalHeight)
    if (x < 0 || y < 0 || x >= img.naturalWidth || y >= img.naturalHeight) return
    const point: AnnotPoint = { x, y }
    if (pointMode === 'sample') {
      setSamplePoints(current => [...current, point])
      setForm(current => ({ ...current, mode: 'samples' }))
    }
    if (pointMode === 'erase') setErasePoints(current => [...current, { ...point, radius: form.erase_radius }])
    if (pointMode === 'keep') setKeepPoints(current => [...current, { ...point, radius: form.keep_radius }])
  }

  function undoPoint() {
    if (pointMode === 'sample') setSamplePoints(current => current.slice(0, -1))
    if (pointMode === 'erase') setErasePoints(current => current.slice(0, -1))
    if (pointMode === 'keep') setKeepPoints(current => current.slice(0, -1))
  }

  function clearPoints() {
    setSamplePoints([])
    setErasePoints([])
    setKeepPoints([])
  }

  async function runCutout() {
    setError('')
    if (!files.length) {
      setError('请先上传图片')
      return
    }
    setBusy(true)
    try {
      const fd = new FormData()
      files.forEach(file => fd.append('files', file))
      Object.entries(form).forEach(([key, value]) => fd.append(key, String(value)))
      fd.append('sample_points', JSON.stringify(samplePoints))
      fd.append('erase_points', JSON.stringify(erasePoints))
      fd.append('keep_points', JSON.stringify(keepPoints))
      const data = await imageCutout(fd) as CutoutResult
      setResult(data)
      setViewMode('result')
    } catch (err) {
      setError(err instanceof Error ? err.message : '图片处理失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="tool-page image-page">
      {error && <div className="global-error">{error}</div>}
      {busy && <div className="global-busy">图片处理中，请稍等……</div>}

      <section className="module-grid image-layout">
        <div className="panel image-upload-panel">
          <div className="panel-title"><h2>1. 上传图片与标注</h2><span>{files.length ? `${files.length} 张` : '支持单图与批量'}</span></div>
          <label className="drop image-drop" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); void updateFiles(e.dataTransfer.files) }}>
            <input type="file" accept="image/*" multiple onChange={e => void updateFiles(e.target.files || [])} />
            <strong>{files.length ? files.map(file => file.name).slice(0, 2).join('、') : '点击选择或拖拽图片'}</strong>
            <span>支持 PNG / JPG / WEBP / BMP。先点背景采样，再点需要强制扣除或保留的位置。</span>
          </label>

          <div className="point-toolbar">
            <button className={pointMode === 'sample' ? 'active sample' : ''} onClick={() => setPointMode('sample')}>背景采样点</button>
            <button className={pointMode === 'erase' ? 'active erase' : ''} onClick={() => setPointMode('erase')}>指定扣除点</button>
            <button className={pointMode === 'keep' ? 'active keep' : ''} onClick={() => setPointMode('keep')}>指定保留点</button>
            <button onClick={undoPoint}>撤销当前</button>
            <button onClick={clearPoints}>清空标注</button>
          </div>

          <div className="checker source-image-box annotated-source">
            {sourcePreview ? <div className="annotated-image-wrap">
              <img
                ref={imageRef}
                src={sourcePreview}
                onClick={handleImageClick}
                onLoad={e => setSourceSize({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
              />
              {allMarks.map((point, index) => sourceSize.width ? <i
                key={`${point.kind}-${index}`}
                className={`point-marker ${markerClass(point.kind || 'sample')}`}
                style={{ left: `${point.x / sourceSize.width * 100}%`, top: `${point.y / sourceSize.height * 100}%` }}
                title={`${point.kind} x${point.x} y${point.y}`}
              /> : null)}
            </div> : <p>原图预览</p>}
          </div>

          <div className="annotation-stats">
            <span><b>{samplePoints.length}</b> 背景采样</span>
            <span><b>{erasePoints.length}</b> 指定扣除</span>
            <span><b>{keepPoints.length}</b> 指定保留</span>
          </div>
        </div>

        <div className="panel image-settings-panel">
          <div className="panel-title"><h2>2. 抠图参数</h2><span>多点检测 + 局部强制修正</span></div>
          <div className="field-grid two">
            <label>处理模式<select value={form.mode} onChange={e => setForm({ ...form, mode: e.target.value })}>{defaultModes.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
            <label>兜底关键色<input type="color" value={form.key_color} onChange={e => setForm({ ...form, key_color: e.target.value })} /></label>
            <label>颜色容差：{form.tolerance}<input type="range" min="0" max="180" value={form.tolerance} onChange={e => setForm({ ...form, tolerance: Number(e.target.value) })} /></label>
            <label>边缘羽化：{form.softness}px<input type="range" min="0" max="24" value={form.softness} onChange={e => setForm({ ...form, softness: Number(e.target.value) })} /></label>
            <label>采样半径<input type="number" min="0" max="24" value={form.sample_radius} onChange={e => setForm({ ...form, sample_radius: Number(e.target.value) })} /></label>
            <label>扣除点半径<input type="number" min="4" max="260" value={form.erase_radius} onChange={e => setForm({ ...form, erase_radius: Number(e.target.value) })} /></label>
            <label>保留点半径<input type="number" min="4" max="260" value={form.keep_radius} onChange={e => setForm({ ...form, keep_radius: Number(e.target.value) })} /></label>
            <label>强制扣除力度：{form.manual_strength.toFixed(2)}<input type="range" min="0" max="1" step="0.01" value={form.manual_strength} onChange={e => setForm({ ...form, manual_strength: Number(e.target.value) })} /></label>
            <label>边缘收缩<input type="number" min="0" max="8" value={form.erode} onChange={e => setForm({ ...form, erode: Number(e.target.value) })} /></label>
            <label>边缘扩张<input type="number" min="0" max="8" value={form.dilate} onChange={e => setForm({ ...form, dilate: Number(e.target.value) })} /></label>
            <label>去白边/去色边：{form.decontaminate.toFixed(2)}<input type="range" min="0" max="1" step="0.01" value={form.decontaminate} onChange={e => setForm({ ...form, decontaminate: Number(e.target.value) })} /></label>
            <label>边缘连通闭合<input type="number" min="0" max="6" value={form.close_gaps} onChange={e => setForm({ ...form, close_gaps: Number(e.target.value) })} /></label>
            <label>最小素材面积<input type="number" min="10" value={form.min_area} onChange={e => setForm({ ...form, min_area: Number(e.target.value) })} /></label>
            <label>拆分安全边距<input type="number" min="0" max="64" value={form.padding} onChange={e => setForm({ ...form, padding: Number(e.target.value) })} /></label>
            <label>输出格式<select value={form.output_format} onChange={e => setForm({ ...form, output_format: e.target.value })}><option value="png">PNG 透明图</option><option value="webp">WEBP 透明图</option></select></label>
            <label>合并列数<input type="number" min="1" max="24" value={form.sheet_columns} onChange={e => setForm({ ...form, sheet_columns: Number(e.target.value) })} /></label>
          </div>
          <div className="check-list">
            <label><input type="checkbox" checked={form.edge_protect} onChange={e => setForm({ ...form, edge_protect: e.target.checked })} /> 边缘连通抠图：优先只移除和画布边缘相连的背景</label>
            <label><input type="checkbox" checked={form.trim} onChange={e => setForm({ ...form, trim: e.target.checked })} /> 自动裁掉透明边</label>
            <label><input type="checkbox" checked={form.split_assets} onChange={e => setForm({ ...form, split_assets: e.target.checked })} /> 自动识别并拆分素材块</label>
          </div>
          <button className="primary-wide" onClick={runCutout} disabled={!files.length || busy}>{busy ? '正在处理...' : result ? '再次处理 / 刷新结果' : '开始抠图 / 拆分'}</button>
          <p className="desc small-tip">建议流程：先点 3-8 个背景采样点 → 处理 → 对残留背景点“指定扣除” → 对被误扣的脸、眼睛、衣服点“指定保留” → 再次处理。</p>
        </div>
      </section>

      <section className="module-grid preview-layout">
        <div className="panel image-result-panel">
          <div className="panel-title"><h2>3. 结果预览</h2><span>{result ? `${result.width} × ${result.height}` : '等待处理'}</span></div>
          <div className="tabbar"><button className={viewMode === 'result' ? 'active' : ''} onClick={() => setViewMode('result')}>透明结果</button><button className={viewMode === 'alpha' ? 'active' : ''} onClick={() => setViewMode('alpha')}>Alpha 蒙版</button><button className={viewMode === 'sheet' ? 'active' : ''} onClick={() => setViewMode('sheet')}>素材合并图</button></div>
          <div className="checker big-image-preview">{displayUrl ? <img src={displayUrl} /> : <p>处理后在这里预览透明图、蒙版或合并图。</p>}</div>
        </div>

        <div className="panel">
          <div className="panel-title"><h2>4. 素材拆分与导出</h2><span>{result ? `${result.regions.length} 个素材块` : '未识别'}</span></div>
          <p className="desc">这一版支持多点背景采样、指定扣除点、指定保留点。算法会先做边缘连通背景检测，再叠加局部强制修正，适合反复处理到更干净的边缘。</p>
          {result && <div className="stat-grid image-stats"><div><span>处理图片</span><b>{result.files_processed}</b></div><div><span>素材块</span><b>{result.regions.length}</b></div><div><span>输出</span><b>{result.outputs.length}</b></div><div><span>ZIP</span><b>可下载</b></div></div>}
          {result?.regions.length ? <div className="asset-list">{result.regions.slice(0, 12).map(region => <div key={region.name} className="asset-chip"><b>{region.name}</b><span>{region.w}×{region.h}</span><small>x{region.x}, y{region.y}</small></div>)}</div> : <div className="empty-card">自动拆分后，这里会列出识别到的素材块。</div>}
          {result?.outputs.length ? <div className="downloads image-downloads">{result.outputs.map(out => <a key={out.name} href={downloadUrl(out.url)} target="_blank" rel="noreferrer"><strong>{out.name}</strong><span>{formatSize(out.size_bytes)}</span></a>)}</div> : null}
        </div>
      </section>
    </div>
  )
}

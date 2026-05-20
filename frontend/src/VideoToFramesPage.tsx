import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createJob, downloadUrl, getJob } from './api'
import type { JobState } from './types'

type Crop = { x: number; y: number; w: number; h: number }
type DragState = { startX: number; startY: number; active: boolean }
type PreviewFrame = {
  index: number
  time: number
  dataUrl: string
  keyedUrl?: string
  alphaUrl?: string
}
type PreviewMode = 'sprite' | 'animation'
type MatteView = 'result' | 'alpha' | 'solid'

type StepState = 'todo' | 'ready' | 'done'

function clampNumber(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Number.isFinite(v) ? v : min))
}

function hex(n: number) {
  return clampNumber(Math.round(n), 0, 255).toString(16).padStart(2, '0')
}

function hexToRgb(value: string): [number, number, number] {
  const clean = (value || '#00ff00').replace('#', '').trim()
  const full = clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean.padEnd(6, '0').slice(0, 6)
  const n = Number.parseInt(full, 16)
  if (Number.isNaN(n)) return [0, 255, 0]
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function bytes(size: number) {
  if (!size) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let n = size
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function smoothstep(edge0: number, edge1: number, x: number) {
  if (edge1 <= edge0) return x >= edge0 ? 1 : 0
  const t = clampNumber((x - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

function formatClock(seconds: number) {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
  const m = Math.floor(safe / 60).toString().padStart(2, '0')
  const s = Math.floor(safe % 60).toString().padStart(2, '0')
  const ms = Math.floor((safe % 1) * 1000).toString().padStart(3, '0')
  return `${m}:${s}.${ms}`
}

function fitSize(w: number, h: number, preset: string) {
  if (preset === 'original') return { width: w, height: h }
  const size = Number(preset)
  if (!Number.isFinite(size) || size <= 0) return { width: w, height: h }
  const scale = Math.min(size / Math.max(w, h), 1)
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) }
}

function applyChromaOnCanvas(src: HTMLCanvasElement, options: {
  keyColor: string
  tolerance: number
  softness: number
  despill: number
}) {
  const canvas = document.createElement('canvas')
  canvas.width = src.width
  canvas.height = src.height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(src, 0, 0)
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const data = image.data
  const [kr, kg, kb] = hexToRgb(options.keyColor)
  const softness = Math.max(1, options.softness)
  const despill = clampNumber(options.despill, 0, 1)
  const dominant = kg >= kr && kg >= kb ? 1 : kb >= kr && kb >= kg ? 2 : 0

  const alphaCanvas = document.createElement('canvas')
  alphaCanvas.width = src.width
  alphaCanvas.height = src.height
  const alphaCtx = alphaCanvas.getContext('2d', { willReadFrequently: true })!
  const alphaImage = alphaCtx.createImageData(alphaCanvas.width, alphaCanvas.height)
  const alphaData = alphaImage.data

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    const dist = Math.sqrt((r - kr) ** 2 + (g - kg) ** 2 + (b - kb) ** 2) / Math.sqrt(3)
    const alpha = smoothstep(options.tolerance, options.tolerance + softness, dist)

    if (despill > 0) {
      const edge = (1 - alpha) * despill
      if (dominant === 1) {
        const excess = Math.max(0, g - Math.max(r, b))
        data[i + 1] = clampNumber(g - excess * edge, 0, 255)
      } else if (dominant === 2) {
        const excess = Math.max(0, b - Math.max(r, g))
        data[i + 2] = clampNumber(b - excess * edge, 0, 255)
      } else {
        const excess = Math.max(0, r - Math.max(g, b))
        data[i] = clampNumber(r - excess * edge, 0, 255)
      }
    }

    data[i + 3] = Math.round(alpha * 255)
    const a = Math.round(alpha * 255)
    alphaData[i] = a
    alphaData[i + 1] = a
    alphaData[i + 2] = a
    alphaData[i + 3] = 255
  }
  ctx.putImageData(image, 0, 0)
  alphaCtx.putImageData(alphaImage, 0, 0)
  return { result: canvas.toDataURL('image/png'), alpha: alphaCanvas.toDataURL('image/png') }
}

async function imageUrlToCanvas(url: string) {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = url
  })
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  canvas.getContext('2d')!.drawImage(image, 0, 0)
  return canvas
}

export function VideoToFramesPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const overlayRef = useRef<HTMLCanvasElement | null>(null)
  const hiddenCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const cropPreviewRef = useRef<HTMLCanvasElement | null>(null)
  const originalPreviewRef = useRef<HTMLCanvasElement | null>(null)
  const animationTimerRef = useRef<number | null>(null)
  const dragRef = useRef<DragState>({ startX: 0, startY: 0, active: false })
  const pollRef = useRef<number | null>(null)

  const [file, setFile] = useState<File | null>(null)
  const [videoUrl, setVideoUrl] = useState('')
  const [duration, setDuration] = useState(0)
  const [videoSize, setVideoSize] = useState({ width: 0, height: 0 })
  const [crop, setCrop] = useState<Crop>({ x: 0, y: 0, w: 0, h: 0 })
  const [pickFromVideo, setPickFromVideo] = useState(false)
  const [job, setJob] = useState<JobState | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [frames, setFrames] = useState<PreviewFrame[]>([])
  const [selectedFrame, setSelectedFrame] = useState(0)
  const [matteView, setMatteView] = useState<MatteView>('result')
  const [previewMode, setPreviewMode] = useState<PreviewMode>('sprite')
  const [spriteUrl, setSpriteUrl] = useState('')
  const [animIndex, setAnimIndex] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const [form, setForm] = useState({
    start_time: 0,
    end_time: 0,
    fps: 12,
    max_frames: 120,
    remove_background: true,
    key_color: '#00ff00',
    tolerance: 45,
    softness: 18,
    despill: 0.75,
    denoise: 1,
    fill_holes: 1,
    sheet_columns: 6,
    sheet_gap: 0,
    frame_preset: 'original',
    custom_width: 0,
    custom_height: 0,
    spine_animation: 'idle',
  })

  const stepState = useMemo<Record<number, StepState>>(() => ({
    1: file ? 'done' : 'ready',
    2: videoSize.width && crop.w > 1 && crop.h > 1 ? 'done' : file ? 'ready' : 'todo',
    3: frames.length ? 'done' : file ? 'ready' : 'todo',
    4: frames.length ? 'done' : 'todo',
    5: frames.length ? 'done' : 'todo',
    6: frames.length ? (job?.status === 'completed' ? 'done' : 'ready') : 'todo',
    7: job?.status === 'completed' ? 'ready' : 'todo',
  }), [file, videoSize.width, crop, frames.length, job?.status])

  const selected = frames[selectedFrame]
  const selectedDisplayUrl = selected ? matteView === 'alpha' ? selected.alphaUrl || selected.dataUrl : matteView === 'solid' ? selected.keyedUrl || selected.dataUrl : selected.keyedUrl || selected.dataUrl : ''

  const targetFrameSize = useMemo(() => {
    const w = crop.w || videoSize.width || 1
    const h = crop.h || videoSize.height || 1
    if (form.frame_preset === 'custom') {
      const width = Math.max(1, Number(form.custom_width) || w)
      const height = Math.max(1, Number(form.custom_height) || h)
      return { width, height }
    }
    return fitSize(w, h, form.frame_preset)
  }, [crop, videoSize, form.frame_preset, form.custom_width, form.custom_height])

  const estimatedFrameCount = useMemo(() => {
    const start = clampNumber(form.start_time, 0, duration || 999999)
    const end = clampNumber(form.end_time, start, duration || start)
    return Math.max(1, Math.min(form.max_frames, Math.floor((end - start) * Math.max(1, form.fps)) + 1))
  }, [form.start_time, form.end_time, form.fps, form.max_frames, duration])

  const getVideoContentRect = useCallback((boxWidth?: number, boxHeight?: number) => {
    const video = videoRef.current
    const width = boxWidth ?? video?.clientWidth ?? 1
    const height = boxHeight ?? video?.clientHeight ?? 1
    const sourceW = videoSize.width || video?.videoWidth || 1
    const sourceH = videoSize.height || video?.videoHeight || 1
    const scale = Math.min(width / sourceW, height / sourceH) || 1
    const renderW = sourceW * scale
    const renderH = sourceH * scale
    return {
      x: (width - renderW) / 2,
      y: (height - renderH) / 2,
      width: renderW,
      height: renderH,
      scale,
    }
  }, [videoSize.width, videoSize.height])

  const canvasPointToVideoPoint = useCallback((canvasX: number, canvasY: number) => {
    const canvas = overlayRef.current
    const rect = getVideoContentRect(canvas?.width || 1, canvas?.height || 1)
    const x = clampNumber((canvasX - rect.x) / rect.scale, 0, Math.max(0, (videoSize.width || 1) - 1))
    const y = clampNumber((canvasY - rect.y) / rect.scale, 0, Math.max(0, (videoSize.height || 1) - 1))
    return { x, y }
  }, [getVideoContentRect, videoSize.width, videoSize.height])

  const drawCropPreview = useCallback(() => {
    const video = videoRef.current
    const canvas = cropPreviewRef.current
    if (!video || !canvas || !video.videoWidth || !crop.w || !crop.h) return
    const maxW = 560
    const scale = Math.min(maxW / crop.w, 260 / crop.h, 1)
    canvas.width = Math.max(1, Math.round(crop.w * scale))
    canvas.height = Math.max(1, Math.round(crop.h * scale))
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(video, crop.x, crop.y, crop.w, crop.h, 0, 0, canvas.width, canvas.height)
  }, [crop])

  const drawOverlay = useCallback(() => {
    const canvas = overlayRef.current
    const video = videoRef.current
    if (!canvas || !video) return
    const rect = video.getBoundingClientRect()
    canvas.width = Math.max(1, Math.round(rect.width))
    canvas.height = Math.max(1, Math.round(rect.height))
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = 'rgba(17,24,39,0.26)'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    const videoRect = getVideoContentRect(canvas.width, canvas.height)
    ctx.strokeStyle = 'rgba(255,255,255,.18)'
    ctx.lineWidth = 1
    ctx.strokeRect(videoRect.x, videoRect.y, videoRect.width, videoRect.height)

    if (crop.w > 0 && crop.h > 0 && videoSize.width > 0 && videoSize.height > 0) {
      const x = videoRect.x + crop.x * videoRect.scale
      const y = videoRect.y + crop.y * videoRect.scale
      const w = crop.w * videoRect.scale
      const h = crop.h * videoRect.scale
      ctx.clearRect(x, y, w, h)
      ctx.strokeStyle = '#ff9f1a'
      ctx.lineWidth = 2
      ctx.strokeRect(x, y, w, h)
      ctx.setLineDash([8, 8])
      ctx.strokeStyle = 'rgba(255,159,26,.8)'
      ctx.beginPath()
      ctx.moveTo(x + w / 3, y)
      ctx.lineTo(x + w / 3, y + h)
      ctx.moveTo(x + 2 * w / 3, y)
      ctx.lineTo(x + 2 * w / 3, y + h)
      ctx.moveTo(x, y + h / 3)
      ctx.lineTo(x + w, y + h / 3)
      ctx.moveTo(x, y + 2 * h / 3)
      ctx.lineTo(x + w, y + 2 * h / 3)
      ctx.stroke()
      ctx.setLineDash([])
    }

    if (pickFromVideo) {
      ctx.fillStyle = 'rgba(109,53,255,0.86)'
      ctx.fillRect(14, 14, 218, 34)
      ctx.fillStyle = '#fff'
      ctx.font = '14px system-ui, sans-serif'
      ctx.fillText('点击视频画面取背景色', 30, 36)
    }
  }, [crop, getVideoContentRect, pickFromVideo, videoSize])

  useEffect(() => {
    drawOverlay()
    drawCropPreview()
    window.addEventListener('resize', drawOverlay)
    return () => window.removeEventListener('resize', drawOverlay)
  }, [drawOverlay, drawCropPreview])

  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl)
      if (pollRef.current) window.clearInterval(pollRef.current)
      if (animationTimerRef.current) window.clearInterval(animationTimerRef.current)
    }
  }, [videoUrl])

  useEffect(() => {
    if (!selected) return
    const canvas = originalPreviewRef.current
    if (!canvas) return
    const img = new Image()
    img.onload = () => {
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext('2d')!
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(img, 0, 0)
    }
    img.src = selected.dataUrl
  }, [selected?.dataUrl])

  useEffect(() => {
    if (!frames.length || previewMode !== 'animation') return
    if (animationTimerRef.current) window.clearInterval(animationTimerRef.current)
    animationTimerRef.current = window.setInterval(() => {
      setAnimIndex(v => (v + 1) % frames.length)
    }, Math.max(30, Math.round(1000 / Math.max(1, form.fps))))
    return () => {
      if (animationTimerRef.current) window.clearInterval(animationTimerRef.current)
    }
  }, [frames.length, form.fps, previewMode])

  function onFileChange(next: File | null) {
    setError('')
    setJob(null)
    setFrames([])
    setSpriteUrl('')
    setIsPlaying(false)
    setCurrentTime(0)
    setFile(next)
    if (videoUrl) URL.revokeObjectURL(videoUrl)
    if (next) setVideoUrl(URL.createObjectURL(next))
  }

  function onDrop(e: React.DragEvent<HTMLLabelElement>) {
    e.preventDefault()
    const item = e.dataTransfer.files?.[0]
    if (item) onFileChange(item)
  }

  function onLoadedMetadata() {
    const video = videoRef.current
    if (!video) return
    const d = video.duration || 0
    setDuration(d)
    setCurrentTime(video.currentTime || 0)
    setVideoSize({ width: video.videoWidth, height: video.videoHeight })
    setForm(prev => ({ ...prev, end_time: Math.min(d, 5) || d }))
    setCrop({ x: 0, y: 0, w: video.videoWidth, h: video.videoHeight })
    setTimeout(() => {
      drawOverlay()
      drawCropPreview()
    }, 80)
  }

  async function togglePlay() {
    const video = videoRef.current
    if (!video) return
    try {
      if (video.paused) {
        await video.play()
      } else {
        video.pause()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '视频播放失败，请检查浏览器权限或视频编码')
    }
  }

  function scrubVideo(value: number) {
    const video = videoRef.current
    if (!video) return
    const target = clampNumber(value, 0, duration || 0)
    video.currentTime = target
    setCurrentTime(target)
    setTimeout(() => { drawOverlay(); drawCropPreview() }, 60)
  }

  function nudgeVideo(delta: number) {
    const video = videoRef.current
    if (!video) return
    scrubVideo((video.currentTime || 0) + delta)
  }

  function sampleColorFromVideo(canvasX: number, canvasY: number) {
    const video = videoRef.current
    const hidden = hiddenCanvasRef.current
    if (!video || !hidden || !video.videoWidth || !video.videoHeight) return
    hidden.width = video.videoWidth
    hidden.height = video.videoHeight
    const ctx = hidden.getContext('2d', { willReadFrequently: true })
    if (!ctx) return
    ctx.drawImage(video, 0, 0, hidden.width, hidden.height)
    const point = canvasPointToVideoPoint(canvasX, canvasY)
    const data = ctx.getImageData(clampNumber(point.x, 0, hidden.width - 1), clampNumber(point.y, 0, hidden.height - 1), 1, 1).data
    setForm(prev => ({ ...prev, key_color: `#${hex(data[0])}${hex(data[1])}${hex(data[2])}` }))
    setPickFromVideo(false)
  }

  function sampleColorFromReference(e: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = originalPreviewRef.current
    if (!canvas || !selected) return
    const rect = canvas.getBoundingClientRect()
    const x = Math.floor((e.clientX - rect.left) * canvas.width / rect.width)
    const y = Math.floor((e.clientY - rect.top) * canvas.height / rect.height)
    const data = canvas.getContext('2d', { willReadFrequently: true })!.getImageData(clampNumber(x, 0, canvas.width - 1), clampNumber(y, 0, canvas.height - 1), 1, 1).data
    setForm(prev => ({ ...prev, key_color: `#${hex(data[0])}${hex(data[1])}${hex(data[2])}` }))
  }

  function pointerPos(e: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = overlayRef.current!
    const rect = canvas.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = overlayRef.current
    if (!canvas) return
    const p = pointerPos(e)
    if (pickFromVideo) {
      sampleColorFromVideo(p.x, p.y)
      return
    }
    const start = canvasPointToVideoPoint(p.x, p.y)
    dragRef.current = { startX: start.x, startY: start.y, active: true }
    canvas.setPointerCapture(e.pointerId)
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!dragRef.current.active || pickFromVideo || !overlayRef.current || !videoSize.width || !videoSize.height) return
    const p = pointerPos(e)
    const current = canvasPointToVideoPoint(p.x, p.y)
    const x1 = clampNumber(Math.min(dragRef.current.startX, current.x), 0, videoSize.width)
    const y1 = clampNumber(Math.min(dragRef.current.startY, current.y), 0, videoSize.height)
    const x2 = clampNumber(Math.max(dragRef.current.startX, current.x), 0, videoSize.width)
    const y2 = clampNumber(Math.max(dragRef.current.startY, current.y), 0, videoSize.height)
    const nextCrop = {
      x: Math.round(x1),
      y: Math.round(y1),
      w: Math.max(1, Math.round(x2 - x1)),
      h: Math.max(1, Math.round(y2 - y1)),
    }
    setCrop(nextCrop)
  }

  function onPointerUp(e: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = overlayRef.current
    if (canvas && dragRef.current.active) canvas.releasePointerCapture(e.pointerId)
    dragRef.current.active = false
  }

  async function seekVideo(time: number) {
    const video = videoRef.current
    if (!video) throw new Error('视频未加载')
    const target = clampNumber(time, 0, Math.max(0, duration - 0.001))
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('视频定位超时')), 7000)
      const done = () => {
        window.clearTimeout(timer)
        video.removeEventListener('seeked', done)
        resolve()
      }
      if (Math.abs(video.currentTime - target) < 0.001 && video.readyState >= 2) {
        done()
        return
      }
      video.addEventListener('seeked', done, { once: true })
      video.currentTime = target
    })
  }

  async function captureFrameAt(time: number, index: number): Promise<PreviewFrame> {
    const video = videoRef.current
    if (!video) throw new Error('视频未加载')
    await seekVideo(time)
    const c = document.createElement('canvas')
    c.width = Math.max(1, crop.w || video.videoWidth)
    c.height = Math.max(1, crop.h || video.videoHeight)
    const ctx = c.getContext('2d')!
    ctx.drawImage(video, crop.x, crop.y, c.width, c.height, 0, 0, c.width, c.height)
    return { index, time, dataUrl: c.toDataURL('image/png') }
  }

  async function extractPreviewFrames() {
    setError('')
    if (!file || !videoRef.current) {
      setError('请先上传视频')
      return
    }
    if (!crop.w || !crop.h) {
      setError('请先确认裁剪区域')
      return
    }
    setBusy(true)
    setFrames([])
    setSpriteUrl('')
    try {
      const start = clampNumber(form.start_time, 0, duration || 999999)
      const end = clampNumber(form.end_time, start + 0.01, duration || start + 60)
      const count = Math.max(1, Math.min(form.max_frames, Math.floor((end - start) * Math.max(1, form.fps)) + 1))
      const list: PreviewFrame[] = []
      for (let i = 0; i < count; i++) {
        const t = Math.min(end, start + i / Math.max(1, form.fps))
        const frame = await captureFrameAt(t, i)
        list.push(frame)
        if (i % 4 === 0 || i === count - 1) setFrames([...list])
      }
      setFrames(list)
      setSelectedFrame(0)
    } catch (err) {
      setError(err instanceof Error ? err.message : '提取预览帧失败')
    } finally {
      setBusy(false)
      setTimeout(() => { drawOverlay(); drawCropPreview() }, 50)
    }
  }

  async function applyMatteToPreview() {
    setError('')
    if (!frames.length) {
      setError('请先提取帧')
      return
    }
    setBusy(true)
    try {
      const out: PreviewFrame[] = []
      for (const frame of frames) {
        const c = await imageUrlToCanvas(frame.dataUrl)
        const keyed = applyChromaOnCanvas(c, {
          keyColor: form.key_color,
          tolerance: form.tolerance,
          softness: form.softness,
          despill: form.despill,
        })
        out.push({ ...frame, keyedUrl: keyed.result, alphaUrl: keyed.alpha })
        if (out.length % 6 === 0 || out.length === frames.length) setFrames([...out, ...frames.slice(out.length)])
      }
      setFrames(out)
    } catch (err) {
      setError(err instanceof Error ? err.message : '抠图预览失败')
    } finally {
      setBusy(false)
    }
  }

  async function buildSpritePreview() {
    setError('')
    if (!frames.length) {
      setError('请先提取帧')
      return
    }
    setBusy(true)
    try {
      const cols = Math.max(1, Math.min(24, form.sheet_columns))
      const gap = Math.max(0, Math.min(64, Number(form.sheet_gap) || 0))
      const rows = Math.ceil(frames.length / cols)
      const canvas = document.createElement('canvas')
      canvas.width = targetFrameSize.width * cols + gap * Math.max(0, cols - 1)
      canvas.height = targetFrameSize.height * rows + gap * Math.max(0, rows - 1)
      const ctx = canvas.getContext('2d')!
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      for (let i = 0; i < frames.length; i++) {
        const frame = frames[i]
        const url = form.remove_background ? frame.keyedUrl || frame.dataUrl : frame.dataUrl
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
          const im = new Image()
          im.onload = () => resolve(im)
          im.onerror = reject
          im.src = url
        })
        const x = (i % cols) * (targetFrameSize.width + gap)
        const y = Math.floor(i / cols) * (targetFrameSize.height + gap)
        ctx.drawImage(img, x, y, targetFrameSize.width, targetFrameSize.height)
      }
      setSpriteUrl(canvas.toDataURL('image/png'))
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成序列图预览失败')
    } finally {
      setBusy(false)
    }
  }

  async function submit() {
    setError('')
    if (!file) {
      setError('请先选择视频文件')
      return
    }
    const fd = new FormData()
    fd.append('file', file)
    const safeStart = clampNumber(form.start_time, 0, duration || 999999)
    const safeEnd = clampNumber(form.end_time, safeStart + 0.01, duration || safeStart + 60)
    const resizeW = form.frame_preset === 'custom' ? form.custom_width : form.frame_preset === 'original' ? 0 : targetFrameSize.width
    const resizeH = form.frame_preset === 'custom' ? form.custom_height : form.frame_preset === 'original' ? 0 : targetFrameSize.height
    const fields: Record<string, string> = {
      start_time: String(safeStart),
      end_time: String(safeEnd),
      fps: String(form.fps),
      max_frames: String(form.max_frames),
      remove_background: String(form.remove_background),
      key_color: form.key_color,
      tolerance: String(form.tolerance),
      softness: String(form.softness),
      despill: String(form.despill),
      denoise: String(form.denoise),
      fill_holes: String(form.fill_holes),
      crop_x: String(crop.x),
      crop_y: String(crop.y),
      crop_w: String(crop.w),
      crop_h: String(crop.h),
      resize_width: String(resizeW),
      resize_height: String(resizeH),
      sheet_columns: String(form.sheet_columns),
      sheet_gap: String(form.sheet_gap),
      spine_animation: form.spine_animation || 'idle',
    }
    Object.entries(fields).forEach(([k, v]) => fd.append(k, v))

    try {
      const created = await createJob(fd)
      setJob(created)
      if (pollRef.current) window.clearInterval(pollRef.current)
      pollRef.current = window.setInterval(async () => {
        try {
          const latest = await getJob(created.id)
          setJob(latest)
          if (latest.status === 'completed' || latest.status === 'failed') {
            if (pollRef.current) window.clearInterval(pollRef.current)
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : '轮询任务失败')
        }
      }, 1000)
    } catch (err) {
      setError(err instanceof Error ? err.message : '提交失败')
    }
  }

  const progressPercent = job ? Math.round(job.progress * 100) : 0
  const animationUrl = frames[animIndex] ? (form.remove_background ? frames[animIndex].keyedUrl || frames[animIndex].dataUrl : frames[animIndex].dataUrl) : ''

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="logo-dot">🎞️</div>
          <div>
            <h1>Motion Sprite Studio</h1>
            <p>本地视频转透明序列帧、精灵图、GIF 与 2D 动画资源包。</p>
          </div>
        </div>
        <div className="badges"><span>本地预览</span><span>后端导出</span><span>4G 云服友好</span></div>
      </header>

      <nav className="steps">
        {[
          ['上传视频', 1], ['画面裁剪', 2], ['提取帧', 3], ['参考帧/抠像', 4], ['序列图预览', 5], ['导出结果', 6], ['高级导出', 7],
        ].map(([name, no]) => <a key={no} className={`step ${stepState[no as number]}`} href={`#step-${no}`}><b>{no}</b>{name}</a>)}
      </nav>

      {error && <div className="global-error">{error}</div>}
      {busy && <div className="global-busy">处理中，请稍等……</div>}

      <main className="workflow">
        <section className="panel" id="step-1">
          <div className="panel-title"><h2>1. 上传视频</h2><span>{videoSize.width ? `${videoSize.width} × ${videoSize.height} / ${duration.toFixed(2)} 秒` : '未加载'}</span></div>
          <label className="drop" onDragOver={e => e.preventDefault()} onDrop={onDrop}>
            <input type="file" accept="video/*" onChange={e => onFileChange(e.target.files?.[0] || null)} />
            <strong>{file ? file.name : '点击选择或拖拽视频到这里'}</strong>
            <span>支持 mp4 / mov / webm / mkv / avi。短视频、纯色背景效果最好。</span>
          </label>
          {videoUrl && <>
            <div className="video-stage">
              <video
                ref={videoRef}
                src={videoUrl}
                playsInline
                preload="metadata"
                onLoadedMetadata={onLoadedMetadata}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onSeeked={() => { setCurrentTime(videoRef.current?.currentTime || 0); drawOverlay(); drawCropPreview() }}
                onTimeUpdate={() => { setCurrentTime(videoRef.current?.currentTime || 0); drawOverlay(); drawCropPreview() }}
              />
              <canvas ref={overlayRef} className={`crop-overlay ${pickFromVideo ? 'picker' : ''}`} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} />
              <canvas ref={hiddenCanvasRef} hidden />
            </div>
            <div className="video-controls">
              <button type="button" className="play-btn" onClick={togglePlay}>{isPlaying ? '暂停' : '播放'}</button>
              <button type="button" className="mini-btn" onClick={() => nudgeVideo(-1)}>-1s</button>
              <button type="button" className="mini-btn" onClick={() => nudgeVideo(1)}>+1s</button>
              <input aria-label="视频时间轴" type="range" min="0" max={duration || 1} step="0.001" value={currentTime} onChange={e => scrubVideo(Number(e.target.value))} />
              <span className="time-code">{formatClock(currentTime)} / {formatClock(duration)}</span>
            </div>
          </>}
        </section>

        <section className="two-col" id="step-2">
          <div className="panel">
            <div className="panel-title"><h2>2. 画面裁剪</h2><span>鼠标框选，直接选择保留区域</span></div>
            <div className="hint">左侧视频上拖拽裁剪框，右侧会实时显示当前裁剪后的画面。也可以继续用下面的数值输入精确微调。</div>
            <div className="field-grid four">
              <label>左侧偏移 (%)<input type="number" value={videoSize.width ? crop.x / videoSize.width * 100 : 0} onChange={e => setCrop({ ...crop, x: clampNumber(Math.round(videoSize.width * Number(e.target.value) / 100), 0, Math.max(0, videoSize.width - 1)) })} /></label>
              <label>顶部偏移 (%)<input type="number" value={videoSize.height ? crop.y / videoSize.height * 100 : 0} onChange={e => setCrop({ ...crop, y: clampNumber(Math.round(videoSize.height * Number(e.target.value) / 100), 0, Math.max(0, videoSize.height - 1)) })} /></label>
              <label>裁剪宽度 (%)<input type="number" value={videoSize.width ? crop.w / videoSize.width * 100 : 0} onChange={e => setCrop({ ...crop, w: clampNumber(Math.round(videoSize.width * Number(e.target.value) / 100), 1, Math.max(1, videoSize.width - crop.x)) })} /></label>
              <label>裁剪高度 (%)<input type="number" value={videoSize.height ? crop.h / videoSize.height * 100 : 0} onChange={e => setCrop({ ...crop, h: clampNumber(Math.round(videoSize.height * Number(e.target.value) / 100), 1, Math.max(1, videoSize.height - crop.y)) })} /></label>
            </div>
            <div className="field-grid four compact">
              <label>X<input type="number" value={crop.x} onChange={e => setCrop({ ...crop, x: clampNumber(Number(e.target.value), 0, Math.max(0, videoSize.width - 1)) })} /></label>
              <label>Y<input type="number" value={crop.y} onChange={e => setCrop({ ...crop, y: clampNumber(Number(e.target.value), 0, Math.max(0, videoSize.height - 1)) })} /></label>
              <label>W<input type="number" value={crop.w} onChange={e => setCrop({ ...crop, w: clampNumber(Number(e.target.value), 1, Math.max(1, videoSize.width - crop.x)) })} /></label>
              <label>H<input type="number" value={crop.h} onChange={e => setCrop({ ...crop, h: clampNumber(Number(e.target.value), 1, Math.max(1, videoSize.height - crop.y)) })} /></label>
            </div>
            <button type="button" className="soft-btn" onClick={() => setCrop({ x: 0, y: 0, w: videoSize.width, h: videoSize.height })}>重置裁剪</button>
          </div>
          <div className="panel preview-panel">
            <div className="panel-title"><h2>裁剪预览</h2><span>{crop.w} × {crop.h}</span></div>
            <div className="checker preview-box"><canvas ref={cropPreviewRef} /></div>
          </div>
        </section>

        <section className="panel" id="step-3">
          <div className="panel-title"><h2>3. 提取帧</h2><span>预计 {estimatedFrameCount} 帧</span></div>
          <div className="hint">先确认片段和每秒帧数，再提取参考帧。提取后可进入抠像预览和序列图预览。</div>
          <div className="field-grid four">
            <label>每秒提取帧数<input type="number" min="1" max="30" value={form.fps} onChange={e => setForm({ ...form, fps: Number(e.target.value) })} /></label>
            <label>最大帧数<input type="number" min="1" max="120" value={form.max_frames} onChange={e => setForm({ ...form, max_frames: Number(e.target.value) })} /></label>
            <label>开始<input type="number" step="0.001" min="0" max={duration} value={form.start_time} onChange={e => setForm({ ...form, start_time: Number(e.target.value) })} /></label>
            <label>结束<input type="number" step="0.001" min="0" max={duration} value={form.end_time} onChange={e => setForm({ ...form, end_time: Number(e.target.value) })} /></label>
          </div>
          <div className="range-row">
            <input type="range" min="0" max={duration || 1} step="0.001" value={form.start_time} onChange={e => setForm({ ...form, start_time: Number(e.target.value) })} />
            <input type="range" min="0" max={duration || 1} step="0.001" value={form.end_time} onChange={e => setForm({ ...form, end_time: Number(e.target.value) })} />
          </div>
          <button className="primary-wide" onClick={extractPreviewFrames} disabled={!file || busy}>提取帧</button>
          {frames.length > 0 && <div className="thumb-strip">{frames.slice(0, 48).map((f, i) => <button key={f.index} className={i === selectedFrame ? 'thumb active' : 'thumb'} onClick={() => setSelectedFrame(i)}><img src={form.remove_background ? f.keyedUrl || f.dataUrl : f.dataUrl} /><span>{i + 1}</span></button>)}</div>}
        </section>

        <section className="two-col" id="step-4">
          <div className="panel">
            <div className="panel-title"><h2>4. 参考帧与抠像预览</h2><span>点击左侧帧画面取背景色</span></div>
            <div className="color-row">
              <span className="color-swatch" style={{ background: form.key_color }} />
              <strong>RGB {hexToRgb(form.key_color).join(', ')}</strong>
              <input type="color" value={form.key_color} onChange={e => setForm({ ...form, key_color: e.target.value })} />
              <button className={pickFromVideo ? 'soft-btn active' : 'soft-btn'} onClick={() => setPickFromVideo(v => !v)}>从视频取色</button>
              <button className="soft-btn" onClick={() => setForm({ ...form, key_color: '#00ff00' })}>清除颜色</button>
            </div>
            <div className="compare">
              <div>
                <h3>原图</h3>
                <div className="checker compare-box"><canvas ref={originalPreviewRef} onPointerDown={sampleColorFromReference} /></div>
                {selected && <p className="small">当前帧：{selected.index + 1} / {frames.length}，时间 {selected.time.toFixed(3)} 秒</p>}
              </div>
              <div>
                <h3>抠图预览结果</h3>
                <div className="tabbar"><button className={matteView === 'result' ? 'active' : ''} onClick={() => setMatteView('result')}>抠像结果</button><button className={matteView === 'alpha' ? 'active' : ''} onClick={() => setMatteView('alpha')}>Alpha 蒙版</button><button className={matteView === 'solid' ? 'active' : ''} onClick={() => setMatteView('solid')}>纯色底</button></div>
                <div className={matteView === 'solid' ? 'solid-bg compare-box' : 'checker compare-box'}>{selectedDisplayUrl && <img src={selectedDisplayUrl} />}</div>
              </div>
            </div>
            <div className="field-grid two">
              <label>颜色容差：{form.tolerance}<input type="range" min="0" max="180" value={form.tolerance} onChange={e => setForm({ ...form, tolerance: Number(e.target.value) })} /></label>
              <label>羽化半径：{form.softness}px<input type="range" min="0" max="80" value={form.softness} onChange={e => setForm({ ...form, softness: Number(e.target.value) })} /></label>
              <label>边缘平滑<input type="checkbox" checked={form.denoise > 0} onChange={e => setForm({ ...form, denoise: e.target.checked ? 1 : 0 })} /></label>
              <label>溢色移除<input type="checkbox" checked={form.despill > 0} onChange={e => setForm({ ...form, despill: e.target.checked ? 0.75 : 0 })} /></label>
            </div>
            <button className="primary-wide" onClick={applyMatteToPreview} disabled={!frames.length || busy}>应用到当前预览序列</button>
          </div>
          <div className="panel matte-side">
            <div className="panel-title"><h2>抠像检查台</h2><span>边缘校验</span></div>
            <p className="desc">这里用于快速判断当前背景色和边缘参数是否合适。建议先看纯色底，再看 Alpha 蒙版，最后应用到整组序列。</p>
            <div className="stat-grid">
              <div><span>当前帧</span><b>{selected ? `${selected.index + 1} / ${frames.length}` : '未选择'}</b></div>
              <div><span>背景色</span><b>{hexToRgb(form.key_color).join(', ')}</b></div>
              <div><span>容差</span><b>{form.tolerance}</b></div>
              <div><span>羽化</span><b>{form.softness}px</b></div>
            </div>
            <div className={matteView === 'solid' ? 'solid-bg inspection-box' : 'checker inspection-box'}>
              {selectedDisplayUrl ? <img src={selectedDisplayUrl} /> : <p>提取帧后，这里显示当前抠像检查图。</p>}
            </div>
            <ul className="tips-list">
              <li>主体边缘发灰：降低容差或减少羽化。</li>
              <li>背景残留明显：提高容差，重新从背景纯色区取色。</li>
              <li>绿边/蓝边明显：开启溢色移除后再刷新预览。</li>
              <li>最终导出会使用下方这些参数重新在后端处理。</li>
            </ul>
            <button className="soft-wide" onClick={applyMatteToPreview} disabled={!frames.length || busy}>刷新抠像检查</button>
          </div>
        </section>

        <section className="two-col" id="step-5">
          <div className="panel sequence-panel">
            <div className="panel-title"><h2>5. 序列图预览</h2><span>{spriteUrl ? `透明序列图：${targetFrameSize.width * form.sheet_columns} × ${Math.ceil(frames.length / form.sheet_columns) * targetFrameSize.height}` : '等待生成'}</span></div>
            <div className="sequence-actions">
              <div className="tabbar"><button className={previewMode === 'sprite' ? 'active' : ''} onClick={() => setPreviewMode('sprite')}>序列图</button><button className={previewMode === 'animation' ? 'active' : ''} onClick={() => setPreviewMode('animation')}>动画预览</button></div>
              <button className="soft-btn" onClick={buildSpritePreview} disabled={!frames.length || busy}>生成 / 刷新序列图预览</button>
            </div>
            <div className="checker sequence-box">
              {previewMode === 'sprite' && (spriteUrl ? <img src={spriteUrl} /> : <p>点击上方“生成 / 刷新序列图预览”后显示。</p>)}
              {previewMode === 'animation' && (animationUrl ? <img className="anim-frame" src={animationUrl} /> : <p>暂无动画帧。</p>)}
            </div>
          </div>
          <div className="panel" id="step-6">
            <div className="panel-title"><h2>6. 导出结果</h2><span>本地下载</span></div>
            <p className="desc">支持导出序列图 PNG、动画 GIF、透明帧 ZIP 和 2D 动画兼容包。修改导出参数后，会按当前设置重新生成后端资源包。</p>
            <div className="field-grid two">
              <label>导出列数<input type="number" min="1" max="24" value={form.sheet_columns} onChange={e => setForm({ ...form, sheet_columns: Number(e.target.value) })} /></label>
              <label>导出间距<input type="number" min="0" max="64" value={form.sheet_gap} onChange={e => setForm({ ...form, sheet_gap: Number(e.target.value) })} /></label>
              <label>单帧尺寸预设<select value={form.frame_preset} onChange={e => setForm({ ...form, frame_preset: e.target.value })}><option value="original">原始比例</option><option value="32">32×32 内</option><option value="64">64×64 内</option><option value="128">128×128 内</option><option value="256">256×256 内</option><option value="custom">自定义</option></select></label>
              <div className="fake-label"><span>抠图导出</span><label className="inline-check"><input type="checkbox" checked={form.remove_background} onChange={e => setForm({ ...form, remove_background: e.target.checked })} />使用透明帧</label></div>
            </div>
            {form.frame_preset === 'custom' && <div className="field-grid two compact"><label>自定义宽<input type="number" min="1" value={form.custom_width} onChange={e => setForm({ ...form, custom_width: Number(e.target.value) })} /></label><label>自定义高<input type="number" min="1" value={form.custom_height} onChange={e => setForm({ ...form, custom_height: Number(e.target.value) })} /></label></div>}
            <div className="estimate-box"><span>预估导出尺寸</span><b>{targetFrameSize.width * form.sheet_columns + Math.max(0, form.sheet_columns - 1) * form.sheet_gap} × {Math.ceil(Math.max(1, frames.length || estimatedFrameCount) / form.sheet_columns) * targetFrameSize.height + Math.max(0, Math.ceil(Math.max(1, frames.length || estimatedFrameCount) / form.sheet_columns) - 1) * form.sheet_gap}</b><em>单帧 {targetFrameSize.width} × {targetFrameSize.height}</em></div>
            <button className="dark-wide" onClick={() => { setAdvancedOpen(true); setTimeout(() => document.getElementById('step-7')?.scrollIntoView({ behavior: 'smooth' }), 30) }}>展开高级导出设置</button>
            <button className="primary-wide" onClick={submit} disabled={!file || job?.status === 'running' || job?.status === 'queued'}>{job?.status === 'running' || job?.status === 'queued' ? '正在生成...' : '生成可下载资源包'}</button>
            {job && <><div className="progress"><i style={{ width: `${progressPercent}%` }} /></div><p className="status"><strong>{job.status}</strong> · {job.message} · {progressPercent}%</p>{job.error && <p className="error">{job.error}</p>}</>}
            {job?.outputs?.length ? <div className="downloads">{job.outputs.map(out => <a key={out.name} href={downloadUrl(out.url)} target="_blank" rel="noreferrer"><strong>{out.name}</strong><span>{bytes(out.size_bytes)}</span></a>)}</div> : null}
          </div>
        </section>

        <section className="panel advanced-panel" id="step-7">
          <div className="panel-title collapsible-title">
            <div>
              <h2>7. 高级导出</h2>
              <p className="desc no-margin">默认收起。这里放置面向 Spine / Godot 等后续动画工作流的兼容导出参数，不影响前面的序列帧主流程。</p>
            </div>
            <button className="soft-btn" onClick={() => setAdvancedOpen(v => !v)}>{advancedOpen ? '收起高级导出' : '展开高级导出'}</button>
          </div>
          {advancedOpen && <div className="spine-grid advanced-body">
            <div>
              <p className="desc">Spine 兼容包会生成 JSON 与 PNG 序列，通过 attachment timeline 逐帧切换图片。它适合继续进入 Spine 做骨骼、事件帧或碰撞点编辑；不会生成 atlas、.skel 或 .spine 工程文件。</p>
              <div className="field-grid two"><label>动画名称<input type="text" value={form.spine_animation} onChange={e => setForm({ ...form, spine_animation: e.target.value })} /></label><label>动画帧率<input type="number" value={form.fps} min="1" max="30" onChange={e => setForm({ ...form, fps: Number(e.target.value) })} /></label></div>
            </div>
            <div className="spine-card"><b>导入建议</b><p>先确认帧率、裁剪尺寸和抠图边缘，再下载兼容包。Godot 工作流通常优先使用 spritesheet、透明 PNG 序列或 GIF 预览。</p>{job?.outputs?.find(o => o.name === 'spine.zip') && <a className="download-one" href={downloadUrl(job.outputs.find(o => o.name === 'spine.zip')!.url)} target="_blank" rel="noreferrer">下载 Spine 兼容 ZIP</a>}</div>
          </div>}
        </section>
      </main>

      <footer>© 2026 Motion Sprite Studio · 本地视频序列帧处理工具</footer>
    </div>
  )
}

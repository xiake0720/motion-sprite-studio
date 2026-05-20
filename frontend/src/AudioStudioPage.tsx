import { useRef, useState } from 'react'
import { audioGenerate, downloadUrl } from './api'

type AudioResult = {
  id: string
  outputs: Array<{ name: string; url: string; size_bytes: number }>
  duration: number
  sample_rate: number
}

type Instrument =
  | 'piano' | 'epiano' | 'organ'
  | 'pad' | 'pluck' | 'bass' | 'lead'
  | 'bell' | 'marimba' | 'xylophone' | 'musicbox' | 'celesta' | 'kalimba'
  | 'harp' | 'guitar' | 'muted_guitar'
  | 'flute' | 'strings' | 'choir' | 'brass'
  | 'kick' | 'snare' | 'hihat' | 'clap' | 'tom' | 'cymbal' | 'shaker'
  | 'noise' | 'whoosh' | 'riser' | 'impact' | 'boom'

type Waveform = 'sine' | 'triangle' | 'square' | 'sawtooth'

type Track = {
  id: string
  name: string
  instrument: Instrument
  waveform: Waveform
  note: string
  octave: number
  transpose: number
  steps: boolean[]
  degrees: number[]
  volume: number
  pan: number
  gate: number
  attack: number
  decay: number
  sustain: number
  release: number
  cutoff: number
  resonance: number
  drive: number
  eqLow: number
  eqMid: number
  eqHigh: number
  reverbSend: number
  delaySend: number
  mute: boolean
  solo: boolean
}

const instruments: Array<{ key: Instrument; name: string; family: string; role: string }> = [
  { key: 'piano', name: '钢琴 Piano', family: '键盘', role: '旋律/和弦' },
  { key: 'epiano', name: '电钢 E-Piano', family: '键盘', role: '菜单/温馨' },
  { key: 'organ', name: '管风琴 Organ', family: '键盘', role: '复古/神秘' },
  { key: 'pad', name: '氛围垫 Pad', family: '合成器', role: '背景铺底' },
  { key: 'pluck', name: '拨弦 Pluck', family: '合成器', role: '跳跃旋律' },
  { key: 'bass', name: '低音 Bass', family: '贝斯', role: '根音/律动' },
  { key: 'lead', name: '主音 Lead', family: '合成器', role: '主题旋律' },
  { key: 'bell', name: '铃音 Bell', family: '梦幻', role: '提示/魔法' },
  { key: 'marimba', name: '马林巴 Marimba', family: '打击旋律', role: '轻快' },
  { key: 'xylophone', name: '木琴 Xylophone', family: '打击旋律', role: '童趣' },
  { key: 'musicbox', name: '八音盒 MusicBox', family: '梦幻', role: '睡前/治愈' },
  { key: 'celesta', name: '钢片琴 Celesta', family: '梦幻', role: '魔法闪光' },
  { key: 'kalimba', name: '拇指琴 Kalimba', family: '自然', role: '轻松' },
  { key: 'harp', name: '竖琴 Harp', family: '弦乐', role: '过场/闪光' },
  { key: 'guitar', name: '吉他 Guitar', family: '弦乐', role: '温暖伴奏' },
  { key: 'muted_guitar', name: '闷音吉他 Muted', family: '弦乐', role: '节奏切分' },
  { key: 'flute', name: '长笛 Flute', family: '管乐', role: '自然旋律' },
  { key: 'strings', name: '弦乐 Strings', family: '管弦', role: '情绪铺底' },
  { key: 'choir', name: '合唱 Choir', family: '人声', role: '神秘/史诗' },
  { key: 'brass', name: '铜管 Brass', family: '管弦', role: '战斗/胜利' },
  { key: 'kick', name: '底鼓 Kick', family: '鼓组', role: '低频节奏' },
  { key: 'snare', name: '军鼓 Snare', family: '鼓组', role: '重拍' },
  { key: 'hihat', name: '踩镲 Hi-Hat', family: '鼓组', role: '速度感' },
  { key: 'clap', name: '拍手 Clap', family: '鼓组', role: '强调拍' },
  { key: 'tom', name: '桶鼓 Tom', family: '鼓组', role: '过门' },
  { key: 'cymbal', name: '吊镲 Cymbal', family: '鼓组', role: '转场' },
  { key: 'shaker', name: '沙锤 Shaker', family: '打击', role: '律动' },
  { key: 'noise', name: '噪声 Noise', family: '特效', role: 'UI/环境' },
  { key: 'whoosh', name: '掠过 Whoosh', family: '特效', role: '技能/转场' },
  { key: 'riser', name: '上升 Riser', family: '特效', role: '蓄力' },
  { key: 'impact', name: '冲击 Impact', family: '特效', role: '命中/爆点' },
  { key: 'boom', name: '低频 Boom', family: '特效', role: 'Boss/爆炸' },
]

const notes = ['C2', 'D2', 'E2', 'F2', 'G2', 'A2', 'B2', 'C3', 'D3', 'E3', 'F3', 'G3', 'A3', 'B3', 'C4', 'D4', 'E4', 'F4', 'G4', 'A4', 'B4', 'C5', 'D5', 'E5', 'F5', 'G5', 'A5', 'B5', 'C6']
const roots = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const scales = [
  { key: 'major', name: '大调 Major' },
  { key: 'minor', name: '小调 Minor' },
  { key: 'pentatonic', name: '五声音阶 Pentatonic' },
  { key: 'dorian', name: 'Dorian' },
]

function formatSize(size: number) {
  if (!size) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let n = size
  let i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`
}

function emptyPattern(len = 32) {
  return Array.from({ length: len }, () => false)
}

function defaultTrack(instrument: Instrument, length = 32): Track {
  const isDrum = ['kick', 'snare', 'hihat', 'clap', 'tom', 'cymbal', 'shaker'].includes(instrument)
  const isFx = ['noise', 'whoosh', 'riser', 'impact', 'boom'].includes(instrument)
  const family = instruments.find(item => item.key === instrument)
  const baseSteps = emptyPattern(length)
  if (instrument === 'kick') [0, 8, 16, 24].forEach(i => { if (i < length) baseSteps[i] = true })
  if (instrument === 'snare' || instrument === 'clap') [8, 24].forEach(i => { if (i < length) baseSteps[i] = true })
  if (instrument === 'hihat' || instrument === 'shaker') baseSteps.forEach((_, i) => { if (i % 2 === 0) baseSteps[i] = true })
  return {
    id: `${instrument}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
    name: family?.name.split(' ')[0] || '新轨道',
    instrument,
    waveform: instrument === 'lead' ? 'sawtooth' : instrument === 'bass' ? 'sine' : 'triangle',
    note: isDrum ? 'C2' : '',
    octave: instrument === 'bass' ? 2 : isDrum ? 2 : isFx ? 3 : 4,
    transpose: 0,
    steps: baseSteps,
    degrees: [0, 2, 4, 7, 4, 2, 5, 7],
    volume: isDrum ? 0.7 : isFx ? 0.55 : 0.58,
    pan: 0,
    gate: isDrum ? 0.65 : isFx ? 1.2 : 0.78,
    attack: isDrum ? 0.001 : instrument === 'pad' || instrument === 'strings' || instrument === 'choir' ? 0.12 : 0.008,
    decay: isDrum ? 0.14 : 0.18,
    sustain: isDrum || isFx ? 0.02 : instrument === 'pad' || instrument === 'strings' || instrument === 'choir' ? 0.72 : 0.38,
    release: isDrum ? 0.08 : instrument === 'pad' || instrument === 'strings' || instrument === 'choir' ? 0.38 : 0.16,
    cutoff: isDrum ? 6000 : instrument === 'bass' ? 1800 : 9000,
    resonance: 0.15,
    drive: isDrum ? 0.08 : 0,
    eqLow: 0,
    eqMid: 0,
    eqHigh: 0,
    reverbSend: isDrum ? 0.03 : 0.18,
    delaySend: 0.04,
    mute: false,
    solo: false,
  }
}

function createNoiseBuffer(ctx: AudioContext, duration: number) {
  const buffer = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * duration)), ctx.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
  return buffer
}

function noteToFreq(note = 'C4') {
  const match = /^([A-G]#?)(-?\d)$/.exec(note)
  if (!match) return 440
  const table: Record<string, number> = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 }
  const midi = (Number(match[2]) + 1) * 12 + table[match[1]]
  return 440 * Math.pow(2, (midi - 69) / 12)
}

function playInstrument(ctx: AudioContext, track: Track, start: number, duration: number, freq: number, destination: AudioNode, nodes: AudioScheduledSourceNode[]) {
  const inst = track.instrument
  const gain = ctx.createGain()
  const filter = ctx.createBiquadFilter()
  const pan = ctx.createStereoPanner()
  filter.type = 'lowpass'
  filter.frequency.setValueAtTime(Math.max(80, track.cutoff), start)
  filter.Q.value = track.resonance * 10
  pan.pan.value = track.pan
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.linearRampToValueAtTime(track.volume, start + Math.max(0.001, track.attack))
  gain.gain.linearRampToValueAtTime(track.volume * track.sustain, start + track.attack + track.decay)
  gain.gain.setValueAtTime(track.volume * track.sustain, start + Math.max(0.01, duration - track.release))
  gain.gain.linearRampToValueAtTime(0.0001, start + duration)
  filter.connect(pan); pan.connect(gain); gain.connect(destination)

  if (['snare', 'hihat', 'clap', 'noise', 'shaker', 'cymbal', 'whoosh', 'riser'].includes(inst)) {
    const noise = ctx.createBufferSource()
    noise.buffer = createNoiseBuffer(ctx, duration)
    noise.connect(filter)
    noise.start(start); noise.stop(start + duration)
    nodes.push(noise)
    if (inst === 'snare') {
      const tone = ctx.createOscillator(); tone.type = 'triangle'; tone.frequency.value = 180; tone.connect(filter); tone.start(start); tone.stop(start + Math.min(duration, 0.18)); nodes.push(tone)
    }
    return
  }

  const oscTypes: OscillatorType[] = inst === 'piano' ? ['sine', 'sine'] : inst === 'pad' || inst === 'strings' ? ['sawtooth', 'triangle'] : inst === 'bass' ? ['sine', 'square'] : ['sine', track.waveform === 'sawtooth' ? 'sawtooth' : track.waveform]
  oscTypes.forEach((type, index) => {
    const osc = ctx.createOscillator()
    osc.type = type
    const ratio = inst === 'bell' || inst === 'musicbox' || inst === 'celesta' ? [1, 2.41][index] || 1 : index === 1 ? (inst === 'bass' ? 0.5 : 2) : 1
    osc.frequency.setValueAtTime(freq * ratio, start)
    if (inst === 'kick' || inst === 'impact' || inst === 'boom' || inst === 'tom') osc.frequency.exponentialRampToValueAtTime(Math.max(35, freq * 0.4), start + Math.min(0.22, duration))
    const og = ctx.createGain()
    og.gain.value = index === 0 ? 1 : 0.18
    osc.connect(og); og.connect(filter)
    osc.start(start); osc.stop(start + duration)
    nodes.push(osc)
  })
}

export function AudioStudioPage() {
  const [tracks, setTracks] = useState<Track[]>([])
  const [selectedInstrument, setSelectedInstrument] = useState<Instrument>('piano')
  const [bpm, setBpm] = useState(100)
  const [bars, setBars] = useState(4)
  const [stepCount, setStepCount] = useState(32)
  const [root, setRoot] = useState('C')
  const [scale, setScale] = useState('major')
  const [swing, setSwing] = useState(0.08)
  const [masterVolume, setMasterVolume] = useState(0.86)
  const [reverb, setReverb] = useState(0.22)
  const [delay, setDelay] = useState(0.06)
  const [exportStems, setExportStems] = useState(false)
  const [result, setResult] = useState<AudioResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const audioCtxRef = useRef<AudioContext | null>(null)
  const activeNodes = useRef<AudioScheduledSourceNode[]>([])

  function addTrack(instrument = selectedInstrument) {
    setTracks(current => [...current, defaultTrack(instrument, stepCount)])
  }

  function removeTrack(id: string) {
    setTracks(current => current.filter(track => track.id !== id))
  }

  function updateTrack(id: string, patch: Partial<Track>) {
    setTracks(current => current.map(track => track.id === id ? { ...track, ...patch } : track))
  }

  function toggleStep(id: string, index: number) {
    setTracks(current => current.map(track => track.id === id ? { ...track, steps: track.steps.map((value, i) => i === index ? !value : value) } : track))
  }

  function changeStepCount(next: number) {
    setStepCount(next)
    setTracks(current => current.map(track => {
      const steps = emptyPattern(next)
      for (let i = 0; i < Math.min(track.steps.length, next); i++) steps[i] = track.steps[i]
      return { ...track, steps }
    }))
  }

  function randomizeTrack(id: string, density = 0.35) {
    setTracks(current => current.map(track => {
      if (track.id !== id) return track
      const next = track.steps.map((_, index) => {
        if (['kick'].includes(track.instrument)) return index % 8 === 0 || Math.random() < 0.08
        if (['snare', 'clap'].includes(track.instrument)) return index % 16 === 8 || Math.random() < 0.06
        if (['hihat', 'shaker'].includes(track.instrument)) return index % 2 === 0 || Math.random() < 0.12
        if (['cymbal', 'impact', 'boom'].includes(track.instrument)) return index === 0 || Math.random() < 0.04
        return Math.random() < density
      })
      return { ...track, steps: next }
    }))
  }

  function clearTrack(id: string) {
    setTracks(current => current.map(track => track.id === id ? { ...track, steps: emptyPattern(track.steps.length) } : track))
  }

  function getCtx() {
    if (!audioCtxRef.current) audioCtxRef.current = new AudioContext()
    return audioCtxRef.current
  }

  function stopPlayback() {
    activeNodes.current.forEach(node => {
      try { node.stop() } catch { /* already stopped */ }
    })
    activeNodes.current = []
  }

  function playArrangement() {
    stopPlayback()
    if (!tracks.length) {
      setError('请先添加至少一条轨道')
      return
    }
    setError('')
    const ctx = getCtx()
    const master = ctx.createGain()
    master.gain.value = masterVolume
    const compressor = ctx.createDynamicsCompressor()
    compressor.threshold.value = -16
    compressor.knee.value = 16
    compressor.ratio.value = 3
    compressor.attack.value = 0.008
    compressor.release.value = 0.18
    master.connect(compressor); compressor.connect(ctx.destination)
    const now = ctx.currentTime + 0.05
    const total = bars * 4 * 60 / bpm
    const solo = tracks.filter(track => track.solo)
    const active = solo.length ? solo : tracks
    active.filter(track => !track.mute).forEach(track => {
      const stepDur = total / track.steps.length
      track.steps.forEach((on, stepIndex) => {
        if (!on) return
        const swingOffset = stepIndex % 2 ? swing * stepDur * 0.45 : 0
        const start = now + stepIndex * stepDur + swingOffset
        const dur = Math.min(stepDur * track.gate, total - stepIndex * stepDur)
        const autoNote = notes[(track.degrees[stepIndex % track.degrees.length] + track.octave * 4 + track.transpose + notes.length) % notes.length] || 'C4'
        const note = track.note || autoNote
        const freq = ['kick'].includes(track.instrument) ? 58 : ['snare', 'clap'].includes(track.instrument) ? 180 : ['tom'].includes(track.instrument) ? 120 : ['hihat', 'cymbal', 'shaker', 'noise', 'whoosh', 'riser'].includes(track.instrument) ? 6600 : ['impact', 'boom'].includes(track.instrument) ? 72 : noteToFreq(note)
        playInstrument(ctx, track, start, dur, freq, master, activeNodes.current)
      })
    })
  }

  async function generateDownloads() {
    setError('')
    if (!tracks.length) {
      setError('请先添加至少一条轨道')
      return
    }
    setBusy(true)
    try {
      const payload = { mode: 'studio', bpm, bars, root, scale, swing, masterVolume, reverb, delay, exportStems, seed: 17, tracks }
      const data = await audioGenerate(payload) as AudioResult
      setResult(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : '音频生成失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="tool-page audio-page daw-page">
      {error && <div className="global-error">{error}</div>}
      {busy && <div className="global-busy">正在渲染总混音频，请稍等……</div>}

      <section className="panel daw-topbar">
        <div className="panel-title"><h2>音乐制作台</h2><span>自行添加轨道 / 多乐器 / 专业混音 / 总混导出</span></div>
        <div className="transport-row">
          <button className="primary-button" onClick={playArrangement}>▶ 播放工程</button>
          <button className="ghost-button" onClick={stopPlayback}>■ 停止</button>
          <button className="soft-wide" onClick={generateDownloads} disabled={busy}>{busy ? '渲染中...' : '渲染总混 WAV + 工程 ZIP'}</button>
        </div>
        <div className="studio-controls">
          <label>BPM<input type="number" min="40" max="220" value={bpm} onChange={e => setBpm(Number(e.target.value))} /></label>
          <label>小节<select value={bars} onChange={e => setBars(Number(e.target.value))}><option value="2">2</option><option value="4">4</option><option value="8">8</option><option value="16">16</option></select></label>
          <label>步数<select value={stepCount} onChange={e => changeStepCount(Number(e.target.value))}><option value="16">16</option><option value="32">32</option><option value="64">64</option></select></label>
          <label>调性<select value={root} onChange={e => setRoot(e.target.value)}>{roots.map(item => <option key={item} value={item}>{item}</option>)}</select></label>
          <label>音阶<select value={scale} onChange={e => setScale(e.target.value)}>{scales.map(item => <option key={item.key} value={item.key}>{item.name}</option>)}</select></label>
          <label>Swing {swing.toFixed(2)}<input type="range" min="0" max="0.65" step="0.01" value={swing} onChange={e => setSwing(Number(e.target.value))} /></label>
          <label>Master {masterVolume.toFixed(2)}<input type="range" min="0.05" max="1.2" step="0.01" value={masterVolume} onChange={e => setMasterVolume(Number(e.target.value))} /></label>
          <label>Room 混响 {reverb.toFixed(2)}<input type="range" min="0" max="0.95" step="0.01" value={reverb} onChange={e => setReverb(Number(e.target.value))} /></label>
          <label>Delay 延迟 {delay.toFixed(2)}<input type="range" min="0" max="0.8" step="0.01" value={delay} onChange={e => setDelay(Number(e.target.value))} /></label>
          <label className="inline-check"><input type="checkbox" checked={exportStems} onChange={e => setExportStems(e.target.checked)} /> 同时导出分轨</label>
        </div>
      </section>

      <section className="panel instrument-library">
        <div className="panel-title"><h2>添加轨道</h2><span>不是固定轨道，需要哪个乐器就添加哪个</span></div>
        <div className="add-track-row">
          <select value={selectedInstrument} onChange={e => setSelectedInstrument(e.target.value as Instrument)}>{instruments.map(item => <option key={item.key} value={item.key}>{item.name} · {item.role}</option>)}</select>
          <button className="primary-button" onClick={() => addTrack()}>+ 添加轨道</button>
          <button className="ghost-button" onClick={() => { addTrack('musicbox'); addTrack('kalimba'); addTrack('pad'); addTrack('bass'); addTrack('kick'); addTrack('snare') }}>添加温馨游戏模板</button>
          <button className="ghost-button" onClick={() => { addTrack('brass'); addTrack('strings'); addTrack('lead'); addTrack('bass'); addTrack('kick'); addTrack('snare'); addTrack('cymbal') }}>添加战斗游戏模板</button>
        </div>
        <div className="instrument-pills dense">{instruments.map(item => <button key={item.key} onClick={() => addTrack(item.key)}><b>{item.name}</b><small>{item.family} · {item.role}</small></button>)}</div>
      </section>

      <section className="panel track-editor">
        <div className="panel-title"><h2>轨道编排</h2><span>{tracks.length ? `${tracks.length} 条轨道` : '先添加轨道'}</span></div>
        {tracks.length ? <div className="step-ruler" style={{ gridTemplateColumns: `repeat(${stepCount}, minmax(18px, 1fr))` }}>{Array.from({ length: stepCount }).map((_, index) => <span key={index} className={index % 8 === 0 ? 'bar' : ''}>{index % 4 === 0 ? index + 1 : ''}</span>)}</div> : null}
        <div className="tracks-stack">
          {tracks.length ? tracks.map(track => <div className="track-strip pro-track" key={track.id}>
            <div className="track-head">
              <input value={track.name} onChange={e => updateTrack(track.id, { name: e.target.value })} />
              <select value={track.instrument} onChange={e => updateTrack(track.id, { instrument: e.target.value as Instrument })}>{instruments.map(item => <option key={item.key} value={item.key}>{item.name}</option>)}</select>
              <button className={track.mute ? 'active danger' : ''} onClick={() => updateTrack(track.id, { mute: !track.mute })}>M</button>
              <button className={track.solo ? 'active' : ''} onClick={() => updateTrack(track.id, { solo: !track.solo })}>S</button>
              <button onClick={() => randomizeTrack(track.id)}>随机节奏</button>
              <button onClick={() => clearTrack(track.id)}>清空</button>
              <button className="danger" onClick={() => removeTrack(track.id)}>删除</button>
            </div>
            <div className="sequencer-row" style={{ gridTemplateColumns: `repeat(${stepCount}, minmax(18px, 1fr))` }}>{track.steps.map((on, index) => <button key={index} className={`${on ? 'on' : ''} ${index % 8 === 0 ? 'bar' : ''}`} onClick={() => toggleStep(track.id, index)}>{index % 4 === 0 ? '●' : ''}</button>)}</div>
            <div className="track-params pro-params">
              <label>音符<select value={track.note} onChange={e => updateTrack(track.id, { note: e.target.value })}><option value="">按音阶自动</option>{notes.map(note => <option key={note} value={note}>{note}</option>)}</select></label>
              <label>Oct<input type="number" min="1" max="7" value={track.octave} onChange={e => updateTrack(track.id, { octave: Number(e.target.value) })} /></label>
              <label>Transpose<input type="number" min="-24" max="24" value={track.transpose} onChange={e => updateTrack(track.id, { transpose: Number(e.target.value) })} /></label>
              <label>Wave<select value={track.waveform} onChange={e => updateTrack(track.id, { waveform: e.target.value as Waveform })}><option value="sine">Sine</option><option value="triangle">Triangle</option><option value="square">Square</option><option value="sawtooth">Saw</option></select></label>
              <label>Gate {track.gate.toFixed(2)}<input type="range" min="0.05" max="3" step="0.01" value={track.gate} onChange={e => updateTrack(track.id, { gate: Number(e.target.value) })} /></label>
              <label>A<input type="number" min="0" max="2" step="0.001" value={track.attack} onChange={e => updateTrack(track.id, { attack: Number(e.target.value) })} /></label>
              <label>D<input type="number" min="0" max="2" step="0.001" value={track.decay} onChange={e => updateTrack(track.id, { decay: Number(e.target.value) })} /></label>
              <label>S {track.sustain.toFixed(2)}<input type="range" min="0" max="1" step="0.01" value={track.sustain} onChange={e => updateTrack(track.id, { sustain: Number(e.target.value) })} /></label>
              <label>R<input type="number" min="0" max="2" step="0.001" value={track.release} onChange={e => updateTrack(track.id, { release: Number(e.target.value) })} /></label>
              <label>Cutoff<input type="number" min="80" max="18000" value={track.cutoff} onChange={e => updateTrack(track.id, { cutoff: Number(e.target.value) })} /></label>
              <label>Res {track.resonance.toFixed(2)}<input type="range" min="0" max="1" step="0.01" value={track.resonance} onChange={e => updateTrack(track.id, { resonance: Number(e.target.value) })} /></label>
              <label>Drive {track.drive.toFixed(2)}<input type="range" min="0" max="1" step="0.01" value={track.drive} onChange={e => updateTrack(track.id, { drive: Number(e.target.value) })} /></label>
            </div>
          </div>) : <div className="empty-card">当前没有固定轨道。请从上面的乐器库添加轨道，再在步进音序器里编排节奏。</div>}
        </div>
      </section>

      <section className="module-grid preview-layout mixer-layout">
        <div className="panel mixer-panel pro-mixer">
          <div className="panel-title"><h2>专业混音面板</h2><span>音量 / 声像 / EQ / 发送效果</span></div>
          {tracks.length ? <div className="mixer-strips pro-mixer-strips">{tracks.map(track => <div className="mixer-strip pro-mixer-strip" key={track.id}>
            <b>{track.name}</b>
            <small>{instruments.find(item => item.key === track.instrument)?.name}</small>
            <label>Vol<input className="vertical-range" type="range" min="0" max="1.4" step="0.01" value={track.volume} onChange={e => updateTrack(track.id, { volume: Number(e.target.value) })} /></label>
            <div className="meter"><i style={{ height: `${Math.round(track.volume * 76)}px` }} /></div>
            <label>Pan {track.pan.toFixed(2)}<input type="range" min="-1" max="1" step="0.01" value={track.pan} onChange={e => updateTrack(track.id, { pan: Number(e.target.value) })} /></label>
            <label>Low {track.eqLow.toFixed(1)}<input type="range" min="-1" max="1" step="0.01" value={track.eqLow} onChange={e => updateTrack(track.id, { eqLow: Number(e.target.value) })} /></label>
            <label>Mid {track.eqMid.toFixed(1)}<input type="range" min="-1" max="1" step="0.01" value={track.eqMid} onChange={e => updateTrack(track.id, { eqMid: Number(e.target.value) })} /></label>
            <label>High {track.eqHigh.toFixed(1)}<input type="range" min="-1" max="1" step="0.01" value={track.eqHigh} onChange={e => updateTrack(track.id, { eqHigh: Number(e.target.value) })} /></label>
            <label>Rev {track.reverbSend.toFixed(2)}<input type="range" min="0" max="1" step="0.01" value={track.reverbSend} onChange={e => updateTrack(track.id, { reverbSend: Number(e.target.value) })} /></label>
            <label>Dly {track.delaySend.toFixed(2)}<input type="range" min="0" max="1" step="0.01" value={track.delaySend} onChange={e => updateTrack(track.id, { delaySend: Number(e.target.value) })} /></label>
          </div>)}</div> : <div className="empty-card">添加轨道后，这里会出现类似调音台的每轨控制条。</div>}
        </div>
        <div className="panel">
          <div className="panel-title"><h2>导出结果</h2><span>{result ? `${result.sample_rate}Hz / ${result.duration.toFixed(2)}s` : '等待渲染'}</span></div>
          {result ? <div className="downloads">{result.outputs.map(out => <a key={out.name} href={downloadUrl(out.url)} target="_blank" rel="noreferrer"><strong>{out.name}</strong><span>{formatSize(out.size_bytes)}</span></a>)}</div> : <div className="empty-card">点击“渲染总混 WAV + 工程 ZIP”后，这里会提供已混响、已混音的总混 WAV、工程 JSON 和 ZIP 下载；分轨导出默认为关闭。</div>}
        </div>
      </section>
    </div>
  )
}

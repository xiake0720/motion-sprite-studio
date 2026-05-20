import { useState } from 'react'
import { VideoToFramesPage } from './VideoToFramesPage'
import { ImageCutoutPage } from './ImageCutoutPage'
import { AudioStudioPage } from './AudioStudioPage'

type ModuleKey = 'video' | 'image' | 'audio'

const modules: Array<{ key: ModuleKey; title: string; subtitle: string; icon: string }> = [
  { key: 'video', title: '视频转序列帧', subtitle: '动画视频、抠像、精灵图导出', icon: '🎞️' },
  { key: 'image', title: '图片抠图', subtitle: '单图、批量、素材拆分与合并', icon: '✂️' },
  { key: 'audio', title: '音乐制作', subtitle: '游戏音效、短循环与下载包', icon: '🎧' },
]

export default function App() {
  const [active, setActive] = useState<ModuleKey>('video')
  const current = modules.find(item => item.key === active) || modules[0]

  return (
    <div className="suite-shell">
      <header className="suite-topbar">
        <div className="suite-brand">
          <div className="suite-logo">G</div>
          <div>
            <h1>Game Asset Studio</h1>
            <p>面向游戏开发的素材处理工作台：视频、图片、音频一站式生成。</p>
          </div>
        </div>
        <nav className="suite-tabs" aria-label="功能模块切换">
          {modules.map(item => (
            <button
              key={item.key}
              type="button"
              className={active === item.key ? 'active' : ''}
              onClick={() => setActive(item.key)}
            >
              <span>{item.icon}</span>
              <b>{item.title}</b>
              <small>{item.subtitle}</small>
            </button>
          ))}
        </nav>
      </header>

      <section className="module-intro">
        <div>
          <span className="module-kicker">当前模块</span>
          <h2>{current.icon} {current.title}</h2>
          <p>{current.subtitle}</p>
        </div>
        <div className="module-badges">
          <span>本地预览</span>
          <span>Python 后端增强</span>
          <span>4G 云服友好</span>
        </div>
      </section>

      <div className="suite-body">
        {active === 'video' && <VideoToFramesPage />}
        {active === 'image' && <ImageCutoutPage />}
        {active === 'audio' && <AudioStudioPage />}
      </div>
    </div>
  )
}

# Game Asset Studio

一个面向游戏开发和 AI 素材整理的本地化工具箱，整合三类常用工作流：

1. **视频转序列帧**：视频裁剪、提帧、ChromaKey 抠像、透明 PNG、精灵图、GIF、高级动画兼容包。
2. **图片抠图**：单图/批量抠图、多点背景采样、指定扣除点、指定保留点、透明边裁剪、素材自动拆分、精灵图合并、TexturePacker JSON 和 CSS Sprite。
3. **音乐制作**：自行添加音轨、多乐器库、步进音序器、ADSR/滤波/驱动/EQ/混响发送/延迟发送、专业混音面板、Python 后端总混 WAV/ZIP 导出。

技术方案：

- 前端：Vite + React + TypeScript
- 后端：FastAPI + OpenCV + Pillow + NumPy + ImageIO
- 部署：Docker Compose / 本地开发脚本
- 资源策略：单任务、逐帧/逐文件处理、结果落盘，适合 4G 内存云服务器自用部署

---

## 功能清单

### 视频转序列帧

- 上传本地视频
- 自定义播放/暂停、时间轴拖动、前后 1 秒微调
- 拖拽画面裁剪，裁剪预览实时刷新
- 设置起止时间、FPS、最大帧数
- 从视频画面或参考帧取背景色
- 容差、羽化、去溢色、边缘平滑、Mask 补洞
- 抠像结果、Alpha 蒙版、纯色底检查
- 序列图预览与动画预览
- 导出透明 PNG ZIP、sprite sheet、GIF、2D 动画兼容包、处理报告

### 图片抠图

- 单图抠图、批量抠图
- 自动背景色检测、白底、黑底、指定纯色、多点采样、保留透明通道
- 可在原图上点击添加背景采样点、指定扣除点、指定保留点，支持多次处理迭代
- 容差、羽化、腐蚀、扩张、局部强制扣除、保护区域、透明边裁剪
- 自动识别素材块并拆分为独立 PNG/WEBP
- 合成透明精灵图
- 导出 TexturePacker JSON、CSS Sprite、报告文件和 ZIP 包

### 音乐制作

- 自行添加任意音轨，不再固定预设轨道
- 多乐器库：钢琴、电钢、管风琴、Pad、Lead、Bass、铃音、木琴、八音盒、钢片琴、拇指琴、竖琴、吉他、长笛、弦乐、合唱、铜管、鼓组、转场 FX 等
- 每轨独立步进音序器、音量、声像、Gate、ADSR、滤波、共振、驱动、三段 EQ、混响发送、延迟发送、Mute/Solo
- 专业混音面板，默认导出带混响与延迟的总混 WAV
- 可选导出分轨 WAV、工程 JSON 和 ZIP 包

---

## 4G 云服务器建议配置

推荐限制：

```env
VTS_MAX_UPLOAD_MB=200
VTS_MAX_DURATION_SECONDS=60
VTS_MAX_FRAMES=120
VTS_MAX_WIDTH=1920
VTS_MAX_HEIGHT=1080
VTS_WORKERS=1
```

启动时不要开多个 worker：

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 1
```

---

## 本地开发启动

### Windows 一键启动

双击或运行：

```bat
scripts\start-dev.bat
```

前端访问：

```text
http://localhost:5173
```

### 手动启动后端

```bash
cd backend
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1 --log-level debug
```

### 手动启动前端

```bash
cd frontend
npm install
npm run dev
```

---

## 生产部署：Docker 一键启动

服务器需要先安装 Docker / Docker Compose。

```bash
cd game-asset-studio
docker compose up -d --build
```

访问：

```text
http://服务器IP:8000
```

默认数据目录：

```text
./data
```

里面会保存上传文件、处理帧和输出结果。可以定期清理旧任务目录。

---

## Nginx 反向代理示例

参考 `deploy/nginx.example.conf`。

核心配置：

```nginx
location / {
    proxy_pass http://127.0.0.1:8000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 220m;
}
```

---

## 常见问题

### 1. 视频抠图边缘有绿边怎么办？

提高“去溢色”；适当提高羽化；如果主体边缘被吃掉，降低容差。

### 2. 图片抠图出现背景残留怎么办？

先用“多点采样”在背景阴影、边缘噪点处多点点击；如果仍有残留，用“指定扣除点”点在残留区域；如果主体细节被误扣，用“指定保留点”点在主体上，然后再次处理。白边严重时提高去白边/去色边，必要时轻微增加边缘收缩。

### 3. 4G 内存会不会爆？

默认是逐帧/逐文件处理并落盘，不会一次性把所有资源加载进内存。仍建议限制最大时长、最大帧数和并发任务数。

### 4. GIF 透明效果不完美？

GIF 透明只有单通道透明，不适合复杂半透明边缘。游戏素材建议优先用 PNG 序列或 sprite sheet。

---

## 目录结构

```text
game-asset-studio/
├─ backend/
│  ├─ app/
│  │  ├─ main.py
│  │  ├─ config.py
│  │  ├─ chroma.py
│  │  ├─ processor.py
│  │  ├─ exporter.py
│  │  ├─ image_tools.py
│  │  ├─ audio_tools.py
│  │  └─ jobs.py
│  └─ requirements.txt
├─ frontend/
│  ├─ src/
│  │  ├─ App.tsx
│  │  ├─ VideoToFramesPage.tsx
│  │  ├─ ImageCutoutPage.tsx
│  │  ├─ AudioStudioPage.tsx
│  │  ├─ api.ts
│  │  ├─ types.ts
│  │  ├─ main.tsx
│  │  └─ style.css
│  ├─ package.json
│  └─ vite.config.ts
├─ deploy/
├─ scripts/
├─ Dockerfile
├─ docker-compose.yml
└─ README.md
```

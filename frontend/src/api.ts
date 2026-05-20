import type { JobState } from './types'

const API_BASE = import.meta.env.VITE_API_BASE || ''

export async function createJob(formData: FormData): Promise<JobState> {
  const res = await fetch(`${API_BASE}/api/jobs`, {
    method: 'POST',
    body: formData,
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.detail || `请求失败：${res.status}`)
  }
  return res.json()
}

export async function getJob(jobId: string): Promise<JobState> {
  const res = await fetch(`${API_BASE}/api/jobs/${jobId}`)
  if (!res.ok) throw new Error(`任务查询失败：${res.status}`)
  return res.json()
}

export function downloadUrl(url: string) {
  return `${API_BASE}${url}`
}

export async function imageCutout(formData: FormData): Promise<unknown> {
  const res = await fetch(`${API_BASE}/api/image/cutout`, {
    method: 'POST',
    body: formData,
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.detail || `图片处理失败：${res.status}`)
  }
  return res.json()
}

export async function audioGenerate(payload: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${API_BASE}/api/audio/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.detail || `音频生成失败：${res.status}`)
  }
  return res.json()
}

const key = 'vsm_stale_chunk_reload_at'
const now = Date.now()

try {
  const last = Number(window.sessionStorage.getItem(key) || 0)
  if (!last || now - last > 5000) {
    window.sessionStorage.setItem(key, String(now))
    window.location.reload()
  }
} catch {
  window.location.reload()
}

export {}

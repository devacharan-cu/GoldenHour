// Attention aids for incoming requests: a short chime and (if permitted) a desktop notification while the tab is hidden.

let ctx: AudioContext | null = null

/** Two short rising tones. Browsers only allow audio after a user gesture, so this fails quietly until the page has been clicked. */
export function chime(): void {
  try {
    ctx ??= new (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
    if (ctx.state === 'suspended') void ctx.resume()
    const t0 = ctx.currentTime
    ;[660, 880].forEach((f, i) => {
      const o = ctx!.createOscillator()
      const g = ctx!.createGain()
      o.type = 'sine'
      o.frequency.value = f
      g.gain.setValueAtTime(0.0001, t0 + i * 0.16)
      g.gain.exponentialRampToValueAtTime(0.18, t0 + i * 0.16 + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.16 + 0.15)
      o.connect(g).connect(ctx!.destination)
      o.start(t0 + i * 0.16)
      o.stop(t0 + i * 0.16 + 0.16)
    })
  } catch { /* audio unavailable */ }
}

export function notificationState(): 'unsupported' | NotificationPermission {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
}

export async function askNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (typeof Notification === 'undefined') return 'unsupported'
  return Notification.requestPermission()
}

export function desktopNotify(title: string, body: string): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || !document.hidden) return
  try { new Notification(title, { body, icon: '/icons/icon-192.png', tag: 'goldenhour-request' }) } catch { /* ignore */ }
}

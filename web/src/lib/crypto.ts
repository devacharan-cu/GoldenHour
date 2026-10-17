/** Hex-encoded SHA-256 of a string or bytes. Uses the platform's Web Crypto (browsers and Node 20+). */
export async function sha256Hex(data: string | Uint8Array | ArrayBuffer): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data)
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** A 192-bit random secret, URL-safe. Used for report receipts. */
export function randomSecret(bytes = 24): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes))
  let s = ''
  for (const b of raw) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** A receipt is "<caseId>.<secret>". Only the hash of the secret is ever stored with the case. */
export function formatReceipt(caseId: string, secret: string): string {
  return `${caseId}.${secret}`
}

export function parseReceipt(input: string): { caseId: string; secret: string } | null {
  const text = input.trim().replace(/^.*#\/r\//, '').replace(/^GH-/i, '')
  const m = /^([A-Za-z0-9]{20})[.\-:]([A-Za-z0-9_-]{20,64})$/.exec(text)
  return m ? { caseId: m[1], secret: m[2] } : null
}

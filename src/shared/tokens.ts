// Ports of the web app's automation token model and resolver
// (Revjuvenate-Web/src/hooks/useAutomationTokens.ts and
// Revjuvenate-Web/src/lib/automation/tokenResolver.ts).
// `automation_tokens` is RLS-scoped to the signed-in user, so the extension
// reads/writes it directly with its own Supabase client.

export type TokenSource = 'data_column' | 'static' | 'login_config' | 'sensitive'
export type LoginField = 'username' | 'password' | 'totp_code' | 'sso_email' | 'sso_password'

export interface AutomationToken {
  id: string
  user_id: string
  property_id: string | null
  name: string
  description: string | null
  source: TokenSource
  data_column: string | null
  static_value: string | null
  login_field: LoginField | null
  is_sensitive: boolean
  created_at: string
  updated_at: string
}

export type DataRow = Record<string, unknown>
export type SensitiveValues = Record<string, string>

export const TOKEN_NAME_RE = /^[A-Z][A-Z0-9_]*$/
export const SENSITIVE_HEADER_RE = /pass|secret|token|otp|2fa|cc|cvv|cvc/i
const TOKEN_REF_RE = /\{\{([A-Z][A-Z0-9_]*)\}\}/g
const COLUMN_REF_RE = /\{\{(?:col:|\$)([^}]+)\}\}/g

/** Mirror of the web app's headerToTokenName: strip diacritics, uppercase,
 *  non-alphanumerics to _, prefix COL_ when it doesn't start with a letter,
 *  truncate to 64 chars. */
export function headerToTokenName(header: string): string {
  const normalized = header
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  const prefixed = /^[A-Z]/.test(normalized) ? normalized : `COL_${normalized}`
  return prefixed.slice(0, 64) || 'COL'
}

/** Pull token names referenced as `{{NAME}}` from any step strings. */
export function collectReferencedTokens(
  steps: { xpath?: string; default_value?: string }[],
): Set<string> {
  const out = new Set<string>()
  for (const s of steps) {
    for (const v of [s.xpath, s.default_value]) {
      if (!v) continue
      let m: RegExpExecArray | null
      TOKEN_REF_RE.lastIndex = 0
      while ((m = TOKEN_REF_RE.exec(v))) out.add(m[1])
    }
  }
  return out
}

/** Pull implicit column references like `{{col:Header}}` / `{{$Header}}`. */
export function collectReferencedColumns(
  steps: { xpath?: string; default_value?: string }[],
): Set<string> {
  const out = new Set<string>()
  for (const s of steps) {
    for (const v of [s.xpath, s.default_value]) {
      if (!v) continue
      let m: RegExpExecArray | null
      COLUMN_REF_RE.lastIndex = 0
      while ((m = COLUMN_REF_RE.exec(v))) out.add(m[1].trim())
    }
  }
  return out
}

/** Sensitive tokens (source === "sensitive" OR is_sensitive) referenced by
 *  the recipe that we don't have runtime values for yet. */
export function findMissingSensitiveTokens(
  tokens: AutomationToken[],
  referencedNames: Set<string>,
  collected: SensitiveValues,
): AutomationToken[] {
  return tokens.filter(
    (t) =>
      (t.source === 'sensitive' || t.is_sensitive) &&
      referencedNames.has(t.name) &&
      !(t.name in collected),
  )
}

/** Excel serial dates (e.g. 45870) in date-ish columns → ISO YYYY-MM-DD. */
export function normalizeMaybeExcelSerialDate(columnName: string, raw: string): string {
  if (!raw) return raw
  if (!/date|day|when/i.test(columnName)) return raw
  const m = raw.trim().match(/^(\d+)(?:\.0+)?$/)
  if (!m) return raw
  const serial = Number(m[1])
  if (serial < 25569 || serial > 62107) return raw
  const ms = (serial - 25569) * 86400 * 1000
  const d = new Date(ms)
  if (isNaN(d.getTime())) return raw
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

/**
 * Build a `{{TOKEN}} → value` replace map from token definitions plus the
 * per-run inputs. The extension has no task loginConfig, so every
 * login_config token resolves from the runtime sensitive values (the web app
 * prompts credentials before each run — the extension does the same).
 * Tokens that can't be resolved are skipped so placeholders stay untouched.
 */
export function buildTokenReplaceMap(args: {
  tokens: AutomationToken[]
  row?: DataRow
  sensitive?: SensitiveValues
  fallback?: Record<string, string>
}): Record<string, string> {
  const { tokens, row, sensitive = {}, fallback = {} } = args
  const map: Record<string, string> = { ...fallback }

  for (const t of tokens) {
    const placeholder = `{{${t.name}}}`
    let value: string | undefined

    switch (t.source) {
      case 'data_column':
        if (row && t.data_column && t.data_column in row) {
          const v = row[t.data_column]
          value = v == null ? '' : String(v)
          value = normalizeMaybeExcelSerialDate(t.data_column, value)
        }
        break
      case 'static':
        value = t.static_value ?? ''
        break
      case 'login_config':
        value = sensitive[t.name]
        break
      case 'sensitive':
        value = sensitive[t.name]
        break
    }

    if (value !== undefined) {
      map[placeholder] = value
      map[t.name] = value
    }
  }

  // Implicit column placeholders resolve straight from the current row.
  if (row) {
    for (const col of Object.keys(row)) {
      const v = row[col]
      const str = v == null ? '' : normalizeMaybeExcelSerialDate(col, String(v))
      map[`{{col:${col}}}`] = str
      map[`{{$${col}}}`] = str
      map[col] = str
    }
  }

  return map
}
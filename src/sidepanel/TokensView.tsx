import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createExtensionClient } from '../shared/supabase'
import {
  SENSITIVE_HEADER_RE,
  TOKEN_NAME_RE,
  headerToTokenName,
  type AutomationToken,
  type DataRow,
  type LoginField,
  type TokenSource,
} from '../shared/tokens'

const LOGIN_FIELDS: LoginField[] = ['username', 'password', 'totp_code', 'sso_email', 'sso_password']
const SOURCE_LABELS: Record<TokenSource, string> = {
  data_column: 'Data column',
  static: 'Static',
  login_config: 'Login config',
  sensitive: 'Sensitive',
}

interface DraftToken {
  name: string
  description: string
  source: TokenSource
  static_value: string
  data_column: string
  login_field: LoginField
  is_sensitive: boolean
}

const EMPTY_DRAFT: DraftToken = {
  name: '',
  description: '',
  source: 'static',
  static_value: '',
  data_column: '',
  login_field: 'username',
  is_sensitive: false,
}

export default function TokensView() {
  const clientRef = useRef<SupabaseClient | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [tokens, setTokens] = useState<AutomationToken[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState<DraftToken>(EMPTY_DRAFT)
  const [saving, setSaving] = useState(false)
  const [file, setFile] = useState<{ name: string; columns: string[]; rows: DataRow[] } | null>(null)
  const [genDraft, setGenDraft] = useState<Record<string, { name: string; sensitive: boolean }>>({})

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      clientRef.current ??= createExtensionClient()
      const { data, error: fetchError } = await clientRef.current
        .from('automation_tokens')
        .select('*')
        .order('name', { ascending: true })
      if (fetchError) throw new Error(fetchError.message)
      setTokens((data as AutomationToken[]) ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return tokens
    return tokens.filter(
      (t) => t.name.toLowerCase().includes(query) || (t.description ?? '').toLowerCase().includes(query),
    )
  }, [tokens, search])

  const client = (): SupabaseClient => {
    clientRef.current ??= createExtensionClient()
    return clientRef.current
  }

  const handleFilePicked = useCallback(async (fileList: FileList | null) => {
    const file = fileList?.[0]
    if (!file) return
    setError(null)
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' })
      const ws = wb.Sheets[wb.SheetNames[0]]
      if (!ws) throw new Error('The file has no sheets.')
      const rows = XLSX.utils.sheet_to_json<DataRow>(ws, { defval: null })
      if (rows.length === 0) throw new Error('The file has no data rows.')
      const columns = Object.keys(rows[0])
      const next: Record<string, { name: string; sensitive: boolean }> = {}
      for (const col of columns) {
        next[col] = { name: headerToTokenName(col), sensitive: SENSITIVE_HEADER_RE.test(col) }
      }
      setFile({ name: file.name, columns, rows })
      setGenDraft(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const createToken = useCallback(async () => {
    const name = draft.name.trim().toUpperCase()
    if (!TOKEN_NAME_RE.test(name)) {
      setError('Token names must be UPPERCASE letters, digits and underscores (e.g. CHECK_IN).')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const { data: authData } = await client().auth.getUser()
      const userId = authData.user?.id
      if (!userId) throw new Error('Not signed in.')
      const { error: insertError } = await client()
        .from('automation_tokens')
        .insert({
          user_id: userId,
          name,
          description: draft.description.trim() || null,
          source: draft.source,
          data_column: draft.source === 'data_column' ? draft.data_column.trim() || null : null,
          static_value: draft.source === 'static' ? draft.static_value : null,
          login_field: draft.source === 'login_config' ? draft.login_field : null,
          is_sensitive:
            draft.source === 'sensitive' ||
            draft.is_sensitive ||
            (draft.source === 'login_config' &&
              ['password', 'sso_password', 'totp_code'].includes(draft.login_field)),
        })
      if (insertError) throw new Error(insertError.message)
      setCreating(false)
      setDraft(EMPTY_DRAFT)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    setSaving(false)
  }, [draft, load])

  const generateTokens = useCallback(async () => {
    if (!file) return
    const payloads = file.columns.map((col) => ({
      name: genDraft[col].name.toUpperCase(),
      description: `Auto-generated from column "${col}"`,
      source: 'data_column' as const,
      data_column: col,
      static_value: null,
      login_field: null,
      is_sensitive: genDraft[col].sensitive,
    }))
    const invalid = payloads.find((p) => !TOKEN_NAME_RE.test(p.name))
    if (invalid) {
      setError(`"${invalid.name}" is not a valid token name — use UPPERCASE letters, digits, underscores.`)
      return
    }
    setSaving(true)
    setError(null)
    try {
      const { data: authData } = await client().auth.getUser()
      const userId = authData.user?.id
      if (!userId) throw new Error('Not signed in.')
      const { error: insertError } = await client()
        .from('automation_tokens')
        .insert(payloads.map((p) => ({ ...p, user_id: userId })))
      if (insertError) throw new Error(insertError.message)
      setFile(null)
      setGenDraft({})
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    setSaving(false)
  }, [file, genDraft, load])

  const deleteToken = useCallback(
    async (id: string) => {
      setError(null)
      try {
        const { error: deleteError } = await client().from('automation_tokens').delete().eq('id', id)
        if (deleteError) throw new Error(deleteError.message)
        setTokens((prev) => prev.filter((t) => t.id !== id))
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [],
  )

  return (
    <div className="stack">
      <div className="toolbar">
        <input
          type="search"
          className="search"
          placeholder="Search tokens…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button type="button" className="button small" onClick={() => void load()} disabled={loading}>
          Refresh
        </button>
      </div>

      <div className="toolbar">
        <button type="button" className="button small" onClick={() => setCreating((v) => !v)}>
          {creating ? 'Cancel' : 'New token'}
        </button>
        <button
          type="button"
          className="button small"
          onClick={() => fileInputRef.current?.click()}
          disabled={saving}
        >
          Generate from data file…
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx,.xlsm,.xls,.xlsb,.csv"
          style={{ display: 'none' }}
          onChange={(e) => {
            void handleFilePicked(e.target.files)
            e.target.value = ''
          }}
        />
      </div>

      {error && <p className="error">{error}</p>}

      {creating && (
        <div className="card">
          <div className="card-title">New token</div>
          <label className="field">
            <span>Name (used as {'{{NAME}}'})</span>
            <input
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value.toUpperCase() }))}
              spellCheck={false}
              placeholder="CHECK_IN"
            />
          </label>
          <label className="field">
            <span>Source</span>
            <select
              className="select"
              value={draft.source}
              onChange={(e) => setDraft((d) => ({ ...d, source: e.target.value as TokenSource }))}
            >
              {(Object.keys(SOURCE_LABELS) as TokenSource[]).map((s) => (
                <option key={s} value={s}>
                  {SOURCE_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
          {draft.source === 'static' && (
            <label className="field">
              <span>Value</span>
              <input
                value={draft.static_value}
                onChange={(e) => setDraft((d) => ({ ...d, static_value: e.target.value }))}
              />
            </label>
          )}
          {draft.source === 'data_column' && (
            <label className="field">
              <span>Data column header</span>
              <input
                value={draft.data_column}
                onChange={(e) => setDraft((d) => ({ ...d, data_column: e.target.value }))}
              />
            </label>
          )}
          {draft.source === 'login_config' && (
            <label className="field">
              <span>Login field</span>
              <select
                className="select"
                value={draft.login_field}
                onChange={(e) => setDraft((d) => ({ ...d, login_field: e.target.value as LoginField }))}
              >
                {LOGIN_FIELDS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </label>
          )}
          {draft.source === 'sensitive' && (
            <p className="muted small">Value will be prompted before each run and never persisted.</p>
          )}
          <label className="field">
            <span>Description (optional)</span>
            <input
              value={draft.description}
              onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
            />
          </label>
          {draft.source !== 'sensitive' && (
            <label className="remember-row">
              <input
                type="checkbox"
                checked={draft.is_sensitive}
                onChange={(e) => setDraft((d) => ({ ...d, is_sensitive: e.target.checked }))}
              />
              <span className="small">Sensitive — mask and prompt at run time</span>
            </label>
          )}
          <div className="toolbar">
            <button type="button" className="button primary" onClick={() => void createToken()} disabled={saving}>
              Create token
            </button>
          </div>
        </div>
      )}

      {file && (
        <div className="card">
          <div className="card-title">Generate tokens from {file.name}</div>
          <p className="muted small">
            One token per column, resolved from the loaded data file when running a recipe.
          </p>
          {file.columns.map((col) => (
            <div key={col} className="token-row">
              <div className="token-main">
                <div className="token-name">{col}</div>
                <div className="token-desc">header from the data file</div>
              </div>
              <input
                className="search token-name-input"
                value={genDraft[col]?.name ?? ''}
                onChange={(e) =>
                  setGenDraft((g) => ({
                    ...g,
                    [col]: { name: e.target.value.toUpperCase(), sensitive: g[col]?.sensitive ?? false },
                  }))
                }
                spellCheck={false}
              />
              <label className="remember-row">
                <input
                  type="checkbox"
                  checked={genDraft[col]?.sensitive ?? false}
                  onChange={(e) =>
                    setGenDraft((g) => ({
                      ...g,
                      [col]: { name: g[col]?.name ?? headerToTokenName(col), sensitive: e.target.checked },
                    }))
                  }
                />
                <span className="small">sensitive</span>
              </label>
            </div>
          ))}
          <div className="toolbar">
            <button type="button" className="button primary" onClick={() => void generateTokens()} disabled={saving}>
              {saving ? 'Creating…' : 'Create tokens'}
            </button>
            <button type="button" className="button" onClick={() => setFile(null)} disabled={saving}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="muted small">Loading tokens…</p>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <p className="muted">No tokens found.</p>
          <p className="muted small">
            {tokens.length === 0
              ? 'Create tokens from a data file, or manage them in the Revjuvenate web app automation builder.'
              : 'Try adjusting the search.'}
          </p>
        </div>
      ) : (
        <div className="token-list">
          {filtered.map((token) => (
            <div key={token.id} className="token-row">
              <div className="token-main">
                <div className="token-name">{token.name}</div>
                {token.description && <div className="token-desc">{token.description}</div>}
                <div className="step-tags">
                  <span className="badge">{SOURCE_LABELS[token.source]}</span>
                  {token.source === 'data_column' && token.data_column && (
                    <span className="badge">column: {token.data_column}</span>
                  )}
                  {token.source === 'static' && token.static_value !== null && (
                    <span className="badge">
                      value: {token.is_sensitive ? '••••••' : token.static_value}
                    </span>
                  )}
                  {token.source === 'login_config' && token.login_field && (
                    <span className="badge">{token.login_field}</span>
                  )}
                  {token.is_sensitive && <span className="badge badge-sensitive">sensitive</span>}
                </div>
              </div>
              <button
                type="button"
                className="button small danger"
                onClick={() => void deleteToken(token.id)}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
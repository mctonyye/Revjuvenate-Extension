import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createExtensionClient } from '../shared/supabase'
import {
  fetchAiRecipes,
  locatorText,
  type AiRecipe,
  type AiRecipeStep,
  type AiRecipeVersion,
} from '../shared/aiRecipes'
import { actionLabel } from '../shared/labels'

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}

function statusBadgeClass(status: AiRecipe['status']): string {
  if (status === 'approved') return 'badge-approved'
  if (status === 'archived') return 'badge-archived'
  return 'badge-draft'
}

export default function AiRecipesView() {
  const clientRef = useRef<SupabaseClient | null>(null)
  const [recipes, setRecipes] = useState<AiRecipe[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      clientRef.current ??= createExtensionClient()
      const list = await fetchAiRecipes(clientRef.current)
      setRecipes(list)
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
    if (!query) return recipes
    return recipes.filter(
      (recipe) =>
        recipe.name.toLowerCase().includes(query) ||
        (recipe.description ?? '').toLowerCase().includes(query) ||
        recipe.tags.some((tag) => tag.toLowerCase().includes(query)),
    )
  }, [recipes, search])

  const selected = selectedId ? (recipes.find((recipe) => recipe.recipe_id === selectedId) ?? null) : null

  if (selected) {
    return <AiRecipeDetail recipe={selected} onBack={() => setSelectedId(null)} />
  }

  return (
    <div className="stack">
      <div className="toolbar">
        <input
          type="search"
          className="search"
          placeholder="Search AI recipes…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button type="button" className="button small" onClick={() => void load()} disabled={loading}>
          Refresh
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      {loading ? (
        <p className="muted small">Loading AI recipes…</p>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <p className="muted">No AI recipes found.</p>
          <p className="muted small">
            {recipes.length === 0
              ? 'Create AI recipes with the Revjuvenate web app automation builder.'
              : 'Try adjusting the search.'}
          </p>
        </div>
      ) : (
        <div className="recipe-list">
          {filtered.map((recipe) => {
            const production = recipe.versions.find((version) => version.is_production) ?? null
            const stepCount =
              production?.steps.length ??
              recipe.versions.reduce((max, version) => Math.max(max, version.steps.length), 0)
            return (
              <button
                key={recipe.recipe_id}
                type="button"
                className="recipe-card"
                onClick={() => setSelectedId(recipe.recipe_id)}
              >
                <div className="recipe-name">{recipe.name}</div>
                {recipe.description && <div className="recipe-desc">{recipe.description}</div>}
                <div className="badges">
                  <span className={`badge ${statusBadgeClass(recipe.status)}`}>{recipe.status}</span>
                  {production && <span className="badge badge-prod">production</span>}
                  {recipe.tags.map((tag) => (
                    <span key={tag} className="badge">
                      {tag}
                    </span>
                  ))}
                </div>
                <div className="recipe-meta">
                  <span>{stepCount} steps</span>
                  <span>Updated {relativeTime(recipe.updated_at)}</span>
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function AiRecipeDetail({ recipe, onBack }: { recipe: AiRecipe; onBack: () => void }) {
  const versions = [...recipe.versions].sort((a, b) => a.version_num - b.version_num)

  return (
    <div className="stack">
      <div className="toolbar">
        <button type="button" className="button small" onClick={onBack}>
          ← Back to AI recipes
        </button>
      </div>

      <div className="card">
        <div className="detail-title">{recipe.name}</div>
        {recipe.description && <p className="muted small">{recipe.description}</p>}
        <div className="badges">
          <span className={`badge ${statusBadgeClass(recipe.status)}`}>{recipe.status}</span>
          {recipe.tags.map((tag) => (
            <span key={tag} className="badge">
              {tag}
            </span>
          ))}
        </div>
        {recipe.target_url_pattern && (
          <div className="detail-url">URL: {recipe.target_url_pattern}</div>
        )}
        <div className="recipe-meta">
          <span>
            {versions.length} version{versions.length === 1 ? '' : 's'}
          </span>
          <span>Updated {relativeTime(recipe.updated_at)}</span>
        </div>
        <p className="muted small">
          AI recipes are view-only in the extension for now — run them from the Revjuvenate web app.
        </p>
      </div>

      {versions.length === 0 ? (
        <p className="muted small">This recipe has no versions.</p>
      ) : (
        versions.map((version) => <VersionCard key={version.version_id} version={version} />)
      )}
    </div>
  )
}

function VersionCard({ version }: { version: AiRecipeVersion }) {
  return (
    <div className="card">
      <div className="step-title">
        Version {version.version_num}
        {version.is_production && <span className="badge badge-prod">production</span>}
        {!version.is_production && <span className="badge badge-draft">not production</span>}
        <span className="badge">heal: {version.heal_policy}</span>
        <span className="run-duration">Created {relativeTime(version.created_at)}</span>
      </div>
      {version.notes && <p className="muted small">{version.notes}</p>}
      {Object.keys(version.params_schema).length > 0 && (
        <div className="small">
          <div className="muted">Params</div>
          <div className="chips">
            {Object.keys(version.params_schema).map((key) => (
              <span key={key} className="chip">
                {key}
              </span>
            ))}
          </div>
        </div>
      )}
      {version.steps.length === 0 ? (
        <p className="muted small">This version has no steps.</p>
      ) : (
        <div className="step-list">
          {version.steps.map((step) => (
            <AiStepRow key={step.step_id} step={step} />
          ))}
        </div>
      )}
    </div>
  )
}

function AiStepRow({ step }: { step: AiRecipeStep }) {
  const locator = locatorText(step.primary_locator)

  return (
    <div className={`step-row${step.enabled ? '' : ' disabled'}`}>
      <div className="step-index">{step.order_index + 1}</div>
      <div className="step-main">
        <div className="step-title">
          {actionLabel(step.action)}
          {step.intent && <span className="step-element">{step.intent}</span>}
        </div>
        {locator && <code className="step-xpath">{locator}</code>}
        {step.value !== '' && (
          <div className="step-value">
            Value: <code>{step.value}</code>
          </div>
        )}
        <div className="step-tags">
          {!step.enabled && <span className="badge badge-disabled">disabled</span>}
          {step.frame_selector && <span className="badge">iframe: {step.frame_selector}</span>}
          {step.timeout_ms > 0 && <span className="badge">timeout {step.timeout_ms}ms</span>}
          {step.screenshot_on_error && <span className="badge">screenshot on error</span>}
          {step.value_from_param && <span className="badge">param: {step.value_from_param}</span>}
        </div>
      </div>
    </div>
  )
}
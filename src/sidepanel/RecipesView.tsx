import { useCallback, useEffect, useMemo, useState } from 'react'
import { sendMessage } from '../shared/messages'
import type { UserProfile } from '../shared/messages'
import type { AutomationRecipe, SequenceStep } from '../shared/recipes'

type OwnershipFilter = 'all' | 'mine' | 'shared'

const ACTION_LABELS: Record<string, string> = {
  goto: 'Navigate to URL',
  back: 'Go back',
  forward: 'Go forward',
  click_navigate: 'Click to navigate',
  wait_for_url: 'Wait for URL',
  click: 'Click',
  js_click: 'Click (JS)',
  double_click: 'Double click',
  hover: 'Hover',
  hover_with_offset: 'Hover (offset)',
  press_key: 'Press key',
  drag_and_drop: 'Drag & drop',
  input: 'Type value',
  type: 'Type value',
  type_slowly: 'Type slowly',
  clear: 'Clear field',
  select: 'Select option',
  custom_select: 'Select (custom)',
  check_uncheck: 'Check / uncheck',
  custom_check_uncheck_daylight: 'Check / uncheck (daylight)',
  input_activate_deactivate: 'Activate / deactivate',
  replace_click: 'Replace & click',
  upload_file: 'Upload file',
  select_from_list: 'Select from list',
  double_click_from_list: 'Double click from list',
  multi_check_uncheck_from_checkboxes: 'Check / uncheck (checkboxes)',
  list_activate_deactivate: 'List activate / deactivate',
  get_text: 'Read text',
  get_attribute: 'Read attribute',
  get_url: 'Read URL',
  get_n_keep_values: 'Read & keep values',
  get_n_keep_values1: 'Read & keep values (1)',
  get_n_keep_ids: 'Read & keep IDs',
  check_exists: 'Check exists',
  check_visible: 'Check visible',
  accept_dialog: 'Accept dialog',
  dismiss_dialog: 'Dismiss dialog',
  wait: 'Wait',
  scroll: 'Scroll',
  screenshot: 'Screenshot',
  evaluate_js: 'Run JS',
  loop: 'Loop',
}

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action
}

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

interface RecipesViewProps {
  user: UserProfile
}

export default function RecipesView({ user }: RecipesViewProps) {
  const [recipes, setRecipes] = useState<AutomationRecipe[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [ownership, setOwnership] = useState<OwnershipFilter>('all')
  const [category, setCategory] = useState('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const response = await sendMessage({ type: 'recipes:list' })
    if (response.ok && response.kind === 'recipes:list') {
      setRecipes(response.recipes)
    } else if (!response.ok) {
      setError(response.error)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const categories = useMemo(() => {
    const set = new Set<string>()
    for (const recipe of recipes) {
      if (recipe.category) set.add(recipe.category)
    }
    return [...set].sort()
  }, [recipes])

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    return recipes.filter((recipe) => {
      if (ownership === 'mine' && recipe.user_id !== user.id) return false
      if (ownership === 'shared' && recipe.user_id === user.id) return false
      if (category !== 'all' && (recipe.category ?? '') !== category) return false
      if (
        query &&
        !recipe.name.toLowerCase().includes(query) &&
        !(recipe.description ?? '').toLowerCase().includes(query) &&
        !(recipe.system ?? '').toLowerCase().includes(query)
      ) {
        return false
      }
      return true
    })
  }, [recipes, ownership, category, search, user.id])

  const selected = selectedId ? (recipes.find((recipe) => recipe.id === selectedId) ?? null) : null

  if (selected) {
    return (
      <RecipeDetail
        recipe={selected}
        isOwner={selected.user_id === user.id}
        onBack={() => setSelectedId(null)}
      />
    )
  }

  return (
    <div className="stack">
      <div className="toolbar">
        <input
          type="search"
          className="search"
          placeholder="Search recipes…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button type="button" className="button small" onClick={() => void load()} disabled={loading}>
          Refresh
        </button>
      </div>

      <div className="segmented">
        {(['all', 'mine', 'shared'] as const).map((value) => (
          <button
            key={value}
            type="button"
            className={ownership === value ? 'segment active' : 'segment'}
            onClick={() => setOwnership(value)}
          >
            {value === 'all' ? 'All' : value === 'mine' ? 'Mine' : 'Shared'}
          </button>
        ))}
      </div>

      {categories.length > 1 && (
        <select className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="all">All categories</option>
          {categories.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      )}

      {error && <p className="error">{error}</p>}

      {loading ? (
        <p className="muted small">Loading recipes…</p>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <p className="muted">No recipes found.</p>
          <p className="muted small">
            {recipes.length === 0
              ? 'Create recipes in the Revjuvenate web app, or ask your chain admin for access.'
              : 'Try adjusting the search or filters.'}
          </p>
        </div>
      ) : (
        <div className="recipe-list">
          {filtered.map((recipe) => (
            <button
              key={recipe.id}
              type="button"
              className="recipe-card"
              onClick={() => setSelectedId(recipe.id)}
            >
              <div className="recipe-name">{recipe.name}</div>
              {recipe.description && <div className="recipe-desc">{recipe.description}</div>}
              <div className="badges">
                {recipe.user_id === user.id ? (
                  <span className="badge badge-mine">Mine</span>
                ) : (
                  <span className="badge badge-shared">Shared</span>
                )}
                {recipe.category && <span className="badge">{recipe.category}</span>}
                {recipe.system && <span className="badge">{recipe.system}</span>}
              </div>
              <div className="recipe-meta">
                <span>{recipe.steps?.length ?? 0} steps</span>
                <span>Updated {relativeTime(recipe.updated_at)}</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function RecipeDetail({
  recipe,
  isOwner,
  onBack,
}: {
  recipe: AutomationRecipe
  isOwner: boolean
  onBack: () => void
}) {
  const steps = recipe.steps ?? []

  return (
    <div className="stack">
      <button type="button" className="button small" onClick={onBack}>
        ← Back to recipes
      </button>

      <div className="card">
        <div className="detail-title">{recipe.name}</div>
        {recipe.description && <p className="muted small">{recipe.description}</p>}
        <div className="badges">
          {isOwner ? <span className="badge badge-mine">Mine</span> : <span className="badge badge-shared">Shared</span>}
          {recipe.category && <span className="badge">{recipe.category}</span>}
          {recipe.system && <span className="badge">{recipe.system}</span>}
        </div>
        {recipe.target_url && (
          <a className="detail-url" href={recipe.target_url} target="_blank" rel="noreferrer">
            {recipe.target_url}
          </a>
        )}
        <div className="recipe-meta">
          <span>{steps.length} steps</span>
          <span>Updated {relativeTime(recipe.updated_at)}</span>
        </div>
        {!isOwner && <p className="muted small">View only — owned by another user.</p>}
        {recipe.replace_map && Object.keys(recipe.replace_map).length > 0 && (
          <div className="small">
            <div className="muted">Variables</div>
            <div className="chips">
              {Object.keys(recipe.replace_map).map((key) => (
                <span key={key} className="chip">
                  {key}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {steps.length === 0 ? (
        <p className="muted small">This recipe has no steps.</p>
      ) : (
        <div className="step-list">
          {steps.map((step, index) => (
            <StepRow key={index} step={step} index={index} />
          ))}
        </div>
      )}
    </div>
  )
}

function StepRow({ step, index }: { step: SequenceStep; index: number }) {
  return (
    <div className={`step-row${step.disabled ? ' disabled' : ''}`}>
      <div className="step-index">{step.sequence ?? index + 1}</div>
      <div className="step-main">
        <div className="step-title">
          {actionLabel(step.action)}
          {step.element_name && <span className="step-element">{step.element_name}</span>}
        </div>
        {step.xpath && <code className="step-xpath">{step.xpath}</code>}
        {(step.default_value ?? '') !== '' && (
          <div className="step-value">
            Value: <code>{step.default_value}</code>
          </div>
        )}
        {(step.iframe ?? '') !== '' && (
          <div className="step-tags">
            <span className="badge">iframe: {step.iframe}</span>
          </div>
        )}
        <div className="step-tags">
          {step.disabled && <span className="badge badge-disabled">disabled</span>}
          {step.phase === 'setup' && <span className="badge">setup</span>}
          {step.phase === 'row' && <span className="badge">row</span>}
          {step.loop !== undefined && step.loop > 1 && <span className="badge">loop ×{step.loop}</span>}
          {step.wait_time !== undefined && step.wait_time > 0 && (
            <span className="badge">wait {step.wait_time}s</span>
          )}
          {step.condition && (
            <span className="badge">if step {step.condition.ref_sequence} {step.condition.operator}</span>
          )}
          {step.value_format && <span className="badge">{step.value_format}</span>}
        </div>
      </div>
    </div>
  )
}

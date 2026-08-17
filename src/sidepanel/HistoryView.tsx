import { useCallback, useEffect, useState } from 'react'
import type { UserProfile } from '../shared/messages'
import { getDb } from '../shared/runLog'

interface AutomationRunRow {
  id: string
  recipe_name: string | null
  status: string | null
  created_at: string | null
  finished_at: string | null
  total_steps: number | null
  executed_steps: number | null
  skipped_steps: number | null
  failed_steps: number | null
  error_message: string | null
  target_url: string | null
}

function relativeTime(iso: string | null): string {
  if (!iso) return ''
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

interface HistoryViewProps {
  user: UserProfile
}

export default function HistoryView({ user }: HistoryViewProps) {
  const [runs, setRuns] = useState<AutomationRunRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!user) return
    setRuns(null)
    setError(null)
    try {
      const { data, error: err } = await getDb()
        .from('automation_runs')
        .select(
          'id, recipe_name, status, created_at, finished_at, total_steps, executed_steps, skipped_steps, failed_steps, error_message, target_url',
        )
        .order('created_at', { ascending: false })
        .limit(50)
      if (err) throw err
      setRuns((data ?? []) as AutomationRunRow[])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setRuns([])
    }
  }, [user])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="stack">
      <div className="toolbar">
        <button type="button" className="button small" onClick={() => void load()}>
          Refresh
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      {runs === null && <p className="muted small">Loading run history…</p>}
      {runs !== null && runs.length === 0 && (
        <div className="empty-state">
          <div className="muted">No runs yet.</div>
          <div className="muted small">Runs you execute in this panel are logged here.</div>
        </div>
      )}

      <div className="step-list">
        {runs?.map((run) => (
          <div key={run.id} className="run-row">
            <span className={`status-dot ${run.status ?? ''}`} aria-hidden="true" />
            <div className="step-main">
              <div className="step-title">
                {run.recipe_name ?? 'Automation run'}
                <span className="run-duration">{relativeTime(run.created_at)}</span>
              </div>
              <div className="badges">
                <span className={`badge ${run.status === 'success' ? 'badge-mine' : run.status === 'failed' ? 'badge-error' : ''}`}>
                  {run.status ?? 'unknown'}
                </span>
                {run.executed_steps != null && <span className="badge">{run.executed_steps} executed</span>}
                {run.skipped_steps != null && run.skipped_steps > 0 && (
                  <span className="badge">{run.skipped_steps} skipped</span>
                )}
                {run.failed_steps != null && run.failed_steps > 0 && (
                  <span className="badge badge-error">{run.failed_steps} failed</span>
                )}
              </div>
              {run.error_message && <div className="run-message">{run.error_message}</div>}
              {run.target_url && <div className="step-xpath">{run.target_url}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
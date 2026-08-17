import { useCallback, useEffect, useState } from 'react'
import { sendMessage, type AuthChangedMessage, type UserProfile } from '../shared/messages'
import RecipesView from './RecipesView'

type AuthStatus =
  | { phase: 'loading' }
  | { phase: 'signed-out' }
  | { phase: 'signed-in'; user: UserProfile }

export default function App() {
  const [status, setStatus] = useState<AuthStatus>({ phase: 'loading' })

  useEffect(() => {
    void sendMessage({ type: 'auth:get-state' }).then((response) => {
      if (response.ok && response.kind === 'auth:state') {
        setStatus(response.user ? { phase: 'signed-in', user: response.user } : { phase: 'signed-out' })
      } else {
        setStatus({ phase: 'signed-out' })
      }
    })

    const listener = (message: unknown) => {
      if ((message as AuthChangedMessage)?.type === 'auth:changed') {
        const changed = message as AuthChangedMessage
        setStatus(changed.user ? { phase: 'signed-in', user: changed.user } : { phase: 'signed-out' })
      }
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  }, [])

  if (status.phase === 'loading') {
    return (
      <Shell>
        <p className="muted">Checking session…</p>
      </Shell>
    )
  }

  if (status.phase === 'signed-out') {
    return <Login onSignedIn={(user) => setStatus({ phase: 'signed-in', user })} />
  }

  return <SignedIn user={status.user} onSignedOut={() => setStatus({ phase: 'signed-out' })} />
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="shell">
      <header className="header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">Revjuvenate</span>
        </div>
      </header>
      <main className="content">{children}</main>
    </div>
  )
}

function Login({ onSignedIn }: { onSignedIn: (user: UserProfile) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    const response = await sendMessage({ type: 'auth:sign-in', email, password })
    setSubmitting(false)
    if (response.ok && response.kind === 'auth:sign-in') {
      onSignedIn(response.user)
    } else if (!response.ok) {
      setError(response.error)
    }
  }

  return (
    <Shell>
      <form className="stack" onSubmit={handleSubmit}>
        <div>
          <h1 className="title">Sign in</h1>
          <p className="muted">Use your Revjuvenate account to access your recipes.</p>
        </div>
        <label className="field">
          <span>Email</span>
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" className="button primary" disabled={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </Shell>
  )
}

function SignedIn({ user, onSignedOut }: { user: UserProfile; onSignedOut: () => void }) {
  const handleSignOut = useCallback(async () => {
    await sendMessage({ type: 'auth:sign-out' })
    onSignedOut()
  }, [onSignedOut])

  return (
    <Shell>
      <div className="user-bar">
        <div className="avatar avatar-sm" aria-hidden="true">
          {(user.email ?? '?').slice(0, 1).toUpperCase()}
        </div>
        <div className="user-bar-info">
          <div className="user-bar-email">{user.email ?? 'Unknown user'}</div>
          <div className="chips">
            {(user.roles?.length ? user.roles : ['member']).map((role) => (
              <span key={role} className="chip">
                {role}
              </span>
            ))}
          </div>
        </div>
        <button type="button" className="button small" onClick={() => void handleSignOut()}>
          Sign out
        </button>
      </div>
      <RecipesView key={user.id} user={user} />
    </Shell>
  )
}

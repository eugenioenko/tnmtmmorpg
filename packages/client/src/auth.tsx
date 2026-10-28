import { useEffect, useState, type ReactNode } from 'react';
import { AuthProvider, useAuth, type AuthTokens, type OidcClientConfig } from 'oidc-js-react';
import type { AuthMessage } from '@game/shared';

const ISSUER = import.meta.env?.VITE_OIDC_ISSUER_URL as string | undefined;
const CLIENT_ID = (import.meta.env?.VITE_OIDC_CLIENT_ID as string | undefined) ?? 'tnmtmmorpg';
const DEV_ACCOUNT_KEY = 'tnmt:dev-account';
/** Refresh a token this close to expiry before handing it to the server. */
const EXPIRY_MARGIN_S = 30;

/**
 * Must be a stable object: AuthProvider rebuilds its OIDC client whenever
 * the config identity changes, which would drop the session.
 */
const CONFIG: OidcClientConfig | null = ISSUER
  ? {
      issuer: ISSUER,
      clientId: CLIENT_ID,
      redirectUri: `${window.location.origin}/callback`,
      postLogoutRedirectUri: `${window.location.origin}/`,
      scopes: ['openid', 'profile', 'offline_access'],
      fetchProfile: false,
    }
  : null;

interface Bridge {
  tokens: AuthTokens;
  refresh: () => Promise<AuthTokens>;
  login: () => void;
  logout: () => void;
}

/**
 * The game connection lives outside React and must not restart when tokens
 * refresh, so it reads them from here instead of from context.
 */
let bridge: Bridge | null = null;

function devAccount(): string {
  try {
    const existing = localStorage.getItem(DEV_ACCOUNT_KEY);
    if (existing && /^[a-z0-9-]{8,64}$/.test(existing)) return existing;
    const fresh = crypto.randomUUID();
    localStorage.setItem(DEV_ACCOUNT_KEY, fresh);
    return fresh;
  } catch {
    return crypto.randomUUID();
  }
}

/** What the connection sends first, with a fresh access token when signing in through OIDC. */
export async function authMessage(): Promise<AuthMessage> {
  if (!CONFIG) return { t: 'auth', dev: devAccount() };
  if (!bridge) throw new Error('not signed in');
  const { expiresAt } = bridge.tokens;
  let { access } = bridge.tokens;
  if (!access || (expiresAt !== null && expiresAt - EXPIRY_MARGIN_S < Date.now() / 1000)) {
    ({ access } = await bridge.refresh());
  }
  if (!access) throw new Error('no access token');
  return { t: 'auth', token: access };
}

/** The sign-in screen again; in development, a brand new local account. */
export function signOut(): void {
  if (bridge) {
    bridge.logout();
    return;
  }
  try {
    localStorage.removeItem(DEV_ACCOUNT_KEY);
  } catch {
    // Nothing stored, nothing to forget.
  }
  window.location.reload();
}

/** Ask the identity provider again, e.g. after the server rejected our token. */
export function signInAgain(): void {
  if (bridge) bridge.login();
  else window.location.reload();
}

/**
 * Renders its children once the player has signed in, and keeps them
 * mounted from then on. Token refreshes only update the bridge; they never
 * unmount the game, which RequireAuth would do every time a token expired.
 */
function Gate({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading, error, tokens, actions } = useAuth();
  const [entered, setEntered] = useState(false);
  bridge = { tokens, refresh: actions.refresh, login: () => void actions.login(), logout: actions.logout };

  useEffect(() => {
    if (isAuthenticated) setEntered(true);
  }, [isAuthenticated]);

  useEffect(() => {
    if (!entered && !isLoading && !isAuthenticated && !error) void actions.login();
  }, [entered, isLoading, isAuthenticated, error, actions]);

  if (entered) return children;
  return (
    <div className="account-screen">
      <div className="account-card frame">
        <div className="account-title">tnmtmmorpg</div>
        {error ? (
          <>
            <div className="account-error">{error.message}</div>
            <button type="button" className="btn" onClick={() => void actions.login()}>
              Sign in
            </button>
          </>
        ) : (
          <div className="muted">Signing in…</div>
        )}
      </div>
    </div>
  );
}

export function AuthRoot({ children }: { children: ReactNode }) {
  if (!CONFIG) return children;
  return (
    <AuthProvider
      config={CONFIG}
      onLogin={(returnTo) => window.history.replaceState(null, '', returnTo)}
    >
      <Gate>{children}</Gate>
    </AuthProvider>
  );
}

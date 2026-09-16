import { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react'
import { io } from 'socket.io-client'
import { useAuth } from './AuthContext'

const SocketContext = createContext(null)

// One shared socket for the whole app — server/lib/realtime.js is the other end.
//
// It connects when there is a token and the account is not a test account
// (demo accounts are refused at the handshake server-side too; not connecting
// here just saves a guaranteed-failing retry loop), and disconnects on logout.
//
// Provides:
//   on(event, handler) → unsubscribe fn. CALL IT in your effect cleanup.
//   emit(event, payload)
//   online  Set<number> of currently-connected user ids
//   connected  boolean
//
// ── Why `socket` is state and not just a ref ──
// React runs CHILD effects before PARENT effects. A ref assigned in this
// provider's effect is still null when a page's own effect runs on first
// mount, so an `on()` that read a ref would silently attach nothing and the
// page would never receive a live message until something forced a
// re-subscribe. Holding the instance in state makes `on` change identity the
// moment the socket exists, which re-runs any effect that lists it as a
// dependency. Pages must therefore put `on` in their dependency arrays.
export function SocketProvider({ children }) {
  const { token, user } = useAuth()
  const [socket, setSocket] = useState(null)
  const [connected, setConnected] = useState(false)
  const [online, setOnline] = useState(() => new Set())

  const isTest = !!user?.is_test

  useEffect(() => {
    if (!token || !user || isTest) {
      setSocket(null)
      setConnected(false)
      setOnline(new Set())
      return
    }

    // There is NO Vite proxy in this app — api.js talks to :3001 directly — so
    // in dev the socket needs an explicit URL, and the server carries its own
    // origin allowlist for the handshake. In production Express serves the
    // React build, so the two are same-origin and io() with no URL is right.
    const url = import.meta.env.PROD ? undefined : (import.meta.env.VITE_SOCKET_URL || 'http://localhost:3001')
    const s = url ? io(url, socketOpts(token)) : io(socketOpts(token))

    s.on('connect', () => setConnected(true))
    s.on('disconnect', () => setConnected(false))
    s.on('connect_error', () => setConnected(false))
    s.on('presence:list', ({ online: list }) => setOnline(new Set((list || []).map(Number))))
    s.on('presence:update', ({ userId, online: isOn }) => {
      setOnline(prev => {
        const next = new Set(prev)
        if (isOn) next.add(Number(userId)); else next.delete(Number(userId))
        return next
      })
    })

    setSocket(s)
    return () => {
      s.removeAllListeners()
      s.disconnect()
      setSocket(null)
      setConnected(false)
    }
  }, [token, user?.id, isTest])

  // Returns its own unsubscribe function. Without calling it on cleanup,
  // navigating between channels stacks duplicate handlers and every incoming
  // message renders N times.
  const on = useCallback((event, handler) => {
    if (!socket) return () => {}
    socket.on(event, handler)
    return () => { socket.off(event, handler) }
  }, [socket])

  const emit = useCallback((event, payload) => {
    socket?.emit(event, payload)
  }, [socket])

  const value = useMemo(
    () => ({ socket, on, emit, online, connected }),
    [socket, on, emit, online, connected]
  )

  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>
}

function socketOpts(token) {
  return {
    path: '/socket.io',
    auth: { token },
    // websocket first — the P0 acceptance test is a `101 Switching Protocols`
    // in the Network tab, not a long-poll fallback. polling stays as a safety
    // net for a network that blocks the upgrade outright.
    transports: ['websocket', 'polling'],
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  }
}

const NOOP = () => {}
const EMPTY = {
  socket: null,
  on: () => NOOP,
  emit: NOOP,
  online: new Set(),
  connected: false,
}

// Non-throwing on purpose: the provider only wraps the authenticated tree, and
// a component rendered outside it (the smoke harness renders pages bare) should
// degrade to "no realtime", not blank the page.
export function useSocket() {
  return useContext(SocketContext) || EMPTY
}

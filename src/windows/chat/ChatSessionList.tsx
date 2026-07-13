import type { ChatSessionSummary } from '../../../electron/types'

export type ChatSessionListProps = {
  open: boolean
  sessions: ChatSessionSummary[]
  currentSessionId: string | null
  currentSessionName?: string
  editingSessionId: string | null
  editingSessionName: string
  onNewSession: () => void | Promise<void>
  onSwitchSession: (sessionId: string) => void | Promise<void>
  onDeleteSession: (sessionId: string) => void | Promise<void>
  onRenameSession: (sessionId: string, name: string) => void | Promise<void>
  onStartRename: (session: ChatSessionSummary) => void
  onCancelRename: () => void
  onEditingSessionNameChange: (name: string) => void
}

export function ChatSessionList({
  open,
  sessions,
  currentSessionId,
  currentSessionName,
  editingSessionId,
  editingSessionName,
  onNewSession,
  onSwitchSession,
  onDeleteSession,
  onRenameSession,
  onStartRename,
  onCancelRename,
  onEditingSessionNameChange,
}: ChatSessionListProps) {
  if (!open) return null

  return (
    <div className="ndp-session-list" onMouseDown={(event) => event.stopPropagation()}>
      <div className="ndp-session-list-header">
        <div className="ndp-session-current">{currentSessionName ?? '对话'}</div>
        <button className="ndp-btn" onClick={() => void onNewSession()}>
          新对话
        </button>
      </div>
      <div className="ndp-session-list-items">
        {sessions.map((session) => (
          <div
            key={session.id}
            className={`ndp-session-item ${session.id === currentSessionId ? 'active' : ''}`}
            onClick={() => void onSwitchSession(session.id)}
          >
            <div className="ndp-session-info">
              {editingSessionId === session.id ? (
                <input
                  className="ndp-session-rename-input"
                  value={editingSessionName}
                  onMouseDown={(event) => event.stopPropagation()}
                  onChange={(event) => onEditingSessionNameChange(event.target.value)}
                  onBlur={() => void onRenameSession(session.id, editingSessionName)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      event.currentTarget.blur()
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      onCancelRename()
                    }
                  }}
                  autoFocus
                />
              ) : (
                <>
                  <span className="ndp-session-item-name">{session.name}</span>
                  <span className="ndp-session-item-count">{session.messageCount} 条</span>
                </>
              )}
            </div>
            <div
              className="ndp-session-actions"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
            >
              <button
                className="ndp-session-action"
                title="重命名"
                aria-label={`重命名 ${session.name}`}
                onClick={(event) => {
                  event.stopPropagation()
                  onStartRename(session)
                }}
              >
                ✎
              </button>
              <button
                className="ndp-session-action delete"
                title="删除"
                aria-label={`删除 ${session.name}`}
                onClick={(event) => {
                  event.stopPropagation()
                  void onDeleteSession(session.id)
                }}
              >
                ×
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

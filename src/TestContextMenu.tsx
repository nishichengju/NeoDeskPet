import { useState } from 'react'

export function TestContextMenu() {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [clickCount, setClickCount] = useState(0)

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    console.log('Right click detected!', e.clientX, e.clientY)
    setContextMenu({ x: e.clientX, y: e.clientY })
  }

  const handleClick = () => {
    setClickCount(c => c + 1)
    console.log('Left click detected!')
  }

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        background: 'rgba(50, 50, 80, 0.8)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'white',
        fontFamily: 'sans-serif',
      }}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
    >
      <h1>右键菜单测试</h1>
      <p>左键点击次数: {clickCount}</p>
      <p>右键点击任意位置测试菜单</p>

      {contextMenu && (
        <div
          style={{
            position: 'fixed',
            left: contextMenu.x,
            top: contextMenu.y,
            background: 'rgba(30, 30, 45, 0.98)',
            border: '1px solid rgba(255, 255, 255, 0.2)',
            borderRadius: '8px',
            padding: '8px',
            zIndex: 9999,
          }}
        >
          <button
            style={{
              display: 'block',
              width: '100%',
              padding: '8px 16px',
              background: 'transparent',
              border: 'none',
              color: 'white',
              cursor: 'pointer',
              textAlign: 'left',
            }}
            onClick={() => {
              alert('打开聊天!')
              setContextMenu(null)
            }}
          >
            💬 打开聊天
          </button>
          <button
            style={{
              display: 'block',
              width: '100%',
              padding: '8px 16px',
              background: 'transparent',
              border: 'none',
              color: 'white',
              cursor: 'pointer',
              textAlign: 'left',
            }}
            onClick={() => {
              alert('设置!')
              setContextMenu(null)
            }}
          >
            ⚙️ 设置
          </button>
          <button
            style={{
              display: 'block',
              width: '100%',
              padding: '8px 16px',
              background: 'transparent',
              border: 'none',
              color: '#f87171',
              cursor: 'pointer',
              textAlign: 'left',
            }}
            onClick={() => setContextMenu(null)}
          >
            ✕ 关闭菜单
          </button>
        </div>
      )}
    </div>
  )
}

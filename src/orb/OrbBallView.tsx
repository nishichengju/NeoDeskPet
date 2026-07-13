import type { MouseEventHandler } from 'react'

export type OrbBallViewProps = {
  dockSide: 'left' | 'right'
  onMouseDown: MouseEventHandler<HTMLDivElement>
  onDragStop: (point: { x: number; y: number }) => void
  onContextMenu: MouseEventHandler<HTMLDivElement>
}

export function OrbBallView(props: OrbBallViewProps) {
  return (
    <div
      className="ndp-orbapp-ball ndp-orbapp-ball-fixed"
      style={{ alignSelf: props.dockSide === 'left' ? 'flex-start' : 'flex-end' }}
      onMouseDown={props.onMouseDown}
      onMouseUp={(event) => props.onDragStop({ x: event.screenX, y: event.screenY })}
      onContextMenu={props.onContextMenu}
      title="单击：打开输入栏｜右键：菜单｜拖拽：移动并吸附"
    >
      <div className="ndp-orbapp-ball-icon"></div>
    </div>
  )
}

const stage = document.getElementById('stage')
const anchor = document.getElementById('anchor')
const shell = document.getElementById('surfaceShell')
const shellSkin = document.getElementById('shellSkin')
const barSurface = document.getElementById('barSurface')
const panelSurface = document.getElementById('panelSurface')
const ball = document.getElementById('ball')
const ballGhost = document.getElementById('ballGhost')

const dockSelect = document.getElementById('dockSelect')
const strategySelect = document.getElementById('strategySelect')
const targetSelect = document.getElementById('targetSelect')
const durationRange = document.getElementById('durationRange')
const offsetRange = document.getElementById('offsetRange')
const durationText = document.getElementById('durationText')
const offsetText = document.getElementById('offsetText')
const openBarBtn = document.getElementById('openBarBtn')
const openPanelBtn = document.getElementById('openPanelBtn')
const closeBtn = document.getElementById('closeBtn')
const replayBtn = document.getElementById('replayBtn')
const demoBtn = document.getElementById('demoBtn')
const viewText = document.getElementById('viewText')
const phaseText = document.getElementById('phaseText')
const strategyHint = document.getElementById('strategyHint')

const hints = {
  'liquid-stretch': '液体拉伸：由同一个外壳连续 morph 成球、胶囊与窗口，不再出现独立漂浮椭圆层。',
  'corner-return': '角落回球：panel 回收到上角球位，比整边裁切更像“回到球里”。',
  'edge-reveal': '整边裁切：更接近一个统一窗口从边缘展开，容易暴露瞬移感。',
}

const state = {
  dock: 'right',
  strategy: 'liquid-stretch',
  view: 'ball',
  phase: 'idle',
  duration: 280,
  offset: 72,
  lastTarget: 'panel',
}

let runId = 0
let activeAnimations = []

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function finishAnimationHandle(animation) {
  activeAnimations.push(animation)
  return animation.finished.catch(() => undefined)
}

function cancelAnimations() {
  for (const animation of activeAnimations) {
    try {
      animation.cancel()
    } catch {
      void 0
    }
  }
  activeAnimations = []
}

function setDock(dock) {
  state.dock = dock
  stage.dataset.dock = dock
  anchor.classList.toggle('orb-dock-right', dock === 'right')
  anchor.classList.toggle('orb-dock-left', dock === 'left')
}

function setStrategy(strategy) {
  state.strategy = strategy
  stage.dataset.strategy = strategy
  strategyHint.textContent = hints[strategy] ?? ''
}

function setPhase(phase) {
  state.phase = phase
  stage.dataset.phase = phase
  phaseText.textContent = phase
  stage.classList.toggle('is-animating', phase !== 'idle')
}

function setView(view) {
  state.view = view
  stage.dataset.view = view
  viewText.textContent = view
}

function setDuration(duration) {
  state.duration = duration
  durationText.textContent = `${duration}ms`
  document.documentElement.style.setProperty('--orb-duration', `${duration}ms`)
}

function setOffset(offset) {
  state.offset = offset
  offsetText.textContent = `${offset}px`
  document.documentElement.style.setProperty('--orb-panel-ball-offset-y', `${offset}px`)
}

function rightEdgeClip() {
  return 'inset(0 0 0 calc(100% - 40px) round 22px)'
}

function leftEdgeClip() {
  return 'inset(0 calc(100% - 40px) 0 0 round 22px)'
}

function rightCornerClip() {
  return 'inset(0 0 calc(100% - 40px) calc(100% - 40px) round 999px)'
}

function leftCornerClip() {
  return 'inset(0 calc(100% - 40px) calc(100% - 40px) 0 round 999px)'
}

function fullClip(round = 24) {
  return `inset(0 0 0 0 round ${round}px)`
}

function rightCapsuleClip(widthPx, heightPx, radius = 999) {
  return `inset(0 0 calc(100% - ${heightPx}px) calc(100% - ${widthPx}px) round ${radius}px)`
}

function leftCapsuleClip(widthPx, heightPx, radius = 999) {
  return `inset(0 calc(100% - ${widthPx}px) calc(100% - ${heightPx}px) 0 round ${radius}px)`
}

function capsuleClip(widthPx, heightPx, radius = 999) {
  return state.dock === 'right'
    ? rightCapsuleClip(widthPx, heightPx, radius)
    : leftCapsuleClip(widthPx, heightPx, radius)
}

function topBarClip() {
  return 'inset(0 0 calc(100% - 80px) 0 round 22px)'
}

function isLiquidStrategy() {
  return state.strategy === 'liquid-stretch'
}

function isCornerStrategy() {
  return state.strategy === 'corner-return'
}

function currentBallShouldShow() {
  return state.view === 'ball'
}

function resetAnimatedStyles() {
  for (const el of [shell, shellSkin, barSurface, panelSurface, ball, ballGhost]) {
    el.style.opacity = ''
    el.style.transform = ''
    el.style.clipPath = ''
    el.style.display = ''
  }
}

function renderStatic() {
  cancelAnimations()
  resetAnimatedStyles()
  shell.classList.toggle('is-hidden', state.view === 'ball')
  panelSurface.classList.toggle('is-hidden', state.view !== 'panel')
  ballGhost.classList.add('is-hidden')
  ball.classList.toggle('is-hidden', !currentBallShouldShow())
}

function prepareShell(targetView) {
  shell.classList.remove('is-hidden')
  panelSurface.classList.toggle('is-hidden', targetView !== 'panel')
  ballGhost.classList.add('is-hidden')
  if (targetView !== 'ball') ball.classList.add('is-hidden')
}

function animateLiquidSkinIn(duration, view) {
  shellSkin.style.transformOrigin = state.dock === 'right' ? 'top right' : 'top left'
  return finishAnimationHandle(
    shellSkin.animate(
      view === 'panel'
        ? [
            { opacity: 0.96, transform: 'scale(1)' },
            { offset: 0.28, opacity: 0.88, transform: 'scaleX(1.8) scaleY(1.02)' },
            { offset: 0.68, opacity: 0.3, transform: 'scaleX(1.06) scaleY(1)' },
            { opacity: 0, transform: 'scale(1)' },
          ]
        : [
            { opacity: 0.96, transform: 'scale(1)' },
            { offset: 0.34, opacity: 0.82, transform: 'scaleX(1.9) scaleY(1.03)' },
            { offset: 0.72, opacity: 0.18, transform: 'scaleX(1.04) scaleY(1)' },
            { opacity: 0, transform: 'scale(1)' },
          ],
      {
        duration: view === 'panel' ? Math.max(190, Math.round(duration * 0.94)) : Math.max(170, Math.round(duration * 0.82)),
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
        fill: 'both',
      },
    ),
  )
}

function animateLiquidSkinOut(duration, view) {
  shellSkin.style.transformOrigin = state.dock === 'right' ? 'top right' : 'top left'
  return finishAnimationHandle(
    shellSkin.animate(
      view === 'panel'
        ? [
            { opacity: 0, transform: 'scale(1)' },
            { offset: 0.28, opacity: 0.24, transform: 'scaleX(1.04) scaleY(1)' },
            { offset: 0.72, opacity: 0.84, transform: 'scaleX(1.82) scaleY(1.02)' },
            { opacity: 0.96, transform: 'scale(1)' },
          ]
        : [
            { opacity: 0, transform: 'scale(1)' },
            { offset: 0.34, opacity: 0.2, transform: 'scaleX(1.05) scaleY(1)' },
            { offset: 0.76, opacity: 0.8, transform: 'scaleX(1.78) scaleY(1.03)' },
            { opacity: 0.94, transform: 'scale(1)' },
          ],
      {
        duration: view === 'panel' ? Math.max(200, duration) : Math.max(180, Math.round(duration * 0.86)),
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
        fill: 'both',
      },
    ),
  )
}

function animateLiquidSurfaceIn(targetView, duration) {
  if (targetView === 'panel') {
    const barAnim = finishAnimationHandle(
      barSurface.animate(
        [
          { opacity: 0 },
          { offset: 0.34, opacity: 0.08 },
          { offset: 0.58, opacity: 0.76 },
          { opacity: 1 },
        ],
        { duration, easing: 'linear', fill: 'both' },
      ),
    )
    const panelAnim = finishAnimationHandle(
      panelSurface.animate(
        [
          { opacity: 0, transform: 'translateY(-18px)' },
          { offset: 0.56, opacity: 0, transform: 'translateY(-14px)' },
          { offset: 0.84, opacity: 0.82, transform: 'translateY(-4px)' },
          { opacity: 1, transform: 'translateY(0px)' },
        ],
        { duration, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'both' },
      ),
    )
    return Promise.all([barAnim, panelAnim])
  }

  return finishAnimationHandle(
    barSurface.animate(
      [
        { opacity: 0 },
        { offset: 0.4, opacity: 0.06 },
        { offset: 0.72, opacity: 0.84 },
        { opacity: 1 },
      ],
      { duration, easing: 'linear', fill: 'both' },
    ),
  )
}

function animateLiquidSurfaceOut(view, duration) {
  if (view === 'panel') {
    const panelAnim = finishAnimationHandle(
      panelSurface.animate(
        [
          { opacity: 1, transform: 'translateY(0px) scale(1)' },
          { offset: 0.14, opacity: 0.92, transform: 'translateY(-2px) scale(0.996)' },
          { offset: 0.28, opacity: 0.42, transform: 'translateY(-10px) scale(0.986)' },
          { offset: 0.42, opacity: 0, transform: 'translateY(-18px) scale(0.978)' },
          { opacity: 0, transform: 'translateY(-18px) scale(0.978)' },
        ],
        { duration: Math.max(170, Math.round(duration * 0.54)), easing: 'cubic-bezier(0.4, 0, 1, 1)', fill: 'both' },
      ),
    )
    const barAnim = finishAnimationHandle(
      barSurface.animate(
        [
          { opacity: 1, transform: 'translateY(0px) scale(1)' },
          { offset: 0.34, opacity: 1, transform: 'translateY(0px) scale(1)' },
          { offset: 0.64, opacity: 0.96, transform: 'translateY(-1px) scaleX(0.992) scaleY(0.998)' },
          { offset: 0.86, opacity: 0.3, transform: 'translateY(0px) scaleX(0.9) scaleY(0.987)' },
          { opacity: 0, transform: 'translateY(0px) scaleX(0.84) scaleY(0.982)' },
        ],
        { duration, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'both' },
      ),
    )
    return Promise.all([panelAnim, barAnim])
  }

  return finishAnimationHandle(
    barSurface.animate(
      [
        { opacity: 1 },
        { offset: 0.42, opacity: 1 },
        { offset: 0.76, opacity: 0.16 },
        { opacity: 0 },
      ],
      { duration, easing: 'linear', fill: 'both' },
    ),
  )
}

function animateBallOut(duration) {
  if (isLiquidStrategy()) {
    ball.classList.remove('is-hidden')
    ballGhost.classList.add('is-hidden')
    return finishAnimationHandle(
      ball.animate(
        [
          { opacity: 1, transform: 'scale(1)' },
          { offset: 0.18, opacity: 0.32, transform: 'scale(0.94)' },
          { opacity: 0, transform: 'scale(0.88)' },
        ],
        {
          duration: Math.max(110, Math.round(duration * 0.24)),
          easing: 'cubic-bezier(0.32, 0, 0.67, 0)',
          fill: 'both',
        },
      ),
    )
  }

  ball.classList.remove('is-hidden')
  return finishAnimationHandle(
    ball.animate(
      [
        { opacity: 1, transform: 'scale(1)' },
        { opacity: 0, transform: 'scale(0.92)' },
      ],
      { duration: Math.max(90, Math.round(duration * 0.4)), easing: 'linear', fill: 'both' },
    ),
  )
}

function animateBallIn(duration) {
  ball.classList.remove('is-hidden')
  if (isLiquidStrategy()) {
    ballGhost.classList.add('is-hidden')
    return finishAnimationHandle(
      ball.animate(
        [
          { opacity: 0, transform: 'scale(0.82)' },
          { offset: 0.8, opacity: 0, transform: 'scale(0.82)' },
          { offset: 0.92, opacity: 1, transform: 'scale(1.06)' },
          { offset: 0.97, opacity: 1, transform: 'scale(0.978)' },
          { opacity: 1, transform: 'scale(1)' },
        ],
        {
          duration: Math.max(220, Math.round(duration * 1.06)),
          easing: 'linear',
          fill: 'both',
        },
      ),
    )
  }

  return finishAnimationHandle(
    ball.animate(
      [
        { opacity: 0, transform: 'scale(0.92)' },
        { offset: 0.66, opacity: 0, transform: 'scale(0.92)' },
        { opacity: 1, transform: 'scale(1)' },
      ],
      { duration: Math.max(120, duration), easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'both' },
    ),
  )
}

function openShellKeyframes(view) {
  const round = view === 'panel' ? 24 : 22
  if (isLiquidStrategy()) {
    if (view === 'panel') {
      return [
        { opacity: 1, clipPath: state.dock === 'right' ? rightCornerClip() : leftCornerClip(), transform: 'translateY(0px)' },
        { offset: 0.24, opacity: 1, clipPath: capsuleClip(110, 40, 999), transform: 'translateY(0px)' },
        { offset: 0.5, opacity: 1, clipPath: capsuleClip(220, 54, 999), transform: 'translateY(0px)' },
        { offset: 0.72, opacity: 1, clipPath: topBarClip(), transform: 'translateY(0px)' },
        { opacity: 1, clipPath: fullClip(round), transform: 'translateY(0px)' },
      ]
    }

    return [
      { opacity: 1, clipPath: state.dock === 'right' ? rightCornerClip() : leftCornerClip(), transform: 'translateY(0px)' },
      { offset: 0.3, opacity: 1, clipPath: capsuleClip(92, 40, 999), transform: 'translateY(0px)' },
      { offset: 0.62, opacity: 1, clipPath: capsuleClip(196, 52, 999), transform: 'translateY(0px)' },
      { opacity: 1, clipPath: fullClip(round), transform: 'translateY(0px)' },
    ]
  }

  const startClip =
    state.strategy === 'edge-reveal'
      ? state.dock === 'right'
        ? rightEdgeClip()
        : leftEdgeClip()
      : state.dock === 'right'
        ? rightCornerClip()
        : leftCornerClip()
  const startTransform = view === 'panel' && isCornerStrategy() ? `translateY(${-state.offset}px)` : 'translateY(0px)'
  return [
    { opacity: view === 'panel' ? 0.55 : 0.94, clipPath: startClip, transform: startTransform },
    { opacity: 1, clipPath: fullClip(round), transform: 'translateY(0px)' },
  ]
}

function closeShellKeyframes(view) {
  if (isLiquidStrategy()) {
    if (view === 'panel') {
      return [
        { opacity: 1, clipPath: fullClip(24), transform: 'translateY(0px)' },
        { offset: 0.24, opacity: 1, clipPath: 'inset(0 0 18% 0 round 24px)', transform: 'translateY(0px)' },
        { offset: 0.52, opacity: 1, clipPath: topBarClip(), transform: 'translateY(0px)' },
        { offset: 0.78, opacity: 1, clipPath: capsuleClip(236, 56, 999), transform: 'translateY(0px)' },
        { offset: 0.92, opacity: 1, clipPath: capsuleClip(118, 40, 999), transform: 'translateY(0px)' },
        { opacity: 1, clipPath: state.dock === 'right' ? rightCornerClip() : leftCornerClip(), transform: 'translateY(0px)' },
      ]
    }

    return [
      { opacity: 1, clipPath: fullClip(22), transform: 'translateY(0px)' },
      { offset: 0.38, opacity: 1, clipPath: capsuleClip(196, 52, 999), transform: 'translateY(0px)' },
      { offset: 0.74, opacity: 1, clipPath: capsuleClip(92, 40, 999), transform: 'translateY(0px)' },
      { opacity: 1, clipPath: state.dock === 'right' ? rightCornerClip() : leftCornerClip(), transform: 'translateY(0px)' },
    ]
  }

  const endClip =
    view === 'panel' && isCornerStrategy()
      ? state.dock === 'right'
        ? rightCornerClip()
        : leftCornerClip()
      : state.dock === 'right'
        ? rightEdgeClip()
        : leftEdgeClip()
  const endTransform = view === 'panel' && isCornerStrategy() ? `translateY(${-state.offset}px)` : 'translateY(0px)'
  return [
    { opacity: 1, clipPath: fullClip(view === 'panel' ? 24 : 22), transform: 'translateY(0px)' },
    { opacity: view === 'panel' ? 0 : 0.96, clipPath: endClip, transform: endTransform },
  ]
}

function barToBallKeyframes() {
  if (isLiquidStrategy()) {
    const mid = capsuleClip(156, 46, 999)
    const end = capsuleClip(40, 40, 999)
    return [
      { opacity: 1, clipPath: fullClip(22), transform: 'translateY(0px)' },
      { offset: 0.5, opacity: 0.98, clipPath: mid, transform: 'translateY(0px)' },
      { opacity: 0.98, clipPath: end, transform: 'translateY(0px)' },
    ]
  }

  const sideClip = state.dock === 'right' ? rightEdgeClip() : leftEdgeClip()
  const circleClip = state.dock === 'right' ? rightCornerClip() : leftCornerClip()
  const y = `translateY(${-state.offset}px)`
  return [
    { opacity: 1, clipPath: fullClip(22), transform: 'translateY(0px)' },
    { offset: 0.52, opacity: 0.98, clipPath: sideClip, transform: 'translateY(0px)' },
    { offset: 0.8, opacity: 0.98, clipPath: circleClip, transform: y },
    { opacity: 0.98, clipPath: circleClip, transform: y },
  ]
}

async function openTo(targetView) {
  runId += 1
  const token = runId
  cancelAnimations()
  resetAnimatedStyles()
  prepareShell(targetView)
  state.lastTarget = targetView
  setPhase(targetView === 'panel' ? 'opening-panel' : 'opening-bar')

  const shellAnim = finishAnimationHandle(
    shell.animate(openShellKeyframes(targetView), {
      duration: state.duration,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
      fill: 'both',
    }),
  )

  const ballAnim = animateBallOut(state.duration)
  const skinAnim = isLiquidStrategy() ? animateLiquidSkinIn(state.duration, targetView) : Promise.resolve()
  const contentAnim = isLiquidStrategy()
    ? animateLiquidSurfaceIn(targetView, state.duration)
    : finishAnimationHandle(
        (targetView === 'panel' ? panelSurface : barSurface).animate(
          [
            { opacity: 0 },
            { opacity: 1 },
          ],
          { duration: 120, delay: Math.round(state.duration * 0.35), easing: 'linear', fill: 'both' },
        ),
      )

  await Promise.all([shellAnim, ballAnim, skinAnim, contentAnim])
  if (token !== runId) return
  setView(targetView)
  setPhase('idle')
  renderStatic()
}

async function expandBarToPanel() {
  runId += 1
  const token = runId
  cancelAnimations()
  resetAnimatedStyles()
  shell.classList.remove('is-hidden')
  panelSurface.classList.remove('is-hidden')
  setPhase('expanding-panel')

  const panelAnim = finishAnimationHandle(
    panelSurface.animate(
      isLiquidStrategy()
        ? [
            { opacity: 0, transform: 'translateY(-18px)', clipPath: 'inset(0 0 100% 0 round 24px)' },
            { offset: 0.48, opacity: 0.1, transform: 'translateY(-12px)', clipPath: 'inset(0 0 72% 0 round 24px)' },
            { opacity: 1, transform: 'translateY(0px)', clipPath: fullClip(24) },
          ]
        : [
            { opacity: 0, clipPath: 'inset(0 0 100% 0 round 24px)' },
            { opacity: 1, clipPath: fullClip(24) },
          ],
      { duration: Math.max(170, Math.round(state.duration * 0.8)), easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'both' },
    ),
  )

  await panelAnim
  if (token !== runId) return
  setView('panel')
  setPhase('idle')
  renderStatic()
}

async function closeToBall() {
  if (state.view === 'ball') return
  runId += 1
  const token = runId
  cancelAnimations()
  resetAnimatedStyles()
  prepareShell(state.view)
  setPhase(state.view === 'panel' ? 'closing-panel-to-ball' : 'closing-bar-to-ball')

  const closeDuration = state.view === 'panel' && isLiquidStrategy() ? Math.max(320, Math.round(state.duration * 1.18)) : state.duration
  const shellFrames = state.view === 'panel' && isCornerStrategy() ? closeShellKeyframes('panel') : closeShellKeyframes(state.view)
  const shellAnim = finishAnimationHandle(
    shell.animate(shellFrames, {
      duration: closeDuration,
      easing: state.view === 'panel' && isLiquidStrategy() ? 'cubic-bezier(0.2, 0.9, 0.32, 1)' : 'cubic-bezier(0.22, 1, 0.36, 1)',
      fill: 'both',
    }),
  )

  const morphAnim =
    state.view === 'panel' && !isLiquidStrategy()
      ? finishAnimationHandle(
          barSurface.animate(barToBallKeyframes(), {
            duration: closeDuration,
            easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
            fill: 'both',
          }),
        )
      : Promise.resolve()

  const skinAnim = isLiquidStrategy() ? animateLiquidSkinOut(closeDuration, state.view) : Promise.resolve()
  const contentAnim = isLiquidStrategy()
    ? animateLiquidSurfaceOut(state.view, closeDuration)
    : finishAnimationHandle(
        (state.view === 'panel' ? panelSurface : barSurface).animate(
          [
            { opacity: 1 },
            { opacity: 0 },
          ],
          { duration: Math.max(90, Math.round(closeDuration * 0.36)), easing: 'linear', fill: 'both' },
        ),
      )

  const ballAnim = animateBallIn(closeDuration)

  await Promise.all([shellAnim, morphAnim, skinAnim, contentAnim, ballAnim])
  if (token !== runId) return
  setView('ball')
  setPhase('idle')
  renderStatic()
}

async function replayCurrent() {
  const target = state.view === 'ball' ? targetSelect.value : state.view
  if (state.view !== 'ball') await closeToBall()
  await wait(60)
  if (target === 'panel') await openTo('panel')
  else await openTo('bar')
}

async function playDemo() {
  runId += 1
  const token = runId
  cancelAnimations()
  setView('ball')
  setPhase('idle')
  renderStatic()
  await wait(120)
  if (token !== runId) return
  await openTo('bar')
  if (token !== runId) return
  await wait(180)
  if (token !== runId) return
  await expandBarToPanel()
  if (token !== runId) return
  await wait(260)
  if (token !== runId) return
  await closeToBall()
}

dockSelect.addEventListener('change', () => {
  setDock(dockSelect.value)
  renderStatic()
})

strategySelect.addEventListener('change', () => {
  setStrategy(strategySelect.value)
  renderStatic()
})

targetSelect.addEventListener('change', () => {
  state.lastTarget = targetSelect.value
})

durationRange.addEventListener('input', () => {
  setDuration(Number(durationRange.value))
})

offsetRange.addEventListener('input', () => {
  setOffset(Number(offsetRange.value))
})

openBarBtn.addEventListener('click', async () => {
  if (state.view === 'bar') return
  if (state.view === 'panel') await closeToBall()
  await wait(40)
  await openTo('bar')
})

openPanelBtn.addEventListener('click', async () => {
  if (state.view === 'panel') return
  if (state.view === 'bar') {
    await expandBarToPanel()
    return
  }
  await openTo('panel')
})

closeBtn.addEventListener('click', async () => {
  await closeToBall()
})

replayBtn.addEventListener('click', async () => {
  await replayCurrent()
})

demoBtn.addEventListener('click', async () => {
  await playDemo()
})

setDock(state.dock)
setStrategy(state.strategy)
setDuration(state.duration)
setOffset(state.offset)
setView(state.view)
setPhase('idle')
renderStatic()

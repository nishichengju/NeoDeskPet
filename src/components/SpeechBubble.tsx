/**
 * SpeechBubble Component
 * Displays cute speech bubbles with typing effect
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import type { BubbleStyle, TailDirection } from '../../electron/types'
import './SpeechBubble.css'

export interface SpeechBubbleProps {
  text: string
  style?: BubbleStyle
  positionX?: number // 0-100, percentage from left
  positionY?: number // 0-100, percentage from top
  tailDirection?: TailDirection
  startAt?: number | null // 打字开始的时间点（ms），null 表示等待触发
  mode?: 'typing' | 'append' // typing: 逐字打字；append: 外部按段更新 text 逐段出现
  autoHideDelay?: number // 0 = manual close only
  onClose?: () => void
}

export function SpeechBubble({
  text,
  style = 'cute',
  positionX = 75,
  positionY = 10,
  tailDirection = 'down',
  startAt,
  mode = 'typing',
  autoHideDelay = 5000,
  onClose,
}: SpeechBubbleProps) {
  const [displayedText, setDisplayedText] = useState('')
  const [isTyping, setIsTyping] = useState(true)
  const contentRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<number | null>(null)
  const autoHideTimerRef = useRef<number | null>(null)

  // Calculate typing speed based on text length and autoHideDelay
  const getTypingSpeed = useCallback(() => {
    if (!text) return 50
    // Reserve 1 second for reading after typing completes
    const typingTime = Math.max(autoHideDelay - 1000, text.length * 30)
    return Math.max(20, Math.min(80, typingTime / text.length))
  }, [text, autoHideDelay])

  // Typing effect
  useEffect(() => {
    if (mode !== 'typing') return
    if (!text) return
    if (startAt === null) {
      setDisplayedText('')
      setIsTyping(true)
      return
    }

    setDisplayedText('')
    setIsTyping(true)
    let index = 0
    const speed = getTypingSpeed()
    const delayMs = typeof startAt === 'number' ? Math.max(0, startAt - Date.now()) : 0

    const type = () => {
      if (index < text.length) {
        setDisplayedText(text.slice(0, index + 1))
        index++
        timerRef.current = window.setTimeout(type, speed)
      } else {
        setIsTyping(false)
      }
    }

    timerRef.current = window.setTimeout(type, delayMs)

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
      }
    }
  }, [text, startAt, getTypingSpeed, mode])

  // Append mode: external updates decide what to show (e.g. TTS 分句同步)
  useEffect(() => {
    if (mode !== 'append') return
    if (startAt === null) {
      setDisplayedText('')
      setIsTyping(true)
      return
    }

    setDisplayedText(text || '')
    setIsTyping(false)
  }, [text, startAt, mode])

  // Auto-scroll to bottom during typing
  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight
    }
  }, [displayedText])

  // Auto-hide after delay
  useEffect(() => {
    if (!onClose || autoHideDelay <= 0) return

    if (mode === 'append') {
      if (startAt === null) return
      autoHideTimerRef.current = window.setTimeout(() => {
        onClose()
      }, autoHideDelay)
      return () => {
        if (autoHideTimerRef.current) clearTimeout(autoHideTimerRef.current)
      }
    }

    if (!isTyping) {
      autoHideTimerRef.current = window.setTimeout(() => {
        onClose()
      }, 1000) // 1 second after typing completes
    }

    return () => {
      if (autoHideTimerRef.current) {
        clearTimeout(autoHideTimerRef.current)
      }
    }
  }, [isTyping, autoHideDelay, onClose, mode, startAt, text])

  const handleClose = () => {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (autoHideTimerRef.current) clearTimeout(autoHideTimerRef.current)
    onClose?.()
  }

  // Calculate position style
  const positionStyle: React.CSSProperties = {
    left: `${positionX}%`,
    top: `${positionY}%`,
    transform: 'translate(-50%, 0)', // Center horizontally on the X position
  }

  return (
    <div
      className={`speech-bubble speech-bubble-style-${style}`}
      style={positionStyle}
    >
      <div className="speech-bubble-content" ref={contentRef}>
        <span className="speech-bubble-text">{displayedText}</span>
        {isTyping && <span className="typing-cursor">|</span>}
        <button className="speech-bubble-close" onClick={handleClose} title="Close">
          ×
        </button>
      </div>
      <div className={`speech-bubble-tail tail-${tailDirection}`} />
    </div>
  )
}

export default SpeechBubble

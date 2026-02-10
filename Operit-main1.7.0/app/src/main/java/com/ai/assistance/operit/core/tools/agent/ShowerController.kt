package com.ai.assistance.operit.core.tools.agent

import com.ai.assistance.operit.util.AppLogger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString

/**
 * Lightweight controller to talk to the Shower server running locally on the device.
 *
 * Responsibilities:
 * - Maintain a single WebSocket connection to ws://127.0.0.1:8986
 * - Send simple text commands: CREATE_DISPLAY, LAUNCH_APP, TAP, KEY, TOUCH_*
 * - Parse log messages to discover the virtual display id created by Shower.
 *
 * NOTE: Binary video frames are currently ignored; screenshots are captured via screencap -d later.
 */
object ShowerController {

    private const val TAG = "ShowerController"
    private const val HOST = "127.0.0.1"
    private const val PORT = 8986

    private val client: OkHttpClient = OkHttpClient.Builder().build()

    @Volatile
    private var webSocket: WebSocket? = null

    @Volatile
    private var connected: Boolean = false

    @Volatile
    private var virtualDisplayId: Int? = null

    fun getDisplayId(): Int? = virtualDisplayId

    @Volatile
    private var videoWidth: Int = 0

    @Volatile
    private var videoHeight: Int = 0

    fun getVideoSize(): Pair<Int, Int>? = if (videoWidth > 0 && videoHeight > 0) Pair(videoWidth, videoHeight) else null

    @Volatile
    private var binaryHandler: ((ByteArray) -> Unit)? = null

    fun setBinaryHandler(handler: ((ByteArray) -> Unit)?) {
        binaryHandler = handler
    }

    @Volatile
    private var pendingScreenshot: CompletableDeferred<ByteArray?>? = null

    @Volatile
    private var connectingDeferred: CompletableDeferred<Boolean>? = null

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            connected = true
            connectingDeferred?.complete(true)
            connectingDeferred = null
            AppLogger.d(TAG, "WebSocket connected to Shower server")
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            connected = false
            this@ShowerController.webSocket = null
            connectingDeferred?.complete(false)
            connectingDeferred = null
            AppLogger.d(TAG, "WebSocket closed: code=$code reason=$reason")
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            connected = false
            this@ShowerController.webSocket = null
            AppLogger.e(TAG, "WebSocket failure", t)
            // Fail any pending screenshot request.
            pendingScreenshot?.complete(null)
            pendingScreenshot = null
            connectingDeferred?.complete(false)
            connectingDeferred = null
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            // First handle screenshot responses (to avoid logging large Base64 payloads).
            if (text.startsWith("SCREENSHOT_DATA ")) {
                val base64 = text.substring("SCREENSHOT_DATA ".length).trim()
                try {
                    val bytes = android.util.Base64.decode(base64, android.util.Base64.DEFAULT)
                    AppLogger.d(TAG, "Received screenshot via WS, size=${bytes.size}")
                    pendingScreenshot?.complete(bytes)
                } catch (e: Exception) {
                    AppLogger.e(TAG, "Failed to decode SCREENSHOT_DATA", e)
                    pendingScreenshot?.complete(null)
                } finally {
                    pendingScreenshot = null
                }
                return
            } else if (text.startsWith("SCREENSHOT_ERROR")) {
                AppLogger.w(TAG, "Received SCREENSHOT_ERROR from Shower server: $text")
                pendingScreenshot?.complete(null)
                pendingScreenshot = null
                return
            }

            AppLogger.d(TAG, "WS text: $text")
            val marker = "Virtual display id="
            val idx = text.indexOf(marker)
            if (idx >= 0) {
                val start = idx + marker.length
                val end = text.indexOfAny(charArrayOf(' ', ',', ';', '\n', '\r'), start).let { if (it == -1) text.length else it }
                val idStr = text.substring(start, end).trim()
                val id = idStr.toIntOrNull()
                if (id != null) {
                    virtualDisplayId = id
                    AppLogger.d(TAG, "Discovered Shower virtual display id=$id from logs")
                }
            }
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            // Binary frames contain H.264 video; forward to any registered handler.
            binaryHandler?.invoke(bytes.toByteArray())
        }
    }

    private fun buildUrl(): String = "ws://$HOST:$PORT"

    /**
     * Ensure a WebSocket connection to the local Shower server exists.
     * This is best-effort: it does not wait for the HTTP upgrade to complete.
     */
    suspend fun ensureConnected(): Boolean = withContext(Dispatchers.IO) {
        if (webSocket != null && connected) {
            return@withContext true
        }

        val existing = connectingDeferred
        if (existing != null) {
            return@withContext try {
                withTimeout(2000L) {
                    existing.await()
                }
            } catch (e: Exception) {
                AppLogger.e(TAG, "Waiting for existing WebSocket connection failed", e)
                false
            }
        }

        val deferred = CompletableDeferred<Boolean>()
        connectingDeferred = deferred
        return@withContext try {
            val request = Request.Builder().url(buildUrl()).build()
            webSocket = client.newWebSocket(request, listener)
            withTimeout(2000L) {
                deferred.await()
            }
        } catch (e: Exception) {
            AppLogger.e(TAG, "Failed to connect WebSocket to Shower server", e)
            connectingDeferred = null
            false
        }
    }

    /**
     * Request a PNG screenshot of the current Shower virtual display over WebSocket.
     *
     * Protocol:
     *   - Client sends:  SCREENSHOT
     *   - Server replies: SCREENSHOT_DATA <base64_png>
     *   - Or:           SCREENSHOT_ERROR <reason>
     */
    suspend fun requestScreenshot(timeoutMs: Long = 3000L): ByteArray? = withContext(Dispatchers.IO) {
        val ok = ensureConnected()
        if (!ok) return@withContext null

        // Only allow one outstanding screenshot at a time; cancel any previous one.
        pendingScreenshot?.complete(null)
        val deferred = CompletableDeferred<ByteArray?>()
        pendingScreenshot = deferred

        if (!sendText("SCREENSHOT")) {
            AppLogger.w(TAG, "Failed to send SCREENSHOT command")
            pendingScreenshot = null
            return@withContext null
        }

        try {
            withTimeout(timeoutMs) {
                deferred.await()
            }
        } catch (e: Exception) {
            AppLogger.e(TAG, "requestScreenshot timed out or failed", e)
            pendingScreenshot = null
            null
        }
    }

    private fun sendText(cmd: String): Boolean {
        val ws = webSocket
        if (ws == null) {
            AppLogger.w(TAG, "sendText called but WebSocket is null: $cmd")
            return false
        }
        return try {
            AppLogger.d(TAG, "Sending command: $cmd")
            ws.send(cmd)
        } catch (e: Exception) {
            AppLogger.e(TAG, "Failed to send command: $cmd", e)
            false
        }
    }

    suspend fun ensureDisplay(width: Int, height: Int, dpi: Int, bitrateKbps: Int? = null): Boolean {
        val ok = ensureConnected()
        if (!ok) return false

        // Always request the server to destroy any existing virtual display before creating
        // a new one. This ensures that a fresh encoder is created and its configuration
        // (csd-0/csd-1) is resent, so the client decoder can reliably initialize even if
        // it connects after a previous session.
        sendText("DESTROY_DISPLAY")

        var alignedWidth = width and -8
        var alignedHeight = height and -8
        if (alignedWidth <= 0 || alignedHeight <= 0) {
            alignedWidth = maxOf(2, width)
            alignedHeight = maxOf(2, height)
        }

        videoWidth = alignedWidth
        videoHeight = alignedHeight
        val cmd = buildString {
            append("CREATE_DISPLAY ")
            append(alignedWidth)
            append(' ')
            append(alignedHeight)
            append(' ')
            append(dpi)
            if (bitrateKbps != null && bitrateKbps > 0) {
                append(' ')
                append(bitrateKbps)
            }
        }
        return sendText(cmd)
    }

    suspend fun launchApp(packageName: String): Boolean {
        val ok = ensureConnected()
        if (!ok) return false
        if (packageName.isBlank()) return false
        return sendText("LAUNCH_APP $packageName")
    }

    suspend fun tap(x: Int, y: Int): Boolean {
        val ok = ensureConnected()
        if (!ok) return false
        return sendText("TAP $x $y")
    }

    suspend fun swipe(startX: Int, startY: Int, endX: Int, endY: Int, durationMs: Long = 300L): Boolean {
        val ok = ensureConnected()
        if (!ok) return false
        return sendText("SWIPE $startX $startY $endX $endY $durationMs")
    }

    suspend fun touchDown(x: Int, y: Int): Boolean {
        val ok = ensureConnected()
        if (!ok) return false
        return sendText("TOUCH_DOWN $x $y")
    }

    suspend fun touchMove(x: Int, y: Int): Boolean {
        val ok = ensureConnected()
        if (!ok) return false
        return sendText("TOUCH_MOVE $x $y")
    }

    suspend fun touchUp(x: Int, y: Int): Boolean {
        val ok = ensureConnected()
        if (!ok) return false
        return sendText("TOUCH_UP $x $y")
    }

    fun shutdown() {
        // Best-effort: ask server to destroy the current virtual display, then close WS.
        try {
            sendText("DESTROY_DISPLAY")
        } catch (_: Exception) {
        }
        try {
            webSocket?.close(1000, "overlay_closed")
        } catch (e: Exception) {
            AppLogger.e(TAG, "Error closing WebSocket in shutdown", e)
        } finally {
            webSocket = null
            connected = false
            virtualDisplayId = null
            videoWidth = 0
            videoHeight = 0
            binaryHandler = null
        }
    }

    suspend fun key(keyCode: Int): Boolean {
        val ok = ensureConnected()
        if (!ok) return false
        return sendText("KEY $keyCode")
    }
}

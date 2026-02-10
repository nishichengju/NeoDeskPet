package com.ai.assistance.operit.ui.common.displays

import android.content.Context
import android.util.AttributeSet
import android.view.SurfaceHolder
import android.view.SurfaceView
import com.ai.assistance.operit.core.tools.agent.ShowerController
import com.ai.assistance.operit.core.tools.agent.ShowerVideoRenderer
import com.ai.assistance.operit.util.AppLogger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * SurfaceView used inside the virtual display overlay to render the Shower video stream.
 */
class ShowerSurfaceView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null
) : SurfaceView(context, attrs), SurfaceHolder.Callback {

    companion object {
        private const val TAG = "ShowerSurfaceView"
    }

    private var attachJob: Job? = null

    init {
        holder.setFormat(android.graphics.PixelFormat.TRANSPARENT)
        holder.addCallback(this)
    }

    override fun surfaceCreated(holder: SurfaceHolder) {
        AppLogger.d(TAG, "surfaceCreated")
        // Cancel any previous job
        attachJob?.cancel()
        attachJob = CoroutineScope(Dispatchers.Main).launch {
            var size: Pair<Int, Int>? = null
            // Retry for a short period to wait for the video size to be set by the controller,
            // resolving a potential race condition.
            for (i in 0 until 20) { // Max wait: 20 * 100ms = 2 seconds
                size = ShowerController.getVideoSize()
                if (size != null) break
                delay(100)
            }

            if (size != null) {
                val (w, h) = size
                AppLogger.d(TAG, "Attaching renderer with size: ${w}x${h}")
                ShowerVideoRenderer.attach(holder.surface, w, h)
            } else {
                AppLogger.e(TAG, "Failed to get video size after multiple retries.")
            }
        }

        // Route binary video frames to the renderer
        ShowerController.setBinaryHandler { data ->
            ShowerVideoRenderer.onFrame(data)
        }
    }

    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
        // No-op for now; scaling is handled by SurfaceView layout.
    }

    override fun surfaceDestroyed(holder: SurfaceHolder) {
        AppLogger.d(TAG, "surfaceDestroyed")
        attachJob?.cancel()
        attachJob = null
        ShowerController.setBinaryHandler(null)
        ShowerVideoRenderer.detach()
    }
}

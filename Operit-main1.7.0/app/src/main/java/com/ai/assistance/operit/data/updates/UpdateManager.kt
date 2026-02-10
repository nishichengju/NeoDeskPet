package com.ai.assistance.operit.data.updates

import android.content.Context
import com.ai.assistance.operit.util.AppLogger
import androidx.lifecycle.LiveData
import androidx.lifecycle.MutableLiveData
import com.ai.assistance.operit.R
import com.ai.assistance.operit.util.GithubReleaseUtil
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray

// 更新状态 - 移除下载相关状态
sealed class UpdateStatus {
    object Initial : UpdateStatus()
    object Checking : UpdateStatus()
    data class Available(
            val newVersion: String,
            val updateUrl: String,
            val releaseNotes: String,
            val downloadUrl: String = "" // 保留下载URL字段用于浏览器打开
    ) : UpdateStatus()
    object UpToDate : UpdateStatus()
    data class Error(val message: String) : UpdateStatus()
}

/** UpdateManager - 处理应用更新的核心类 负责检查更新 */
class UpdateManager private constructor(private val context: Context) {
    private val TAG = "UpdateManager"

    // 更新状态LiveData，可从UI中观察
    private val _updateStatus = MutableLiveData<UpdateStatus>(UpdateStatus.Initial)
    val updateStatus: LiveData<UpdateStatus> = _updateStatus

    init {
        AppLogger.d(TAG, "UpdateManager initialized")
    }

    companion object {
        @Volatile private var INSTANCE: UpdateManager? = null

        fun getInstance(context: Context): UpdateManager {
            return INSTANCE
                    ?: synchronized(this) {
                        val instance = UpdateManager(context.applicationContext)
                        INSTANCE = instance
                        instance
                    }
        }

        /**
         * 比较两个版本号
         * @return -1 如果v1 < v2, 0 如果 v1 == v2, 1 如果 v1 > v2
         */
        fun compareVersions(v1: String, v2: String): Int {
            // 移除可能的 'v' 前缀
            val version1 = v1.removePrefix("v")
            val version2 = v2.removePrefix("v")

            val parts1 = version1.split(".")
            val parts2 = version2.split(".")

            val maxLength = maxOf(parts1.size, parts2.size)

            for (i in 0 until maxLength) {
                val part1 = if (i < parts1.size) parts1[i].toIntOrNull() ?: 0 else 0
                val part2 = if (i < parts2.size) parts2[i].toIntOrNull() ?: 0 else 0

                if (part1 < part2) return -1
                if (part1 > part2) return 1
            }

            return 0
        }

        /** 检查更新，返回更新状态 用于从MainActivity直接检查更新 */
        suspend fun checkForUpdates(context: Context, currentVersion: String): UpdateStatus {
            val manager = getInstance(context)
            return manager.checkForUpdatesInternal(currentVersion)
        }
    }

    /** 开始更新检查流程 */
    suspend fun checkForUpdates(currentVersion: String) {
        _updateStatus.postValue(UpdateStatus.Checking)

        try {
            val result = checkForUpdatesInternal(currentVersion)
            _updateStatus.postValue(result)
        } catch (e: Exception) {
            AppLogger.e(TAG, "Update check failed", e)
            _updateStatus.postValue(UpdateStatus.Error("更新检查失败: ${e.message}"))
        }
    }

    /** 检查更新的内部实现 */
    private suspend fun checkForUpdatesInternal(currentVersion: String): UpdateStatus {
        return withContext(Dispatchers.IO) {
            try {
                // 从字符串资源中获取GitHub仓库信息
                val aboutWebsite = context.getString(R.string.about_website)

                // 解析GitHub仓库链接 - 处理HTML格式
                val htmlContent = aboutWebsite.replace("&lt;", "<").replace("&gt;", ">")
                val githubUrlPattern = "https://github.com/([^/\"<>]+)/([^/\"<>]+)".toRegex()
                val matchResult = githubUrlPattern.find(htmlContent)

                val (repoOwner, repoName) =
                        if (matchResult != null) {
                            Pair(matchResult.groupValues[1], matchResult.groupValues[2])
                        } else {
                            Pair("AAswordman", "Operit") // 默认值
                        }

                val githubReleaseUtil = GithubReleaseUtil(context)
                val releaseInfo = githubReleaseUtil.fetchLatestReleaseInfo(repoOwner, repoName)

                if (releaseInfo != null) {
                    if (compareVersions(releaseInfo.version, currentVersion) > 0) {
                        UpdateStatus.Available(
                            newVersion = releaseInfo.version,
                            updateUrl = releaseInfo.releasePageUrl,
                            releaseNotes = releaseInfo.releaseNotes,
                            downloadUrl = releaseInfo.downloadUrl
                        )
                    } else {
                        UpdateStatus.UpToDate
                    }
                } else {
                    UpdateStatus.Error("无法获取更新信息。")
                }
            } catch (e: Exception) {
                AppLogger.e(TAG, "Error checking for updates", e)
                return@withContext UpdateStatus.Error("更新检查失败: ${e.message}")
            }
        }
    }
}

package com.ai.assistance.operit.ui.features.about.screens

import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.text.Html
import android.text.method.LinkMovementMethod
import android.widget.TextView
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.rounded.Info
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.ai.assistance.operit.R
import com.ai.assistance.operit.data.updates.UpdateManager
import com.ai.assistance.operit.data.updates.UpdateStatus
import com.ai.assistance.operit.util.GithubReleaseUtil
import kotlinx.coroutines.launch
import com.ai.assistance.operit.ui.components.CustomScaffold

private const val GITHUB_PROJECT_URL = "https://github.com/AAswordman/Operit"

@Composable
fun HtmlText(
    html: String,
    modifier: Modifier = Modifier,
    style: androidx.compose.ui.text.TextStyle = MaterialTheme.typography.bodyMedium
) {
    val context = LocalContext.current
    val textColor = style.color.toArgb()

    AndroidView(
        modifier = modifier,
        factory = { context ->
            TextView(context).apply {
                this.textSize = style.fontSize.value
                this.setTextColor(textColor)
                this.movementMethod = LinkMovementMethod.getInstance()
            }
        },
        update = { textView ->
            textView.text =
                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.N) {
                    Html.fromHtml(html, Html.FROM_HTML_MODE_COMPACT)
                } else {
                    @Suppress("DEPRECATION") Html.fromHtml(html)
                }
        }
    )
}

@Composable
fun InfoItem(
    icon: ImageVector,
    title: String,
    content: @Composable () -> Unit,
    modifier: Modifier = Modifier
) {
    Row(
        modifier = modifier.fillMaxWidth().padding(vertical = 8.dp),
        verticalAlignment = Alignment.Top
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(end = 16.dp, top = 2.dp)
        )
        Column {
            Text(
                text = title,
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.onSurface
            )
            Box(modifier = Modifier.padding(top = 4.dp)) { content() }
        }
    }
}

// 定义用于展示的开源库数据类
data class OpenSourceLibrary(
    val name: String,
    val description: String = "",
    val license: String = "",
    val website: String = ""
)

// 准备开源库列表
private fun getOpenSourceLibraries(): List<OpenSourceLibrary> {
    return listOf(
        // UI & Android Framework
        OpenSourceLibrary("android-gif-drawable", "GIF support for Android", "MIT", "https://github.com/koral--/android-gif-drawable"),
        OpenSourceLibrary("Android-Image-Cropper", "Image cropping library for Android", "Apache-2.0", "https://github.com/CanHub/Android-Image-Cropper"),
        OpenSourceLibrary("AndroidSVG", "SVG rendering library", "Apache-2.0", "https://github.com/BigBadaboom/androidsvg"),
        OpenSourceLibrary("AndroidX Compose", "Modern declarative UI toolkit for Android", "Apache-2.0", "https://developer.android.com/jetpack/compose"),
        OpenSourceLibrary("AndroidX Core KTX", "Kotlin extensions for Android core libraries", "Apache-2.0", "https://developer.android.com/jetpack/androidx"),
        OpenSourceLibrary("AndroidX DataStore", "Data storage solution", "Apache-2.0", "https://developer.android.com/jetpack/androidx/releases/datastore"),
        OpenSourceLibrary("AndroidX Security Crypto", "Encryption library for Android", "Apache-2.0", "https://developer.android.com/jetpack/androidx/releases/security"),
        OpenSourceLibrary("AndroidX Window", "Window manager library for foldables", "Apache-2.0", "https://developer.android.com/jetpack/androidx/releases/window"),
        OpenSourceLibrary("AndroidX WorkManager", "Background job scheduling library", "Apache-2.0", "https://developer.android.com/jetpack/androidx/releases/work"),
        OpenSourceLibrary("AndroidX Glance", "Compose for App Widgets", "Apache-2.0", "https://developer.android.com/jetpack/androidx/releases/glance"),
        OpenSourceLibrary("Accompanist", "Utilities for Jetpack Compose", "Apache-2.0", "https://github.com/google/accompanist"),
        OpenSourceLibrary("colorpicker-compose", "A color picker for Jetpack Compose", "Apache-2.0", "https://github.com/skydoves/colorpicker-compose"),
        OpenSourceLibrary("Reorderable", "Drag-and-drop reorderable list for Compose", "Apache-2.0", "https://github.com/Calvin-LL/Reorderable"),
        OpenSourceLibrary("Swipe", "Swipe-to-reveal actions for Compose", "Apache-2.0", "https://github.com/saket/swipe"),
        
        // File & Archive Processing
        OpenSourceLibrary("Apache Commons Compress", "Library for working with archives", "Apache-2.0", "https://commons.apache.org/proper/commons-compress/"),
        OpenSourceLibrary("Apache Commons IO", "Library of I/O utilities", "Apache-2.0", "https://commons.apache.org/proper/commons-io/"),
        OpenSourceLibrary("junrar", "RAR archive extraction library", "The Unlicense", "https://github.com/junrar/junrar"),
        OpenSourceLibrary("ZIP4J", "Java library for ZIP file handling", "Apache-2.0", "https://github.com/srikanth-lingala/zip4j"),
        
        // Document Processing
        OpenSourceLibrary("Apache PDFBox", "Java library for working with PDF documents", "Apache-2.0", "https://pdfbox.apache.org/"),
        OpenSourceLibrary("Apache POI", "Document processing library (Excel, Word, PowerPoint)", "Apache-2.0", "https://poi.apache.org/"),
        OpenSourceLibrary("iText (v5)", "Library for creating and manipulating PDF files", "MPL/LGPL", "https://itextpdf.com/"),
        
        // APK Tools
        OpenSourceLibrary("apk-parser", "A parser for APK files", "Apache-2.0", "https://github.com/hsiafan/apk-parser"),
        OpenSourceLibrary("apksig", "APK signing tool", "Apache-2.0", "https://developer.android.com/tools/apksigner"),
        OpenSourceLibrary("axml", "A-XML format parsing library", "Apache-2.0", "https://github.com/Sable/axml"),
        OpenSourceLibrary("zipalign-java", "zipalign implementation in Java", "MIT", "https://github.com/Iyxan23/zipalign-java"),
        
        // Image Processing
        OpenSourceLibrary("Coil", "Image loading library for Android", "Apache-2.0", "https://coil-kt.github.io/coil/"),
        OpenSourceLibrary("Glide", "Image loading library for Android", "BSD, MIT, Apache-2.0", "https://github.com/bumptech/glide"),
        
        // Multimedia
        OpenSourceLibrary("ExoPlayer", "Extensible media player for Android", "Apache-2.0", "https://exoplayer.dev/"),
        OpenSourceLibrary("FFmpegKit", "FFmpeg toolkit for mobile platforms", "LGPL-3.0", "https://github.com/arthenica/ffmpeg-kit"),
        
        // AI & Machine Learning
        OpenSourceLibrary("ML Kit", "Google's machine learning toolkit for mobile", "Apache-2.0", "https://developers.google.com/ml-kit"),
        OpenSourceLibrary("MediaPipe", "Cross-platform ML solutions", "Apache-2.0", "https://developers.google.com/mediapipe"),
        OpenSourceLibrary("MNN", "Alibaba's lightweight deep learning inference engine", "Apache-2.0", "https://github.com/alibaba/MNN"),
        OpenSourceLibrary("ONNX Runtime", "Cross-platform ML inference engine", "MIT", "https://github.com/microsoft/onnxruntime"),
        OpenSourceLibrary("TensorFlow Lite", "On-device machine learning framework", "Apache-2.0", "https://www.tensorflow.org/lite"),
        
        // NLP & Search
        OpenSourceLibrary("HNSWLib", "Fast approximate nearest neighbor search", "Apache-2.0", "https://github.com/jelmerk/hnswlib"),
        OpenSourceLibrary("Jieba-Android", "Jieba Chinese word segmentation for Android", "MIT", "https://github.com/huaban/jieba-analysis"),
        
        // Networking
        OpenSourceLibrary("Apache FTPServer", "FTP server library", "Apache-2.0", "https://mina.apache.org/ftpserver-project/"),
        OpenSourceLibrary("Apache SSHD", "SSH server and client library", "Apache-2.0", "https://mina.apache.org/sshd-project/"),
        OpenSourceLibrary("JSch", "Java SSH client library", "BSD-3-Clause", "https://github.com/mwiede/jsch"),
        OpenSourceLibrary("Jsoup", "Java HTML parser", "MIT", "https://jsoup.org/"),
        OpenSourceLibrary("Ktor", "Asynchronous networking framework", "Apache-2.0", "https://ktor.io/"),
        OpenSourceLibrary("MCP SDK", "Model Context Protocol SDK", "MIT", "https://github.com/modelcontextprotocol/kotlin-sdk"),
        OpenSourceLibrary("NanoHTTPD", "Lightweight HTTP server library", "BSD-3-Clause", "https://github.com/NanoHttpd/nanohttpd"),
        OpenSourceLibrary("OkHttp", "HTTP client library", "Apache-2.0", "https://square.github.io/okhttp/"),
        OpenSourceLibrary("Retrofit", "Type-safe HTTP client", "Apache-2.0", "https://square.github.io/retrofit/"),
        
        // Data & Serialization
        OpenSourceLibrary("Gson", "Google's JSON parsing library", "Apache-2.0", "https://github.com/google/gson"),
        OpenSourceLibrary("HJSON", "Human-friendly JSON format", "MIT", "https://hjson.github.io/"),
        OpenSourceLibrary("kotlin-uuid", "UUID library for Kotlin", "Apache-2.0", "https://github.com/benasher44/uuid"),
        OpenSourceLibrary("kotlinx.serialization", "Kotlin serialization library", "Apache-2.0", "https://github.com/Kotlin/kotlinx.serialization"),
        OpenSourceLibrary("Moshi", "Modern JSON library for Kotlin", "Apache-2.0", "https://github.com/square/moshi"),
        
        // Database
        OpenSourceLibrary("ObjectBox", "High-performance NoSQL database", "Apache-2.0", "https://objectbox.io/"),
        OpenSourceLibrary("Room", "Android SQLite ORM library", "Apache-2.0", "https://developer.android.com/training/data-storage/room"),
        
        // LaTeX & Math Rendering
        OpenSourceLibrary("JLatexMath-Android", "LaTeX formula rendering library", "GPL-2.0 with Classpath Exception", "https://github.com/noties/jlatexmath-android"),
        OpenSourceLibrary("RenderX", "LaTeX rendering library", "MIT", "https://github.com/tech-pw/RenderX"),
        
        // Security & Crypto
        OpenSourceLibrary("Bouncy Castle", "Cryptography library", "MIT", "https://www.bouncycastle.org/"),
        
        // System & Root
        OpenSourceLibrary("libsu", "Root access library for Android", "Apache-2.0", "https://github.com/topjohnwu/libsu"),
        OpenSourceLibrary("Shizuku", "System service for apps to use system APIs directly", "Apache-2.0", "https://github.com/RikkaApps/Shizuku"),
        OpenSourceLibrary("Tasker Plugin Library", "Library for creating Tasker plugins", "Apache-2.0", "https://github.com/joaomgcd/TaskerPluginLibrary"),
        
        // Terminal & Native
        OpenSourceLibrary("Code FA", "VS Code for Android (code-server based)", "BSD-3-Clause", "https://github.com/nightmare-space/code_lfa"),
        OpenSourceLibrary("DragonBones", "Popular 2D skeletal animation library", "MIT", "https://github.com/DragonBones/DragonBonesCPP"),
        
        // Kotlin & Logging
        OpenSourceLibrary("java-diff-utils", "Diff library for Java", "Apache-2.0", "https://github.com/java-diff-utils/java-diff-utils"),
        OpenSourceLibrary("Kotlin Coroutines", "Kotlin coroutines library", "Apache-2.0", "https://github.com/Kotlin/kotlinx.coroutines"),
        OpenSourceLibrary("kotlin-logging", "Lightweight logging framework for Kotlin", "Apache-2.0", "https://github.com/oshai/kotlin-logging"),
        OpenSourceLibrary("sherpa-ncnn", "Real-time speech recognition with Next-gen Kaldi", "Apache-2.0", "https://github.com/k2-fsa/sherpa-ncnn"),
        OpenSourceLibrary("sherpa-mnn", "Speech recognition with MNN backend", "Apache-2.0", "https://github.com/k2-fsa/sherpa-mnn"),
        OpenSourceLibrary("SLF4J", "Simple Logging Facade for Java", "MIT", "https://www.slf4j.org/")
    ).sortedBy { it.name }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LicenseDialog(onDismiss: () -> Unit) {
    val libraries = remember { getOpenSourceLibraries() }
    val context = LocalContext.current

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(id = R.string.open_source_licenses)) },
        text = {
            LazyColumn(modifier = Modifier.fillMaxWidth()) {
                items(libraries) { library ->
                    ListItem(
                        headlineContent = { Text(library.name, fontWeight = FontWeight.Bold) },
                        supportingContent = {
                            Column {
                                if (library.description.isNotEmpty()) {
                                    Text(
                                        text = library.description,
                                        style = MaterialTheme.typography.bodySmall
                                    )
                                }
                                Text(
                                    text = stringResource(id = R.string.license_format, library.license),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f)
                                )
                            }
                        },
                        trailingContent = {
                            if (library.website.isNotEmpty()) {
                                IconButton(onClick = {
                                    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(library.website)).apply {
                                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                                    }
                                    context.startActivity(intent)
                                }) {
                                    Icon(Icons.Default.OpenInBrowser, contentDescription = stringResource(id = R.string.visit_project))
                                }
                            }
                        }
                    )
                    HorizontalDivider()
                }
            }
        },
        confirmButton = {
            Button(onClick = onDismiss) {
                Text(stringResource(id = R.string.ok))
            }
        }
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AboutScreen(
    navigateToUpdateHistory: () -> Unit
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    // 获取UpdateManager实例
    val updateManager = remember { UpdateManager.getInstance(context) }

    // 监听更新状态
    var updateStatus by remember { mutableStateOf<UpdateStatus>(UpdateStatus.Initial) }

    // 观察UpdateManager的LiveData
    DisposableEffect(updateManager) {
        val observer = androidx.lifecycle.Observer<UpdateStatus> { newStatus -> updateStatus = newStatus }
        updateManager.updateStatus.observeForever(observer)

        onDispose { updateManager.updateStatus.removeObserver(observer) }
    }

    // 显示更新对话框
    var showUpdateDialog by remember { mutableStateOf(false) }
    // 添加下载源选择对话框状态
    var showDownloadSourceMenu by remember { mutableStateOf(false) }

    // 添加开源许可对话框状态
    var showLicenseDialog by remember { mutableStateOf(false) }

    // 检查更新按钮动画
    val buttonAlpha = animateFloatAsState(
        targetValue = if (updateStatus is UpdateStatus.Checking) 0.6f else 1f,
        label = "ButtonAlpha"
    )

    // 获取应用版本信息
    val appVersion = remember {
        try {
            val packageInfo = context.packageManager.getPackageInfo(context.packageName, 0)
            packageInfo.versionName
        } catch (e: PackageManager.NameNotFoundException) {
            "未知"
        }
    }

    // 观察更新状态变化
    LaunchedEffect(updateStatus) {
        when (updateStatus) {
            is UpdateStatus.Available, is UpdateStatus.UpToDate, is UpdateStatus.Error -> {
                showUpdateDialog = true
            }
            else -> {}
        }
    }

    // 检查更新
    fun checkForUpdates() {
        scope.launch { updateManager.checkForUpdates(appVersion) }
    }

    // 处理下载更新 - 显示下载源选择对话框
    fun handleDownload() {
        val status = updateStatus as? UpdateStatus.Available ?: return
        if (status.downloadUrl.isNotEmpty() && status.downloadUrl.endsWith(".apk")) {
            showDownloadSourceMenu = true // 显示下载源选择对话框
        } else {
            // 如果没有APK下载链接，则直接打开更新页面
            val intent = Intent(Intent.ACTION_VIEW).apply {
                data = Uri.parse(status.updateUrl)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
            showUpdateDialog = false
        }
    }

    // 从指定源下载
    fun downloadFromUrl(downloadUrl: String) {
        // 打开浏览器下载
        val intent = Intent(Intent.ACTION_VIEW).apply {
            data = Uri.parse(downloadUrl)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)
        showDownloadSourceMenu = false
        showUpdateDialog = false
    }

    // 显示开源许可对话框
    if (showLicenseDialog) {
        LicenseDialog(onDismiss = { showLicenseDialog = false })
    }

    // 更新对话框
    if (showUpdateDialog) {
        UpdateDialog(
            updateStatus = updateStatus,
            appVersion = appVersion,
            onDismiss = { showUpdateDialog = false },
            onConfirm = {
                if (updateStatus is UpdateStatus.Available) {
                    handleDownload()
                } else if (updateStatus !is UpdateStatus.Checking) {
                    showUpdateDialog = false
                }
            }
        )
    }

    // 下载源选择对话框
    if (showDownloadSourceMenu) {
        DownloadSourceDialog(
            updateStatus = updateStatus,
            onDismiss = { showDownloadSourceMenu = false },
            onDownload = { downloadFromUrl(it) }
        )
    }

    val backgroundBrush = androidx.compose.ui.graphics.Brush.verticalGradient(
        colors = listOf(
            MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.35f),
            MaterialTheme.colorScheme.surface
        )
    )

    CustomScaffold() { innerPadding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(backgroundBrush)
                .padding(innerPadding)
        ) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(horizontal = 16.dp)
                    .verticalScroll(rememberScrollState()),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Spacer(modifier = Modifier.height(12.dp))

                Surface(
                    modifier = Modifier
                        .size(120.dp)
                        .then(
                            Modifier.border(
                                androidx.compose.foundation.BorderStroke(
                                    1.dp,
                                    MaterialTheme.colorScheme.outline.copy(alpha = 0.2f)
                                ),
                                CircleShape
                            )
                        ),
                    shape = CircleShape,
                    tonalElevation = 3.dp,
                    color = MaterialTheme.colorScheme.primaryContainer
                ) {
                    Box(contentAlignment = Alignment.Center) {
                        Image(
                            painter = painterResource(id = R.drawable.ic_launcher_foreground),
                            contentDescription = stringResource(R.string.app_logo_description),
                            modifier = Modifier.size(84.dp)
                        )
                    }
                }

                Spacer(modifier = Modifier.height(20.dp))

                Text(
                    text = stringResource(id = R.string.app_name),
                    style = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onSurface
                )

                Text(
                    text = stringResource(id = R.string.about_version, appVersion),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 4.dp, bottom = 20.dp)
                )

                Button(
                    onClick = { checkForUpdates() },
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(48.dp)
                        .alpha(buttonAlpha.value),
                    shape = RoundedCornerShape(24.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.primary,
                        contentColor = MaterialTheme.colorScheme.onPrimary
                    ),
                    elevation = ButtonDefaults.buttonElevation(defaultElevation = 1.dp, pressedElevation = 3.dp),
                    enabled = updateStatus !is UpdateStatus.Checking
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.Center,
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        if (updateStatus is UpdateStatus.Checking) {
                            CircularProgressIndicator(
                                strokeWidth = 2.dp,
                                modifier = Modifier.size(16.dp)
                            )
                            Spacer(modifier = Modifier.width(8.dp))
                        } else {
                            Icon(
                                imageVector = Icons.Default.Update,
                                contentDescription = null,
                                modifier = Modifier.size(20.dp)
                            )
                            Spacer(modifier = Modifier.width(8.dp))
                        }
                        Text(
                            text = if (updateStatus is UpdateStatus.Checking)
                                stringResource(id = R.string.checking_updates)
                            else stringResource(id = R.string.check_for_updates),
                            style = MaterialTheme.typography.labelLarge
                        )
                    }
                }

                Spacer(modifier = Modifier.height(16.dp))

                ElevatedCard(
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(16.dp),
                    elevation = CardDefaults.elevatedCardElevation(defaultElevation = 2.dp)
                ) {
                    Column(
                        modifier = Modifier.fillMaxWidth().padding(16.dp),
                        horizontalAlignment = Alignment.Start
                    ) {
                        Text(
                            text = stringResource(id = R.string.about_title),
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.SemiBold,
                            modifier = Modifier.padding(bottom = 12.dp)
                        )

                        Text(
                            text = stringResource(id = R.string.about_description),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(bottom = 20.dp)
                        )

                        // 使用InfoItem组件展示信息
                        InfoItem(
                            icon = Icons.Rounded.Info,
                            title = stringResource(id = R.string.developer),
                            content = {
                                HtmlText(
                                    html = stringResource(id = R.string.about_developer),
                                    style = MaterialTheme.typography.bodyMedium
                                )
                            }
                        )

                        HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp))

                        InfoItem(
                            icon = Icons.Rounded.Info,
                            title = stringResource(id = R.string.contact),
                            content = {
                                Text(
                                    text = stringResource(id = R.string.about_contact),
                                    style = MaterialTheme.typography.bodyMedium
                                )
                            }
                        )

                        HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp))

                        InfoItem(
                            icon = Icons.Rounded.Info,
                            title = stringResource(id = R.string.project_url),
                            content = {
                                HtmlText(
                                    html = stringResource(id = R.string.about_website),
                                    style = MaterialTheme.typography.bodyMedium
                                )
                            }
                        )

                        HorizontalDivider(modifier = Modifier.padding(vertical = 12.dp))

                        Text(
                            text = stringResource(id = R.string.about_copyright),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            textAlign = TextAlign.Center,
                            modifier = Modifier.fillMaxWidth()
                        )
                    }
                }

                Spacer(modifier = Modifier.height(16.dp))

                ElevatedCard(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable {
                            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(GITHUB_PROJECT_URL)).apply {
                                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            }
                            context.startActivity(intent)
                        },
                    shape = RoundedCornerShape(16.dp),
                    elevation = CardDefaults.elevatedCardElevation(defaultElevation = 2.dp)
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(16.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Icon(
                                imageVector = Icons.Default.Star,
                                contentDescription = stringResource(R.string.github_star_description),
                                tint = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                            Spacer(modifier = Modifier.width(16.dp))
                            Text(
                                text = stringResource(R.string.star_on_github),
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.Medium
                            )
                        }
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.ArrowForward,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }

                Spacer(modifier = Modifier.height(16.dp))

                ElevatedCard(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { navigateToUpdateHistory() },
                    shape = RoundedCornerShape(16.dp),
                    elevation = CardDefaults.elevatedCardElevation(defaultElevation = 2.dp)
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(16.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Icon(
                                imageVector = Icons.Default.History,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                            Spacer(modifier = Modifier.width(16.dp))
                            Text(
                                text = stringResource(R.string.update_log),
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.Medium
                            )
                        }
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.ArrowForward,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }

                Spacer(modifier = Modifier.height(16.dp))

                ElevatedCard(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { showLicenseDialog = true },
                    shape = RoundedCornerShape(16.dp),
                    elevation = CardDefaults.elevatedCardElevation(defaultElevation = 2.dp)
                ) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(16.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Icon(
                                imageVector = Icons.Default.Source,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                            Spacer(modifier = Modifier.width(16.dp))
                            Text(
                                text = stringResource(id = R.string.open_source_licenses),
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.Medium
                            )
                        }
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.ArrowForward,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }

                Spacer(modifier = Modifier.height(16.dp))
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun UpdateDialog(
    updateStatus: UpdateStatus,
    appVersion: String,
    onDismiss: () -> Unit,
    onConfirm: () -> Unit
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        icon = {
            val icon = when (updateStatus) {
                is UpdateStatus.Available -> Icons.Default.Update
                is UpdateStatus.Checking -> Icons.Default.Download
                is UpdateStatus.UpToDate -> Icons.Default.CheckCircle
                is UpdateStatus.Error -> Icons.Default.Error
                else -> Icons.Default.Update
            }
            Icon(icon, contentDescription = null)
        },
        title = {
            val titleText = when (updateStatus) {
                is UpdateStatus.Available -> stringResource(id = R.string.new_version_found)
                is UpdateStatus.Checking -> stringResource(id = R.string.checking_updates)
                is UpdateStatus.UpToDate -> stringResource(id = R.string.check_complete)
                is UpdateStatus.Error -> stringResource(id = R.string.check_failed)
                else -> stringResource(id = R.string.update_check)
            }
            Text(text = titleText)
        },
        text = {
            Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
                when (val status = updateStatus) {
                    is UpdateStatus.Available -> {
                        Text(
                            stringResource(id = R.string.new_version, appVersion, status.newVersion),
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.padding(bottom = 8.dp)
                        )
                        if (status.releaseNotes.isNotEmpty()) {
                            HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp))
                            Text(
                                stringResource(id = R.string.update_content),
                                style = MaterialTheme.typography.titleSmall,
                                fontWeight = FontWeight.Bold,
                                modifier = Modifier.padding(bottom = 4.dp)
                            )
                            Text(status.releaseNotes, style = MaterialTheme.typography.bodySmall)
                        }
                    }
                    is UpdateStatus.UpToDate -> {
                        Text(stringResource(id = R.string.already_latest_version, appVersion))
                    }
                    is UpdateStatus.Error -> {
                        Text(status.message)
                    }
                    else -> {
                        Box(contentAlignment = Alignment.Center, modifier = Modifier.fillMaxWidth().padding(16.dp)) {
                            CircularProgressIndicator()
                        }
                    }
                }
            }
        },
        confirmButton = {
            Button(
                onClick = onConfirm,
                enabled = updateStatus !is UpdateStatus.Checking
            ) {
                Text(
                    when (updateStatus) {
                        is UpdateStatus.Available -> stringResource(id = R.string.download)
                        else -> stringResource(id = R.string.ok)
                    }
                )
            }
        },
        dismissButton = {
            if (updateStatus !is UpdateStatus.Checking) {
                TextButton(onClick = onDismiss) { Text(stringResource(id = R.string.close)) }
            }
        }
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DownloadSourceDialog(
    updateStatus: UpdateStatus,
    onDismiss: () -> Unit,
    onDownload: (String) -> Unit
) {
    val status = updateStatus as? UpdateStatus.Available
    val mirroredUrls = remember(status) {
        status?.let { GithubReleaseUtil.getMirroredUrls(it.downloadUrl) } ?: emptyMap()
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(id = R.string.select_download_source)) },
        text = {
            Column {
                Text(
                    stringResource(id = R.string.select_download_source_desc),
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.padding(bottom = 8.dp)
                )
                LazyColumn {
                    items(mirroredUrls.toList()) { (name, url) ->
                        ListItem(
                            headlineContent = { Text(stringResource(id = R.string.mirror_download, name)) },
                            leadingContent = { Icon(Icons.Default.Storage, contentDescription = null) },
                            modifier = Modifier.clickable { onDownload(url) }
                        )
                    }
                    if (status != null) {
                        item {
                            ListItem(
                                headlineContent = { Text(stringResource(id = R.string.github_source)) },
                                supportingContent = { Text(stringResource(id = R.string.github_source_desc)) },
                                leadingContent = { Icon(Icons.Default.Language, contentDescription = null) },
                                modifier = Modifier.clickable { onDownload(status.downloadUrl) }
                            )
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(id = R.string.cancel))
            }
        }
    )
}

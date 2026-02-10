// ==UserScript==
// @name         酒馆Vertex文生图
// @namespace    http://tampermonkey.net/
// @version      1.9
// @license      GPL
// @description  支持酒馆(SillyTavern)和仙途(XianTu)独立前端的Vertex AI文生图脚本，支持多API Key轮询、反代模式、多反代URL负载均衡和并行生成
// @author       幽浮喵
// @grant        unsafeWindow
// @match        *://*/*
// @require      https://code.jquery.com/jquery-3.4.1.min.js
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @connect      aiplatform.googleapis.com
// @connect      *
// ==/UserScript==

(function() {
    'use strict';

    // ==================== 配置部分 ====================

    // 默认设置
    const defaultSettings = {
        scriptEnabled: true,
        // === 模式切换 ===
        // 'apikey' = 直接使用API Key调用Google API
        // 'proxy' = 使用反代服务（如HF Spaces部署的无头代理）
        // 'antigravity' = 使用反重力反代服务
        requestMode: 'apikey',
        // 反代URL（requestMode为proxy时使用，支持逗号分隔多个URL进行轮询负载均衡）
        proxyUrl: '',
        // 反代URL轮询策略: 'round-robin' = 轮询, 'random' = 随机
        proxyLoadBalanceMode: 'round-robin',
        // 反代并行生成数（0=自动根据反代URL数量，>0=固定并发数）
        proxyConcurrency: 0,
        // 反代API Key（用于反代服务认证，需要sk-开头）
        proxyApiKey: '',
        // === 反重力反代设置 ===
        antigravityUrl: '',
        antigravityApiKey: '',
        // API Keys（逗号分隔多个Key，requestMode为apikey时使用）
        apiKeys: '',
        // 提示词标记
        startTag: 'image:{',
        endTag: '}',
        // 图片配置
        aspectRatio: '1:1',
        imageSize: '1K',
        mimeType: 'image/png',
        model: 'gemini-3-pro-image-preview',
        // 固定正向提示词（添加到每个提示词前面）
        fixedPrompt: '',
        // 固定负向提示词（暂存，Vertex不支持但保留字段）
        negativePrompt: '',
        // 缓存天数（0=不缓存）
        cacheDays: 7,
        // 请求超时（毫秒）
        timeout: 300000,
        // 是否隐藏按钮（生成后）
        hideButtonAfterGenerate: true,
        // 是否显示原始提示词（不替换，在提示词后追加按钮）
        showOriginalPrompt: false,
        // 流式过程中预生成图片（尽早发起请求，降低等待时间）
        preGenerateDuringStreaming: true,
        // 网络层抓取 SSE 流式内容（更稳定，避免 DOM 被框架重绘导致监听不到）
        streamFetchHookEnabled: true,
        // 从流式响应中的 JSON "text" 字段自动生成插图（无需 image:{...} 标签）
        autoGenerateFromStreamText: true,
        // 自动插图触发阈值（字符数，越小越早但提示词越不稳定）
        autoGenerateFromStreamTextMinChars: 120,
        // 自动插图最大使用长度（字符数，过长会影响生成质量/成本）
        autoGenerateFromStreamTextMaxChars: 380,
        // 是否显示“流式插图”悬浮预览窗口（避免被 Vue 重绘删掉）
        showStreamAutoWidget: true,
        // 流式完成后自动生成图片
        autoGenerateOnComplete: false,
        // === ZImage 模式设置 ===
        zimageEnabled: false,
        zimageUrl: 'http://127.0.0.1:8188',
        zimageUnetName: 'zit.safetensors',
        zimageClipName: 'qwen_3_4b.safetensors',
        zimageVaeName: 'ae.safetensors',
        zimageLora1Name: 'Mystic-XXX-ZIT-V5.safetensors',
        zimageLora1Strength: 0.6,
        zimageLora2Name: 'None',
        zimageLora2Strength: 0.5,
        zimageLora3Name: 'None',
        zimageLora3Strength: 0.5,
        zimageLora4Name: 'None',
        zimageLora4Strength: 0.39,
        zimageSampler: 'er_sde',
        zimageScheduler: 'sgm_uniform',
        zimageCfg: 1,
        zimageSteps: 10,
        zimageWidth: 720,
        zimageHeight: 1280,
        zimageBatchSize: 1,
        // === ZImage-Base 模式设置 ===
        zimageBaseEnabled: false,
        zimageBaseUrl: 'http://127.0.0.1:8188',
        zimageBaseUnetName: 'z_image_base_fp8.safetensors',
        zimageBaseClipName: 'qwen_3_4b.safetensors',
        zimageBaseVaeName: 'ae.safetensors',
        zimageBaseNegativePrompt: '泛黄，发绿，模糊，低分辨率，低质量图像，扭曲的肢体，诡异的外观，丑陋，AI感，噪点，网格感，JPEG压缩条纹，异常的肢体，水印，乱码，意义不明的字符',
        zimageBaseShift: 3,
        zimageBaseSampler: 'er_sde',
        zimageBaseScheduler: 'sgm_uniform',
        zimageBaseCfg: 4,
        zimageBaseSteps: 30,
        zimageBaseWidth: 800,
        zimageBaseHeight: 1200,
        zimageBaseBatchSize: 1,
        // === Anima ???? ===
        animaEnabled: false,
        animaUrl: 'http://127.0.0.1:8188',
        animaUnetName: 'anima.safetensors',
        animaClipName: 'qwen_3_06b_base.safetensors',
        animaVaeName: 'qwen_image_vae.safetensors',
        animaPromptPrefix: 'You are an assistant designed to generate anime images based on textual prompts. <Prompt Start>\n',
        animaNegativePrompt: 'worst quality, low quality, score_1, score_2, score_3, blurry, jpeg artifacts',
        animaShift: 3,
        animaSampler: 'er_sde',
        animaScheduler: 'simple',
        animaCfg: 4,
        animaSteps: 20,
        animaWidth: 896,
        animaHeight: 1152,
        animaBatchSize: 1
    };

    // 加载设置
    let settings = {};
    function loadSettings() {
        for (const [key, defaultValue] of Object.entries(defaultSettings)) {
            settings[key] = GM_getValue(key, defaultValue);
        }
    }
    loadSettings();

    // 解析API Keys
    function getApiKeys() {
        if (!settings.apiKeys) return [];
        return settings.apiKeys.split(',').map(k => k.trim()).filter(k => k);
    }

    // API Key轮询索引
    let currentKeyIndex = 0;
    function getNextApiKey() {
        const keys = getApiKeys();
        if (keys.length === 0) return null;
        const key = keys[currentKeyIndex % keys.length];
        currentKeyIndex++;
        return key;
    }

    // 解析反代URLs（支持逗号分隔多个）
    function getProxyUrls() {
        if (!settings.proxyUrl) return [];
        return settings.proxyUrl.split(',').map(u => u.trim().replace(/\/+$/, '')).filter(u => u);
    }

    // 反代URL轮询索引
    let currentProxyIndex = 0;
    function getNextProxyUrl() {
        const urls = getProxyUrls();
        if (urls.length === 0) return null;

        let url;
        if (settings.proxyLoadBalanceMode === 'random') {
            // 随机选择
            url = urls[Math.floor(Math.random() * urls.length)];
        } else {
            // 轮询模式（默认）
            url = urls[currentProxyIndex % urls.length];
            currentProxyIndex++;
        }
        return url;
    }

    // ==================== IndexedDB 缓存 ====================

    let db = null;
    const DB_NAME = 'VertexImageCache';
    const STORE_NAME = 'images';
    const REF_STORE_NAME = 'refImages'; // 参考图存储

    function openDatabase() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, 2); // 升级版本号以添加新 store
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                db = request.result;
                resolve(db);
            };
            request.onupgradeneeded = (event) => {
                const database = event.target.result;
                if (!database.objectStoreNames.contains(STORE_NAME)) {
                    database.createObjectStore(STORE_NAME, { keyPath: 'id' });
                }
                // 创建参考图存储
                if (!database.objectStoreNames.contains(REF_STORE_NAME)) {
                    database.createObjectStore(REF_STORE_NAME, { keyPath: 'name' });
                }
            };
        });
    }

    // 通过 ZImage-Base (ComfyUI) 生成图片 - 支持负面提示词
    async function generateImageViaZImageBase(prompt, button) {
        const url = settings.zimageBaseUrl.replace(/\/+$/, '');

        if (!url) {
            alert('请先配置 ComfyUI URL！点击右下角🎨按钮打开设置 -> ZImage-Base 分页');
            return null;
        }

        // 添加固定提示词
        const fullPrompt = settings.fixedPrompt
            ? `${settings.fixedPrompt}, ${prompt}`
            : prompt;

        // 构建工作流
        let workflow = JSON.parse(JSON.stringify(zimageBaseWorkflow));

        // 替换参数
        const seed = Math.floor(Math.random() * 1000000000000000);

        // 遍历工作流替换占位符
        const workflowStr = JSON.stringify(workflow)
            .replace(/%prompt%/g, fullPrompt.replace(/"/g, '\\"'))
            .replace(/%negative_prompt%/g, (settings.zimageBaseNegativePrompt || '').replace(/"/g, '\\"'))
            .replace(/%unet_name%/g, settings.zimageBaseUnetName)
            .replace(/%clip_name%/g, settings.zimageBaseClipName)
            .replace(/%vae_name%/g, settings.zimageBaseVaeName)
            .replace(/%seed%/g, seed)
            .replace(/%steps%/g, settings.zimageBaseSteps)
            .replace(/%cfg%/g, settings.zimageBaseCfg)
            .replace(/%sampler%/g, settings.zimageBaseSampler)
            .replace(/%scheduler%/g, settings.zimageBaseScheduler)
            .replace(/%width%/g, settings.zimageBaseWidth)
            .replace(/%height%/g, settings.zimageBaseHeight)
            .replace(/%batch_size%/g, settings.zimageBaseBatchSize)
            .replace(/%shift%/g, settings.zimageBaseShift);

        workflow = JSON.parse(workflowStr);

        const payload = { prompt: workflow };

        console.log(`[ZImage-Base] 发送请求到 ${url}/prompt`);
        console.log(`[ZImage-Base] 正向提示词: ${fullPrompt.substring(0, 50)}...`);
        console.log(`[ZImage-Base] 负向提示词: ${(settings.zimageBaseNegativePrompt || '').substring(0, 50)}...`);

        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: `${url}/prompt`,
                data: JSON.stringify(payload),
                headers: {
                    'Content-Type': 'application/json'
                },
                timeout: settings.timeout,
                onload: async function(response) {
                    try {
                        if (response.status !== 200) {
                            console.error(`[ZImage-Base] 请求失败:`, response.responseText);
                            reject(new Error(`HTTP ${response.status}: ${response.responseText}`));
                            return;
                        }

                        const data = JSON.parse(response.responseText);
                        const promptId = data.prompt_id;

                        console.log(`[ZImage-Base] 任务已提交, prompt_id: ${promptId}`);

                        // 轮询等待结果
                        const maxRetries = 120;
                        let retries = 0;

                        const pollResult = async () => {
                            try {
                                const historyResp = await new Promise((res, rej) => {
                                    GM_xmlhttpRequest({
                                        method: 'GET',
                                        url: `${url}/history/${promptId}`,
                                        timeout: 10000,
                                        onload: res,
                                        onerror: rej
                                    });
                                });

                                const history = JSON.parse(historyResp.responseText);

                                if (history[promptId] && history[promptId].outputs) {
                                    const outputs = history[promptId].outputs;
                                    let imageInfo = null;

                                    for (const nodeId of Object.keys(outputs)) {
                                        if (outputs[nodeId].images && outputs[nodeId].images.length > 0) {
                                            imageInfo = outputs[nodeId].images[0];
                                            break;
                                        }
                                    }

                                    if (imageInfo) {
                                        const imageUrl = `${url}/view?filename=${encodeURIComponent(imageInfo.filename)}&subfolder=${encodeURIComponent(imageInfo.subfolder || '')}&type=${encodeURIComponent(imageInfo.type || 'output')}`;

                                        const imageResp = await new Promise((res, rej) => {
                                            GM_xmlhttpRequest({
                                                method: 'GET',
                                                url: imageUrl,
                                                responseType: 'blob',
                                                onload: res,
                                                onerror: rej
                                            });
                                        });

                                        const reader = new FileReader();
                                        const dataUrl = await new Promise((res) => {
                                            reader.onload = () => res(reader.result);
                                            reader.readAsDataURL(imageResp.response);
                                        });

                                        console.log(`[ZImage-Base] 图片生成成功!`);
                                        resolve(dataUrl);
                                        return;
                                    }
                                }

                                retries++;
                                if (retries >= maxRetries) {
                                    reject(new Error('生成超时，请检查 ComfyUI'));
                                    return;
                                }

                                if (button) {
                                    button.textContent = `生成中...(${retries}s)`;
                                }

                                setTimeout(pollResult, 3000);
                            } catch (e) {
                                retries++;
                                if (retries >= maxRetries) {
                                    reject(e);
                                    return;
                                }
                                setTimeout(pollResult, 3000);
                            }
                        };

                        pollResult();

                    } catch (e) {
                        console.error(`[ZImage-Base] 解析响应失败:`, e);
                        reject(e);
                    }
                },
                onerror: function(error) {
                    console.error(`[ZImage-Base] 请求失败:`, error);
                    reject(new Error('网络请求失败'));
                },
                ontimeout: function() {
                    console.error(`[ZImage-Base] 请求超时`);
                    reject(new Error('请求超时'));
                }
            });
        });
    }

    // ==================== 参考图管理 ====================

    // 获取所有参考图
    async function getAllRefImages() {
        if (!db) return [];
        return new Promise((resolve) => {
            try {
                const transaction = db.transaction([REF_STORE_NAME], 'readonly');
                const store = transaction.objectStore(REF_STORE_NAME);
                const request = store.getAll();
                request.onsuccess = () => resolve(request.result || []);
                request.onerror = () => resolve([]);
            } catch (e) {
                resolve([]);
            }
        });
    }

    // 获取指定参考图
    async function getRefImage(name) {
        if (!db || !name) return null;
        return new Promise((resolve) => {
            try {
                const transaction = db.transaction([REF_STORE_NAME], 'readonly');
                const store = transaction.objectStore(REF_STORE_NAME);
                const request = store.get(name);
                request.onsuccess = () => resolve(request.result || null);
                request.onerror = () => resolve(null);
            } catch (e) {
                resolve(null);
            }
        });
    }

    // 保存参考图
    async function saveRefImage(name, imageData, mimeType) {
        if (!db || !name || !imageData) return false;
        return new Promise((resolve) => {
            try {
                const transaction = db.transaction([REF_STORE_NAME], 'readwrite');
                const store = transaction.objectStore(REF_STORE_NAME);
                const request = store.put({
                    name: name,
                    imageData: imageData,
                    mimeType: mimeType || 'image/png',
                    timestamp: Date.now()
                });
                request.onsuccess = () => resolve(true);
                request.onerror = () => resolve(false);
            } catch (e) {
                resolve(false);
            }
        });
    }

    // 删除参考图
    async function deleteRefImage(name) {
        if (!db || !name) return false;
        return new Promise((resolve) => {
            try {
                const transaction = db.transaction([REF_STORE_NAME], 'readwrite');
                const store = transaction.objectStore(REF_STORE_NAME);
                const request = store.delete(name);
                request.onsuccess = () => resolve(true);
                request.onerror = () => resolve(false);
            } catch (e) {
                resolve(false);
            }
        });
    }

    async function getCachedImage(promptHash) {
        if (!db || settings.cacheDays <= 0) return null;

        return new Promise((resolve) => {
            try {
                const transaction = db.transaction([STORE_NAME], 'readonly');
                const store = transaction.objectStore(STORE_NAME);
                const request = store.get(promptHash);

                request.onsuccess = () => {
                    const result = request.result;
                    if (result) {
                        // 检查是否过期
                        const now = Date.now();
                        const expireTime = settings.cacheDays * 24 * 60 * 60 * 1000;
                        if (now - result.timestamp < expireTime) {
                            resolve(result.imageData);
                            return;
                        }
                    }
                    resolve(null);
                };
                request.onerror = () => resolve(null);
            } catch (e) {
                resolve(null);
            }
        });
    }

    async function setCachedImage(promptHash, imageData) {
        if (!db || settings.cacheDays <= 0) return;

        return new Promise((resolve) => {
            try {
                const transaction = db.transaction([STORE_NAME], 'readwrite');
                const store = transaction.objectStore(STORE_NAME);
                store.put({
                    id: promptHash,
                    imageData: imageData,
                    timestamp: Date.now()
                });
                transaction.oncomplete = () => resolve();
                transaction.onerror = () => resolve();
            } catch (e) {
                resolve();
            }
        });
    }

    // 简单哈希函数
    function hashPrompt(prompt) {
        let hash = 0;
        for (let i = 0; i < prompt.length; i++) {
            const char = prompt.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return 'img_' + Math.abs(hash).toString(36);
    }

    // ==================== Vertex AI API 调用 ====================

    // 通过反代服务生成图片（OpenAI兼容格式，支持多URL负载均衡，支持参考图）
    async function generateImageViaProxy(prompt, button, refImageData = null) {
        const proxyUrl = getNextProxyUrl();

        if (!proxyUrl) {
            alert('请先配置反代服务URL！点击右下角🎨按钮打开设置');
            return null;
        }

        const proxyApiKey = settings.proxyApiKey || '';
        if (!proxyApiKey) {
            alert('请先配置反代API Key！点击右下角🎨按钮打开设置');
            return null;
        }

        const fullPrompt = settings.fixedPrompt
            ? `${settings.fixedPrompt}, ${prompt}`
            : prompt;

        // 根据图片尺寸调整模型名
        let modelName = settings.model;
        if (settings.imageSize === '2K') {
            modelName = modelName + '-2k';
        } else if (settings.imageSize === '4K') {
            modelName = modelName + '-4k';
        } else {
            modelName = modelName + '-1k';
        }

        const url = `${proxyUrl}/v1/chat/completions`;

        // 构建消息内容（支持多模态）
        let messageContent;
        if (refImageData) {
            // 图生图模式：使用 OpenAI 多模态格式
            let imageUrl = refImageData.imageData;
            // 确保是完整的 data URL
            if (!imageUrl.startsWith('data:')) {
                imageUrl = `data:${refImageData.mimeType || 'image/png'};base64,${imageUrl}`;
            }
            messageContent = [
                {
                    type: 'image_url',
                    image_url: { url: imageUrl }
                },
                {
                    type: 'text',
                    text: `Based on the reference image above, generate a new image: ${fullPrompt}`
                }
            ];
            console.log(`[Vertex] 反代图生图模式，参考图: ${refImageData.name || 'unknown'}`);
        } else {
            // 普通文生图
            messageContent = fullPrompt;
        }

        const payload = {
            model: modelName,
            messages: [{
                role: 'user',
                content: messageContent
            }],
            stream: false,
            // 传递宽高比参数给反代服务
            aspect_ratio: settings.aspectRatio
        };

        // 显示当前使用的反代URL（便于调试负载均衡）
        const proxyUrls = getProxyUrls();
        const proxyIndex = proxyUrls.indexOf(proxyUrl) + 1;
        const proxyCount = proxyUrls.length;
        console.log(`[Vertex] 反代模式请求: ${proxyUrl} (${proxyIndex}/${proxyCount})`);
        console.log(`[Vertex] 模型: ${modelName}, 提示词: ${fullPrompt.substring(0, 50)}...`);

        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: url,
                data: JSON.stringify(payload),
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${proxyApiKey}`
                },
                timeout: settings.timeout,
                onload: function(response) {
                    try {
                        const data = JSON.parse(response.responseText);

                        if (response.status !== 200) {
                            console.error(`[Vertex] 反代错误:`, data);
                            reject(new Error(data.error?.message || `HTTP ${response.status}`));
                            return;
                        }

                        // 兼容多种响应格式
                        let imageUrl = null;

                        // 格式1: 服务端图像直接返回 {"resultUrl": "data:image/..."}
                        if (data.resultUrl) {
                            console.log(`[Vertex] 反代模式生成成功 (resultUrl格式)`);
                            imageUrl = data.resultUrl;
                        }
                        // 格式2: OpenAI标准格式 {"choices": [{"message": {"content": "..."}}]}
                        else if (data.choices?.[0]?.message?.content) {
                            const content = data.choices[0].message.content;

                            // 查找base64图片数据
                            // 反代返回的格式可能是: ![image](data:image/png;base64,xxxx) 或直接是base64
                            const base64Match = content.match(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/);
                            if (base64Match) {
                                console.log(`[Vertex] 反代模式生成成功 (OpenAI格式)`);
                                imageUrl = base64Match[0];
                            } else {
                                // 尝试其他格式 - 可能是markdown图片
                                const mdMatch = content.match(/!\[.*?\]\((data:image\/[^)]+)\)/);
                                if (mdMatch) {
                                    console.log(`[Vertex] 反代模式生成成功 (markdown格式)`);
                                    imageUrl = mdMatch[1];
                                } else if (content.startsWith('data:image/')) {
                                    // 如果内容本身就是base64
                                    console.log(`[Vertex] 反代模式生成成功 (直接base64)`);
                                    imageUrl = content;
                                }
                            }
                        }
                        // 格式3: SD API格式 {"data": [{"b64_json": "..."}]}
                        else if (data.data?.[0]?.b64_json) {
                            console.log(`[Vertex] 反代模式生成成功 (SD API格式)`);
                            imageUrl = `data:image/png;base64,${data.data[0].b64_json}`;
                        }

                        if (imageUrl) {
                            resolve(imageUrl);
                            return;
                        }

                        console.warn(`[Vertex] 反代返回内容无图片:`, JSON.stringify(data).substring(0, 200));
                        reject(new Error('反代返回内容中未找到图片'));

                    } catch (e) {
                        console.error(`[Vertex] 解析反代响应失败:`, e);
                        reject(e);
                    }
                },
                onerror: function(error) {
                    console.error(`[Vertex] 反代请求失败:`, error);
                    reject(new Error('反代网络请求失败'));
                },
                ontimeout: function() {
                    console.error(`[Vertex] 反代请求超时`);
                    reject(new Error('反代请求超时'));
                }
            });
        });
    }

    // 通过反重力反代服务生成图片（支持参考图）
    async function generateImageViaAntigravity(prompt, button, refImageData = null) {
        const antigravityUrl = settings.antigravityUrl?.trim().replace(/\/+$/, '');

        if (!antigravityUrl) {
            alert('请先配置反重力反代URL！点击右下角🎨按钮打开设置');
            return null;
        }

        const antigravityApiKey = settings.antigravityApiKey || '';
        if (!antigravityApiKey) {
            alert('请先配置反重力反代API Key！点击右下角🎨按钮打开设置');
            return null;
        }

        const fullPrompt = settings.fixedPrompt
            ? `${settings.fixedPrompt}, ${prompt}`
            : prompt;

        // 反重力反代的模型名格式：gemini-3-pro-image / gemini-3-pro-image-2K / gemini-3-pro-image-4K
        let modelName = 'gemini-3-pro-image';
        if (settings.imageSize === '2K') {
            modelName = 'gemini-3-pro-image-2K';
        } else if (settings.imageSize === '4K') {
            modelName = 'gemini-3-pro-image-4K';
        }

        const url = `${antigravityUrl}/v1/chat/completions`;

        // 构建消息内容（支持多模态）
        let messageContent;
        if (refImageData) {
            // 图生图模式：使用 OpenAI 多模态格式
            let imageUrl = refImageData.imageData;
            if (!imageUrl.startsWith('data:')) {
                imageUrl = `data:${refImageData.mimeType || 'image/png'};base64,${imageUrl}`;
            }
            messageContent = [
                {
                    type: 'image_url',
                    image_url: { url: imageUrl }
                },
                {
                    type: 'text',
                    text: `Based on the reference image above, generate a new image: ${fullPrompt}`
                }
            ];
            console.log(`[Vertex] 反重力图生图模式，参考图: ${refImageData.name || 'unknown'}`);
        } else {
            messageContent = fullPrompt;
        }

        const payload = {
            model: modelName,
            messages: [{
                role: 'user',
                content: messageContent
            }],
            stream: false
        };

        console.log(`[Vertex] 反重力反代请求: ${antigravityUrl}`);
        console.log(`[Vertex] 模型: ${modelName}, 提示词: ${fullPrompt.substring(0, 50)}...`);

        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: url,
                data: JSON.stringify(payload),
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${antigravityApiKey}`
                },
                timeout: settings.timeout,
                onload: function(response) {
                    try {
                        const data = JSON.parse(response.responseText);

                        if (response.status !== 200) {
                            console.error(`[Vertex] 反重力反代错误:`, data);
                            reject(new Error(data.error?.message || `HTTP ${response.status}`));
                            return;
                        }

                        // 反重力反代返回的图片格式：
                        // 1. Markdown 格式 ![image](http://xxx/images/xxx.jpg)
                        // 2. 或 base64 格式 data:image/png;base64,xxx
                        let imageUrl = null;
                        const content = data.choices?.[0]?.message?.content;

                        if (content) {
                            // 优先查找 http/https URL 格式（反重力反代返回的是文件URL）
                            const httpMatch = content.match(/!\[.*?\]\((https?:\/\/[^)]+)\)/);
                            if (httpMatch) {
                                console.log(`[Vertex] 反重力反代生成成功 (HTTP URL格式)`);
                                imageUrl = httpMatch[1];
                            } else {
                                // 查找 base64 图片数据
                                const base64Match = content.match(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/);
                                if (base64Match) {
                                    console.log(`[Vertex] 反重力反代生成成功 (Base64格式)`);
                                    imageUrl = base64Match[0];
                                } else {
                                    // 尝试 markdown base64 图片格式
                                    const mdMatch = content.match(/!\[.*?\]\((data:image\/[^)]+)\)/);
                                    if (mdMatch) {
                                        console.log(`[Vertex] 反重力反代生成成功 (Markdown Base64格式)`);
                                        imageUrl = mdMatch[1];
                                    }
                                }
                            }
                        }

                        if (!imageUrl) {
                            console.warn(`[Vertex] 反重力反代未返回图片，响应内容:`, content);
                            reject(new Error('未生成图片，请检查模型和提示词'));
                            return;
                        }

                        resolve(imageUrl);

                    } catch (e) {
                        console.error(`[Vertex] 反重力反代解析响应失败:`, e);
                        reject(e);
                    }
                },
                onerror: function(error) {
                    console.error(`[Vertex] 反重力反代请求失败:`, error);
                    reject(new Error('反重力反代网络请求失败'));
                },
                ontimeout: function() {
                    console.error(`[Vertex] 反重力反代请求超时`);
                    reject(new Error('反重力反代请求超时'));
                }
            });
        });
    }

    // 通过API Key直接调用生成图片（支持参考图）
    async function generateImageViaApiKey(prompt, button, refImageData = null) {
        const apiKey = getNextApiKey();
        if (!apiKey) {
            alert('请先配置API Key！点击左下角三条杠 -> Vertex文生图设置');
            return null;
        }

        const fullPrompt = settings.fixedPrompt
            ? `${settings.fixedPrompt}, ${prompt}`
            : prompt;

        const url = `https://aiplatform.googleapis.com/v1/publishers/google/models/${settings.model}:generateContent?key=${apiKey}`;

        // 构建 parts 数组（支持多模态）
        const parts = [];

        // 如果有参考图，先添加参考图
        if (refImageData) {
            // 提取 base64 数据（移除 data:xxx;base64, 前缀）
            let base64Data = refImageData.imageData;
            let mimeType = refImageData.mimeType || 'image/png';
            if (base64Data.startsWith('data:')) {
                const matches = base64Data.match(/^data:([^;]+);base64,(.+)$/);
                if (matches) {
                    mimeType = matches[1];
                    base64Data = matches[2];
                }
            }
            parts.push({
                inlineData: {
                    mimeType: mimeType,
                    data: base64Data
                }
            });
            // 添加图生图的指令
            parts.push({ text: `Based on the reference image above, generate a new image: ${fullPrompt}` });
            console.log(`[Vertex] 图生图模式，参考图: ${refImageData.name || 'unknown'}`);
        } else {
            // 普通文生图
            parts.push({ text: fullPrompt });
        }

        const payload = {
            contents: [{
                role: 'user',
                parts: parts
            }],
            generationConfig: {
                temperature: 1,
                topP: 0.95,
                maxOutputTokens: 8192,
                responseModalities: ['TEXT', 'IMAGE'],
                imageConfig: {
                    aspectRatio: settings.aspectRatio,
                    imageSize: settings.imageSize,
                    imageOutputOptions: { mimeType: settings.mimeType },
                    personGeneration: 'ALLOW_ALL'
                }
            },
            safetySettings: [
                { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
                { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
                { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
                { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
                { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'OFF' }
            ]
        };

        const keyIndex = getApiKeys().indexOf(apiKey) + 1;
        console.log(`[Vertex] Key${keyIndex} 请求: ${fullPrompt.substring(0, 50)}...`);

        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: url,
                data: JSON.stringify(payload),
                headers: {
                    'Content-Type': 'application/json'
                },
                timeout: settings.timeout,
                onload: function(response) {
                    try {
                        const data = JSON.parse(response.responseText);

                        if (response.status === 429) {
                            console.warn(`[Vertex] Key${keyIndex} 配额超限`);
                            reject(new Error('API配额超限，请稍后重试'));
                            return;
                        }

                        if (response.status !== 200) {
                            console.error(`[Vertex] API错误:`, data);
                            reject(new Error(data.error?.message || `HTTP ${response.status}`));
                            return;
                        }

                        const parts = data.candidates?.[0]?.content?.parts || [];
                        const imageParts = parts.filter(p => p.inlineData);

                        if (imageParts.length === 0) {
                            console.warn(`[Vertex] 未生成图片（可能触发审核）`);
                            reject(new Error('未生成图片，可能触发了内容审核'));
                            return;
                        }

                        const imageData = imageParts[0].inlineData;
                        const imageUrl = `data:${imageData.mimeType};base64,${imageData.data}`;

                        console.log(`[Vertex] Key${keyIndex} 生成成功`);
                        resolve(imageUrl);

                    } catch (e) {
                        console.error(`[Vertex] 解析响应失败:`, e);
                        reject(e);
                    }
                },
                onerror: function(error) {
                    console.error(`[Vertex] 请求失败:`, error);
                    reject(new Error('网络请求失败'));
                },
                ontimeout: function() {
                    console.error(`[Vertex] 请求超时`);
                    reject(new Error('请求超时'));
                }
            });
        });
    }

    // ZImage 工作流模板 - 显式连接版本
    const zimageWorkflow = {
        "6": {
            "inputs": {
                "text": "%prompt%",
                "clip": ["35", 1]
            },
            "class_type": "CLIPTextEncode",
            "_meta": {"title": "CLIP Text Encode (Positive Prompt)"}
        },
        "8": {
            "inputs": {
                "samples": ["57", 0],
                "vae": ["17", 0]
            },
            "class_type": "VAEDecode",
            "_meta": {"title": "VAE解码"}
        },
        "16": {
            "inputs": {
                "unet_name": "%unet_name%",
                "weight_dtype": "fp8_e4m3fn_fast"
            },
            "class_type": "UNETLoader",
            "_meta": {"title": "UNet加载器"}
        },
        "17": {
            "inputs": {"vae_name": "%vae_name%"},
            "class_type": "VAELoader",
            "_meta": {"title": "加载VAE"}
        },
        "18": {
            "inputs": {
                "clip_name": "%clip_name%",
                "type": "lumina2",
                "device": "default"
            },
            "class_type": "CLIPLoader",
            "_meta": {"title": "加载CLIP"}
        },
        "35": {
            "inputs": {
                "lora_01": "%lora1_name%",
                "strength_01": "%lora1_strength%",
                "lora_02": "%lora2_name%",
                "strength_02": "%lora2_strength%",
                "lora_03": "%lora3_name%",
                "strength_03": "%lora3_strength%",
                "lora_04": "%lora4_name%",
                "strength_04": "%lora4_strength%",
                "model": ["16", 0],
                "clip": ["18", 0]
            },
            "class_type": "Lora Loader Stack (rgthree)",
            "_meta": {"title": "Lora Loader Stack (rgthree)"}
        },
        "37": {
            "inputs": {
                "width": "%width%",
                "height": "%height%",
                "batch_size": "%batch_size%"
            },
            "class_type": "EmptyLatentImage",
            "_meta": {"title": "空Latent图像"}
        },
        "57": {
            "inputs": {
                "seed": "%seed%",
                "steps": "%steps%",
                "cfg": "%cfg%",
                "sampler_name": "%sampler%",
                "scheduler": "%scheduler%",
                "denoise": 1,
                "model": ["35", 0],
                "positive": ["6", 0],
                "negative": ["59", 0],
                "latent_image": ["37", 0]
            },
            "class_type": "KSampler",
            "_meta": {"title": "K采样器"}
        },
        "59": {
            "inputs": {
                "conditioning": ["6", 0]
            },
            "class_type": "ConditioningZeroOut",
            "_meta": {"title": "条件零化"}
        },
        "71": {
            "inputs": {
                "filename_prefix": "ZImage",
                "images": ["8", 0]
            },
            "class_type": "SaveImage",
            "_meta": {"title": "保存图像"}
        }
    };

    // ZImage-Base 工作流模板 - 支持负面提示词
    const zimageBaseWorkflow = {
        "9": {
            "inputs": {
                "filename_prefix": "z-image-base",
                "images": ["65", 0]
            },
            "class_type": "SaveImage",
            "_meta": {"title": "保存图像"}
        },
        "62": {
            "inputs": {
                "clip_name": "%clip_name%",
                "type": "lumina2",
                "device": "default"
            },
            "class_type": "CLIPLoader",
            "_meta": {"title": "加载CLIP"}
        },
        "63": {
            "inputs": {
                "vae_name": "%vae_name%"
            },
            "class_type": "VAELoader",
            "_meta": {"title": "加载VAE"}
        },
        "65": {
            "inputs": {
                "samples": ["69", 0],
                "vae": ["63", 0]
            },
            "class_type": "VAEDecode",
            "_meta": {"title": "VAE解码"}
        },
        "66": {
            "inputs": {
                "unet_name": "%unet_name%",
                "weight_dtype": "fp8_e4m3fn"
            },
            "class_type": "UNETLoader",
            "_meta": {"title": "UNet加载器"}
        },
        "67": {
            "inputs": {
                "text": "%prompt%",
                "clip": ["62", 0]
            },
            "class_type": "CLIPTextEncode",
            "_meta": {"title": "CLIP Text Encode (Positive Prompt)"}
        },
        "68": {
            "inputs": {
                "width": "%width%",
                "height": "%height%",
                "batch_size": "%batch_size%"
            },
            "class_type": "EmptySD3LatentImage",
            "_meta": {"title": "空Latent图像（SD3）"}
        },
        "69": {
            "inputs": {
                "seed": "%seed%",
                "steps": "%steps%",
                "cfg": "%cfg%",
                "sampler_name": "%sampler%",
                "scheduler": "%scheduler%",
                "denoise": 1,
                "model": ["70", 0],
                "positive": ["67", 0],
                "negative": ["71", 0],
                "latent_image": ["68", 0]
            },
            "class_type": "KSampler",
            "_meta": {"title": "K采样器"}
        },
        "70": {
            "inputs": {
                "shift": "%shift%",
                "model": ["66", 0]
            },
            "class_type": "ModelSamplingAuraFlow",
            "_meta": {"title": "采样算法（AuraFlow）"}
        },
        "71": {
            "inputs": {
                "text": "%negative_prompt%",
                "clip": ["62", 0]
            },
            "class_type": "CLIPTextEncode",
            "_meta": {"title": "CLIP Text Encode (Negative Prompt)"}
        }
    };

    // 通过 ZImage (ComfyUI) 生成图片
    // Anima ?????
    const animaWorkflow = {
        "1": {
            "inputs": {
                "string_a": "You are an assistant designed to generate anime images based on textual prompts. <Prompt Start>\n",
                "string_b": "worst quality, low quality, score_1, score_2, score_3, blurry, jpeg artifacts",
                "delimiter": ""
            },
            "class_type": "StringConcatenate",
            "_meta": {"title": "Concatenate (Neg Prompt)"}
        },
        "3": {
            "inputs": {
                "text": ["1", 0],
                "clip": ["70", 0]
            },
            "class_type": "CLIPTextEncode",
            "_meta": {"title": "CLIP???? (Negative)"}
        },
        "4": {
            "inputs": {
                "text": ["7", 0],
                "clip": ["70", 0]
            },
            "class_type": "CLIPTextEncode",
            "_meta": {"title": "CLIP???? (Positive)"}
        },
        "7": {
            "inputs": {
                "string_a": "You are an assistant designed to generate anime images based on textual prompts. <Prompt Start>\n",
                "string_b": "masterpiece, best quality",
                "delimiter": ""
            },
            "class_type": "StringConcatenate",
            "_meta": {"title": "Concatenate (Pos Prompt)"}
        },
        "29": {
            "inputs": {"vae_name": "qwen_image_vae.safetensors"},
            "class_type": "VAELoader",
            "_meta": {"title": "??VAE (Qwen Image)"}
        },
        "57": {
            "inputs": {
                "shift": 3,
                "model": ["67", 0]
            },
            "class_type": "ModelSamplingAuraFlow",
            "_meta": {"title": "?????AuraFlow, Anima?"}
        },
        "63": {
            "inputs": {
                "seed": 345007242330753,
                "steps": ["65", 0],
                "cfg": ["76", 0],
                "sampler_name": "er_sde",
                "scheduler": "simple",
                "denoise": 1,
                "model": ["57", 0],
                "positive": ["4", 0],
                "negative": ["3", 0],
                "latent_image": ["75", 0]
            },
            "class_type": "KSampler",
            "_meta": {"title": "K??? (Anima)"}
        },
        "65": {
            "inputs": {"value": 20},
            "class_type": "PrimitiveInt",
            "_meta": {"title": "Steps"}
        },
        "66": {
            "inputs": {
                "samples": ["63", 0],
                "vae": ["29", 0]
            },
            "class_type": "VAEDecode",
            "_meta": {"title": "Anima"}
        },
        "67": {
            "inputs": {
                "unet_name": "anima.safetensors",
                "weight_dtype": "default"
            },
            "class_type": "UNETLoader",
            "_meta": {"title": "UNet??? (Anima)"}
        },
        "70": {
            "inputs": {
                "clip_name": "qwen_3_06b_base.safetensors",
                "type": "stable_diffusion",
                "device": "default"
            },
            "class_type": "CLIPLoader",
            "_meta": {"title": "??CLIP (Qwen 0.6B)"}
        },
        "75": {
            "inputs": {
                "width": 896,
                "height": 1152,
                "batch_size": 1
            },
            "class_type": "EmptyLatentImage",
            "_meta": {"title": "?Latent??"}
        },
        "76": {
            "inputs": {"value": 4},
            "class_type": "PrimitiveFloat",
            "_meta": {"title": "CFG"}
        },
        "80": {
            "inputs": {"images": ["66", 0]},
            "class_type": "PreviewImage",
            "_meta": {"title": "????"}
        }
    };

    async function generateImageViaZImage(prompt, button) {
        const url = settings.zimageUrl.replace(/\/+$/, '');

        if (!url) {
            alert('请先配置 ComfyUI URL！点击右下角🎨按钮打开设置 -> ZImage 分页');
            return null;
        }

        // 添加固定提示词
        const fullPrompt = settings.fixedPrompt
            ? `${settings.fixedPrompt}, ${prompt}`
            : prompt;

        // 构建工作流
        let workflow = JSON.parse(JSON.stringify(zimageWorkflow));

        // 替换参数
        const seed = Math.floor(Math.random() * 1000000000000000);

        workflow["6"].inputs.text = fullPrompt;
        workflow["16"].inputs.unet_name = settings.zimageUnetName;
        workflow["17"].inputs.vae_name = settings.zimageVaeName;
        workflow["18"].inputs.clip_name = settings.zimageClipName;
        workflow["35"].inputs.lora_01 = settings.zimageLora1Name;
        workflow["35"].inputs.strength_01 = settings.zimageLora1Strength;
        workflow["35"].inputs.lora_02 = settings.zimageLora2Name;
        workflow["35"].inputs.strength_02 = settings.zimageLora2Strength;
        workflow["35"].inputs.lora_03 = settings.zimageLora3Name;
        workflow["35"].inputs.strength_03 = settings.zimageLora3Strength;
        workflow["35"].inputs.lora_04 = settings.zimageLora4Name;
        workflow["35"].inputs.strength_04 = settings.zimageLora4Strength;
        workflow["37"].inputs.width = settings.zimageWidth;
        workflow["37"].inputs.height = settings.zimageHeight;
        workflow["37"].inputs.batch_size = settings.zimageBatchSize;
        workflow["57"].inputs.seed = seed;
        workflow["57"].inputs.steps = settings.zimageSteps;
        workflow["57"].inputs.cfg = settings.zimageCfg;
        workflow["57"].inputs.sampler_name = settings.zimageSampler;
        workflow["57"].inputs.scheduler = settings.zimageScheduler;

        const clientId = "vertex-zimage-" + Math.random().toString(36).substr(2, 9);

        const payload = {
            client_id: clientId,
            prompt: workflow
        };

        console.log(`[ZImage] 发送请求到 ${url}/prompt`);

        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: `${url}/prompt`,
                data: JSON.stringify(payload),
                headers: {
                    'Content-Type': 'application/json'
                },
                timeout: settings.timeout,
                onload: async function(response) {
                    try {
                        if (response.status !== 200) {
                            console.error(`[ZImage] 请求失败:`, response.responseText);
                            reject(new Error(`HTTP ${response.status}: ${response.responseText}`));
                            return;
                        }

                        const data = JSON.parse(response.responseText);
                        const promptId = data.prompt_id;

                        console.log(`[ZImage] 任务已提交, prompt_id: ${promptId}`);

                        // 轮询等待结果
                        const maxRetries = 120; // 最多等待 6 分钟
                        let retries = 0;

                        const pollResult = async () => {
                            try {
                                const historyResp = await new Promise((res, rej) => {
                                    GM_xmlhttpRequest({
                                        method: 'GET',
                                        url: `${url}/history/${promptId}`,
                                        timeout: 10000,
                                        onload: res,
                                        onerror: rej
                                    });
                                });

                                const history = JSON.parse(historyResp.responseText);

                                if (history[promptId] && history[promptId].outputs) {
                                    // 查找输出图片
                                    const outputs = history[promptId].outputs;
                                    let imageInfo = null;

                                    // 查找 SaveImage 节点的输出
                                    for (const nodeId of Object.keys(outputs)) {
                                        if (outputs[nodeId].images && outputs[nodeId].images.length > 0) {
                                            imageInfo = outputs[nodeId].images[0];
                                            break;
                                        }
                                    }

                                    if (imageInfo) {
                                        // 获取图片
                                        const imageUrl = `${url}/view?filename=${encodeURIComponent(imageInfo.filename)}&subfolder=${encodeURIComponent(imageInfo.subfolder || '')}&type=${encodeURIComponent(imageInfo.type || 'output')}`;

                                        const imageResp = await new Promise((res, rej) => {
                                            GM_xmlhttpRequest({
                                                method: 'GET',
                                                url: imageUrl,
                                                responseType: 'blob',
                                                onload: res,
                                                onerror: rej
                                            });
                                        });

                                        // 转换为 base64
                                        const reader = new FileReader();
                                        const dataUrl = await new Promise((res) => {
                                            reader.onload = () => res(reader.result);
                                            reader.readAsDataURL(imageResp.response);
                                        });

                                        console.log(`[ZImage] 图片生成成功!`);
                                        resolve(dataUrl);
                                        return;
                                    }
                                }

                                // 继续轮询
                                retries++;
                                if (retries >= maxRetries) {
                                    reject(new Error('生成超时，请检查 ComfyUI'));
                                    return;
                                }

                                if (button) {
                                    button.textContent = `生成中...(${retries}s)`;
                                }

                                setTimeout(pollResult, 3000);
                            } catch (e) {
                                retries++;
                                if (retries >= maxRetries) {
                                    reject(e);
                                    return;
                                }
                                setTimeout(pollResult, 3000);
                            }
                        };

                        pollResult();

                    } catch (e) {
                        console.error(`[ZImage] 解析响应失败:`, e);
                        reject(e);
                    }
                },
                onerror: function(error) {
                    console.error(`[ZImage] 请求失败:`, error);
                    reject(new Error('网络请求失败'));
                },
                ontimeout: function() {
                    console.error(`[ZImage] 请求超时`);
                    reject(new Error('请求超时'));
                }
            });
        });
    }

    // 统一入口：根据模式选择调用方式（支持参考图）
    // ?? Anima (ComfyUI) ????
    async function generateImageViaAnima(prompt, button) {
        const url = settings.animaUrl.replace(/\/+$/, '');

        if (!url) {
            alert('Please set ComfyUI URL first: Settings -> Anima tab');
            return null;
        }

        // Add fixed prompt prefix used by the global flow
        const fullPrompt = settings.fixedPrompt
            ? settings.fixedPrompt + ', ' + prompt
            : prompt;

        let workflow = JSON.parse(JSON.stringify(animaWorkflow));
        const seed = Math.floor(Math.random() * 1000000000000000);

        workflow['1'].inputs.string_a = settings.animaPromptPrefix || '';
        workflow['1'].inputs.string_b = settings.animaNegativePrompt || '';
        workflow['7'].inputs.string_a = settings.animaPromptPrefix || '';
        workflow['7'].inputs.string_b = fullPrompt;
        workflow['29'].inputs.vae_name = settings.animaVaeName;
        workflow['57'].inputs.shift = settings.animaShift;
        workflow['63'].inputs.seed = seed;
        workflow['63'].inputs.sampler_name = settings.animaSampler;
        workflow['63'].inputs.scheduler = settings.animaScheduler;
        workflow['65'].inputs.value = settings.animaSteps;
        workflow['67'].inputs.unet_name = settings.animaUnetName;
        workflow['70'].inputs.clip_name = settings.animaClipName;
        workflow['75'].inputs.width = settings.animaWidth;
        workflow['75'].inputs.height = settings.animaHeight;
        workflow['75'].inputs.batch_size = settings.animaBatchSize;
        workflow['76'].inputs.value = settings.animaCfg;

        const clientId = 'vertex-anima-' + Math.random().toString(36).substr(2, 9);
        const payload = {
            client_id: clientId,
            prompt: workflow
        };

        console.log('[Anima] POST ' + url + '/prompt');

        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: url + '/prompt',
                data: JSON.stringify(payload),
                headers: {
                    'Content-Type': 'application/json'
                },
                timeout: settings.timeout,
                onload: async function(response) {
                    try {
                        if (response.status !== 200) {
                            console.error('[Anima] Request failed:', response.responseText);
                            reject(new Error('HTTP ' + response.status + ': ' + response.responseText));
                            return;
                        }

                        const data = JSON.parse(response.responseText);
                        const promptId = data.prompt_id;
                        const maxRetries = 120;
                        let retries = 0;

                        const pollResult = async () => {
                            try {
                                const historyResp = await new Promise((res, rej) => {
                                    GM_xmlhttpRequest({
                                        method: 'GET',
                                        url: url + '/history/' + promptId,
                                        timeout: 10000,
                                        onload: res,
                                        onerror: rej
                                    });
                                });

                                const history = JSON.parse(historyResp.responseText);

                                if (history[promptId] && history[promptId].outputs) {
                                    const outputs = history[promptId].outputs;
                                    let imageInfo = null;

                                    for (const nodeId of Object.keys(outputs)) {
                                        if (outputs[nodeId].images && outputs[nodeId].images.length > 0) {
                                            imageInfo = outputs[nodeId].images[0];
                                            break;
                                        }
                                    }

                                    if (imageInfo) {
                                        const imageUrl = url + '/view?filename=' + encodeURIComponent(imageInfo.filename) + '&subfolder=' + encodeURIComponent(imageInfo.subfolder || '') + '&type=' + encodeURIComponent(imageInfo.type || 'output');

                                        const imageResp = await new Promise((res, rej) => {
                                            GM_xmlhttpRequest({
                                                method: 'GET',
                                                url: imageUrl,
                                                responseType: 'blob',
                                                onload: res,
                                                onerror: rej
                                            });
                                        });

                                        const reader = new FileReader();
                                        const dataUrl = await new Promise((res) => {
                                            reader.onload = () => res(reader.result);
                                            reader.readAsDataURL(imageResp.response);
                                        });

                                        resolve(dataUrl);
                                        return;
                                    }
                                }

                                retries++;
                                if (retries >= maxRetries) {
                                    reject(new Error('Generation timed out. Check ComfyUI status.'));
                                    return;
                                }

                                if (button) {
                                    button.textContent = 'Generating...(' + retries + 's)';
                                }

                                setTimeout(pollResult, 3000);
                            } catch (e) {
                                retries++;
                                if (retries >= maxRetries) {
                                    reject(e);
                                    return;
                                }
                                setTimeout(pollResult, 3000);
                            }
                        };

                        pollResult();
                    } catch (e) {
                        console.error('[Anima] Response parse failed:', e);
                        reject(e);
                    }
                },
                onerror: function(error) {
                    console.error('[Anima] Network error:', error);
                    reject(new Error('Network request failed'));
                },
                ontimeout: function() {
                    console.error('[Anima] Request timeout');
                    reject(new Error('Request timeout'));
                }
            });
        });
    }

    async function generateImage(prompt, button, refImageData = null) {
        // ????? Anima ??????? Anima
        if (settings.animaEnabled) {
            if (refImageData) {
                console.warn('[Vertex] Anima ???????????????');
            }
            return generateImageViaAnima(prompt, button);
        }
        // 如果启用了 ZImage-Base 模式，优先使用 ZImage-Base
        if (settings.zimageBaseEnabled) {
            if (refImageData) {
                console.warn('[Vertex] ZImage-Base 模式暂不支持图生图，忽略参考图');
            }
            return generateImageViaZImageBase(prompt, button);
        }
        // 如果启用了 ZImage 模式，优先使用 ZImage（ZImage 暂不支持图生图）
        if (settings.zimageEnabled) {
            if (refImageData) {
                console.warn('[Vertex] ZImage 模式暂不支持图生图，忽略参考图');
            }
            return generateImageViaZImage(prompt, button);
        }
        // 根据请求模式选择 API
        if (settings.requestMode === 'proxy') {
            return generateImageViaProxy(prompt, button, refImageData);
        } else if (settings.requestMode === 'antigravity') {
            return generateImageViaAntigravity(prompt, button, refImageData);
        } else {
            return generateImageViaApiKey(prompt, button, refImageData);
        }
    }

    // ==================== 酒馆集成 ====================

    // 转义正则特殊字符
    function escapeRegExp(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // 提取提示词
    function extractPrompt(text) {
        // 清理HTML标签
        text = text.replace(/<br\s*\/?>/gi, '\n');
        text = text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
        text = text.replace(/<\/?(span|div|p|a|b|i|u|em|strong|font|img|table|tr|td|th|ul|ol|li|h[1-6])[^>]*>/gi, '');
        return text.trim();
    }

    // 调试模式开关（设为 true 开启详细日志）
    const DEBUG = false;
    function debugLog(...args) {
        if (DEBUG) console.log('[Vertex调试]', ...args);
    }

    // 自动生成队列（存储待生成的按钮ID）
    const autoGenerateQueue = new Set();
    let isAutoGenerating = false;

    // ==================== 流式预生成系统 ====================
    // 在流式传输过程中检测 image 标签并提前生成图片

    // 预生成缓存 - 存储正在生成或已生成的图片 { promptHash: { status: 'pending'|'generating'|'done', imageUrl?: string } }
    const preGenerateCache = new Map();
    // 已处理的提示词哈希集合（避免重复处理）
    const processedStreamPrompts = new Set();
    // 流式文本缓冲区
    let streamBuffer = '';
    // 流式监听是否激活
    let streamObserverActive = false;
    // 自动插图：每次流式只触发一次（避免同一条消息反复发请求）
    let autoStreamGeneratedOnce = false;

    function resetStreamingDetectionState() {
        processedStreamPrompts.clear();
        streamBuffer = '';
        autoStreamGeneratedOnce = false;

        // 清理悬浮窗口（下次流式重新生成）
        const widget = document.getElementById('vertex-stream-auto-widget');
        if (widget) widget.remove();
    }

    // 找到字符串里第一个“未转义的双引号”位置（用于截断 JSON string）
    function indexOfUnescapedQuote(text) {
        for (let i = 0; i < text.length; i++) {
            if (text[i] !== '"') continue;
            // 统计前面连续反斜杠数量，偶数=未转义
            let slashCount = 0;
            for (let j = i - 1; j >= 0 && text[j] === '\\\\'; j--) slashCount++;
            if (slashCount % 2 === 0) return i;
        }
        return -1;
    }

    // 从 XianTu 的流式原文中尽早提取 JSON "text" 字段片段作为插图提示词（无需 image:{...}）
    function extractXiantuStreamTextPrompt(rawText) {
        if (!rawText) return null;

        const match = rawText.match(/\"text\"\\s*:\\s*\"/);
        if (!match || match.index == null) return null;

        const startIndex = match.index + match[0].length;
        let rest = rawText.slice(startIndex);

        // 如果已经出现字符串结束引号，截断到引号之前；否则使用当前已有片段
        const endQuoteAt = indexOfUnescapedQuote(rest);
        if (endQuoteAt !== -1) {
            rest = rest.slice(0, endQuoteAt);
        }

        // 为了避免过早 unescape 带来巨大开销，先粗略截断一段
        const maxRawLen = Math.max(200, (settings.autoGenerateFromStreamTextMaxChars || 380) * 4);
        rest = rest.slice(0, maxRawLen);

        // 反转义常见序列（流式阶段 JSON 可能未闭合，但这段处理不依赖闭合）
        let prompt = rest
            .replace(/\\\\n/g, '\n')
            .replace(/\\\\t/g, '\t')
            .replace(/\\\\r/g, '\r')
            .replace(/\\\\\"/g, '"')
            .replace(/\\\\\\\\/g, '\\\\');

        prompt = prompt.replace(/\\s+/g, ' ').trim();

        const maxLen = settings.autoGenerateFromStreamTextMaxChars || 380;
        if (prompt.length > maxLen) prompt = prompt.slice(0, maxLen);

        return prompt || null;
    }

    function ensureStreamAutoWidget(prompt, promptHash) {
        if (!settings.showStreamAutoWidget) return;

        const widgetId = 'vertex-stream-auto-widget';
        let widget = document.getElementById(widgetId);
        if (!widget) {
            widget = document.createElement('div');
            widget.id = widgetId;
            // 检测是否为移动端
            const isMobile = window.innerWidth <= 600 || /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
            // 使用 position: absolute 避免酒馆框架干扰
            if (isMobile) {
                widget.style.cssText = `
                    position: absolute;
                    left: 10px;
                    right: 10px;
                    bottom: 80px;
                    background: rgba(15, 15, 35, 0.96);
                    color: #e0e0e0;
                    border: 1px solid rgba(102, 126, 234, 0.35);
                    border-radius: 10px;
                    z-index: 10000;
                    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
                    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                    box-sizing: border-box;
                `;
            } else {
                widget.style.cssText = `
                    position: absolute;
                    right: 16px;
                    bottom: 90px;
                    width: 320px;
                    background: rgba(15, 15, 35, 0.96);
                    color: #e0e0e0;
                    border: 1px solid rgba(102, 126, 234, 0.35);
                    border-radius: 10px;
                    z-index: 10000;
                    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
                    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                    box-sizing: border-box;
                `;
            }
            // 使用 body，与通用插图脚本保持一致
            document.body.appendChild(widget);
        }

        const buttonId = 'vertex_btn_' + promptHash;
        const spanId = 'vertex_span_' + promptHash;
        const preview = prompt.length > 60 ? (prompt.slice(0, 60) + '...') : prompt;

        widget.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid rgba(58,58,92,0.8);">
                <div style="font-weight:700;color:#667eea;">流式插图</div>
                <button id="vertex-stream-auto-close" style="background:transparent;border:none;color:#aaa;cursor:pointer;font-size:16px;line-height:1;">×</button>
            </div>
            <div style="padding:10px 12px;font-size:12px;color:#bbb;line-height:1.4;">
                <div style="margin-bottom:8px;">提示词预览：${preview.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
                <button id="${buttonId}" class="vertex-generate-btn" data-prompt="${prompt.replace(/\"/g, '&quot;')}" data-prompt-hash="${promptHash}" style="padding:8px 12px;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;width:100%;">生成插图</button>
                <span id="${spanId}" class="vertex-image-span" data-button-id="${buttonId}" data-prompt-hash="${promptHash}" style="display:block;text-align:center;margin-top:10px;"></span>
            </div>
        `;

        const closeBtn = document.getElementById('vertex-stream-auto-close');
        if (closeBtn) closeBtn.onclick = () => widget.remove();

        const button = document.getElementById(buttonId);
        const span = document.getElementById(spanId);

        // 如果预生成已经完成，直接显示
        const preGenImage = getPreGeneratedImage(promptHash);
        if (preGenImage && span && button) {
            displayImageInSpan(span, preGenImage, button);
            return;
        }

        // 如果正在预生成中，更新按钮状态
        const preGenStatus = preGenerateCache.get(promptHash);
        if (button && preGenStatus && preGenStatus.status === 'generating') {
            button.textContent = '预生成中...';
            button.disabled = true;
            button.style.opacity = '0.7';
        }

        // 绑定直接点击生成（悬浮窗不在消息容器内，不能复用事件委托）
        if (button && span && !button.dataset.vertexDirectBound) {
            button.dataset.vertexDirectBound = 'true';
            button.onclick = async () => {
                if (button.disabled) return;

                button.disabled = true;
                button.textContent = '生成中...';
                button.style.opacity = '0.7';

                try {
                    const imageUrl = await generateImage(prompt, button);
                    if (imageUrl) {
                        await setCachedImage(promptHash, imageUrl);
                        displayImageInSpan(span, imageUrl, button);
                    }
                } catch (error) {
                    alert(`生成失败: ${error.message}`);
                    button.textContent = '重新生成';
                } finally {
                    button.disabled = false;
                    button.style.opacity = '1';
                }
            };
        }
    }

    // 构建 image 标签匹配正则
    // 兼容以下格式：
    // 1) image:{...}
    // 2) image: {...} / image：{...}
    // 3) image### ... ### / image:### ... ### / image：### ... ###
    // 4) 自定义 startTag/endTag
    function getImageTagRegex(withCapture = true) {
        const startTag = settings.startTag || 'image:{';
        const endTag = settings.endTag || '}';

        const parts = [];

        // 自定义标签（始终参与匹配，避免用户改了配置后失效）
        if (startTag && endTag) {
            parts.push(withCapture
                ? `${escapeRegExp(startTag)}([\\s\\S]*?)${escapeRegExp(endTag)}`
                : `${escapeRegExp(startTag)}[\\s\\S]*?${escapeRegExp(endTag)}`);
        }

        // 默认/容错格式：image:{...}、image: {...}、image：{...}
        parts.push(withCapture
            ? 'image\\s*[:：]\\s*\\{([\\s\\S]*?)\\}'
            : 'image\\s*[:：]\\s*\\{[\\s\\S]*?\\}');

        // 额外容错：image### ... ###（也兼容 image:###...### / image：###...###）
        parts.push(withCapture
            ? 'image\\s*(?:[:：]\\s*)?#{3}\\s*([\\s\\S]*?)\\s*#{3}'
            : 'image\\s*(?:[:：]\\s*)?#{3}\\s*[\\s\\S]*?\\s*#{3}');

        return new RegExp(`(?:${parts.join('|')})`, 'gi');
    }

    // 从文本中提取所有完整的 image 标签
    function extractImageTagsFromText(text) {
        const results = [];
        const regex = getImageTagRegex(true);
        let match;

        while ((match = regex.exec(text)) !== null) {
            const prompt = (match.slice(1).find(v => v != null && v !== '') || '').trim();
            if (!prompt) continue;
            results.push({
                prompt,
                refName: null, // 普通文生图没有参考图
                fullMatch: match[0],
                startIndex: match.index,
                endIndex: match.index + match[0].length
            });
        }
        return results;
    }

    // 从文本中提取所有 imageref 标签（图生图）
    // 格式: imageref:参考图名称{prompt内容}
    function extractImageRefTagsFromText(text) {
        const results = [];
        // 匹配 imageref:名称{内容} 格式
        const regex = /imageref:([^{]+)\{([^}]*)\}/g;
        let match;

        while ((match = regex.exec(text)) !== null) {
            const refName = match[1].trim();
            const prompt = match[2].trim();
            if (refName && prompt) {
                results.push({
                    prompt,
                    refName,
                    fullMatch: match[0],
                    startIndex: match.index,
                    endIndex: match.index + match[0].length
                });
            }
        }
        return results;
    }

    // 合并提取所有图片标签（普通 + 参考图）
    function extractAllImageTagsFromText(text) {
        const imageTags = extractImageTagsFromText(text);
        const imageRefTags = extractImageRefTagsFromText(text);
        // 合并并按位置排序
        return [...imageTags, ...imageRefTags].sort((a, b) => a.startIndex - b.startIndex);
    }

    // 预生成图片（后台静默执行，支持参考图）
    async function preGenerateImage(prompt, promptHash, refName = null) {
        if (preGenerateCache.has(promptHash)) {
            debugLog('🔄 预生成跳过（已存在）:', promptHash);
            return;
        }

        // 先检查 IndexedDB 缓存
        const cached = await getCachedImage(promptHash);
        if (cached) {
            preGenerateCache.set(promptHash, { status: 'done', imageUrl: cached });
            debugLog('📦 预生成命中缓存:', promptHash);
            return;
        }

        // 如果有参考图名称，获取参考图数据
        let refImageData = null;
        if (refName) {
            refImageData = await getRefImage(refName);
            if (!refImageData) {
                console.warn(`[Vertex] 找不到参考图: ${refName}`);
            } else {
                debugLog('🖼️ 预生成使用参考图:', refName);
            }
        }

        // 标记为正在生成
        preGenerateCache.set(promptHash, { status: 'generating' });
        debugLog('🚀 预生成开始:', promptHash, prompt.substring(0, 50) + '...');

        try {
            const imageUrl = await generateImage(prompt, null, refImageData);
            if (imageUrl) {
                await setCachedImage(promptHash, imageUrl);
                preGenerateCache.set(promptHash, { status: 'done', imageUrl });
                debugLog('✅ 预生成完成:', promptHash);

                // 如果此时已经有对应的按钮，直接显示图片
                tryDisplayPreGeneratedImage(promptHash);
            } else {
                preGenerateCache.set(promptHash, { status: 'failed' });
                debugLog('❌ 预生成失败（无图片URL）:', promptHash);
            }
        } catch (error) {
            preGenerateCache.set(promptHash, { status: 'failed', error: error.message });
            debugLog('❌ 预生成失败:', promptHash, error.message);
        }
    }

    // 尝试显示预生成的图片（如果按钮已渲染）
    // retryCount: 内部重试计数，用于在 DOM 未就绪时延迟重试
    function tryDisplayPreGeneratedImage(promptHash, retryCount = 0) {
        const maxRetries = 10; // 最多重试10次，每次间隔500ms，共5秒

        // 新版：同一条消息可能有多个 image 标签，因此不能再用 promptHash 作为唯一 DOM id
        const cacheNew = preGenerateCache.get(promptHash);
        if (cacheNew && cacheNew.status === 'done' && cacheNew.imageUrl) {
            const spans = document.querySelectorAll(`.vertex-image-span[data-prompt-hash="${promptHash}"]`);
            if (spans.length > 0) {
                let displayedCount = 0;
                for (const span of spans) {
                    if (span.querySelector('img')) {
                        displayedCount++;
                        continue;
                    }
                    const buttonId = span.getAttribute('data-button-id');
                    const button = buttonId ? document.getElementById(buttonId) : null;
                    if (!button) continue;
                    displayImageInSpan(span, cacheNew.imageUrl, button);
                    displayedCount++;
                }
                if (displayedCount > 0) return;
            }
        }

        const spanId = 'vertex_span_' + promptHash;
        const span = document.getElementById(spanId);
        const buttonId = 'vertex_btn_' + promptHash;
        const button = document.getElementById(buttonId);

        if (span && button) {
            const cache = preGenerateCache.get(promptHash);
            if (cache && cache.status === 'done' && cache.imageUrl) {
                // 只有在 span 为空时才显示
                if (!span.querySelector('img')) {
                    debugLog('🎯 自动填充预生成图片:', promptHash);
                    displayImageInSpan(span, cache.imageUrl, button);
                    return;
                }
            }
        }

        // DOM 未就绪，延迟重试（解决预生成完成但 DOM 还没渲染的问题）
        if (retryCount < maxRetries) {
            debugLog(`⏳ DOM 未就绪，延迟重试 (${retryCount + 1}/${maxRetries}):`, promptHash);
            setTimeout(() => tryDisplayPreGeneratedImage(promptHash, retryCount + 1), 500);
        } else {
            debugLog('⚠️ 预生成图片显示重试超时，等待 processMessages 处理:', promptHash);
        }
    }

    // 处理流式文本变化
    function processStreamingText(currentText) {
        if (!settings.scriptEnabled) return;
        if (!settings.preGenerateDuringStreaming && !settings.autoGenerateOnComplete && !settings.autoGenerateFromStreamText) return;

        // 提取所有完整的 image 标签（包括普通标签和参考图标签）
        const imageTags = extractImageTagsFromText(currentText);
        const imageRefTags = extractImageRefTagsFromText(currentText);
        const allTags = [...imageTags, ...imageRefTags];

        for (const tag of allTags) {
            // 对于参考图标签，hash 需要包含参考图名称以区分不同参考图
            const hashKey = tag.refName ? `${tag.refName}:${tag.prompt}` : tag.prompt;
            const promptHash = hashPrompt(hashKey);

            // 检查是否已处理过
            if (processedStreamPrompts.has(promptHash)) continue;

            // 标记为已处理并开始预生成
            processedStreamPrompts.add(promptHash);

            if (tag.refName) {
                debugLog('🔍 流式检测到新 imageref 标签:', promptHash, `参考图=${tag.refName}`, tag.prompt.substring(0, 30) + '...');
            } else {
                debugLog('🔍 流式检测到新 image 标签:', promptHash, tag.prompt.substring(0, 30) + '...');
            }

            // 异步预生成（不阻塞流式显示），传入参考图名称
            preGenerateImage(tag.prompt, promptHash, tag.refName);
        }

        // 无标签自动插图：从 JSON "text" 字段尽早抽取提示词并立即发起预生成
        if (settings.autoGenerateFromStreamText && !autoStreamGeneratedOnce) {
            const prompt = extractXiantuStreamTextPrompt(currentText);
            const minChars = settings.autoGenerateFromStreamTextMinChars || 120;

            if (prompt && prompt.length >= minChars) {
                autoStreamGeneratedOnce = true;
                const promptHash = hashPrompt(prompt);

                console.log('[Vertex] 流式自动插图触发:', prompt.substring(0, 50) + '...');
                ensureStreamAutoWidget(prompt, promptHash);
                preGenerateImage(prompt, promptHash);
            }
        }
    }

    // 流式内容观察器
    let streamContentObserver = null;

    // 网络层 SSE 流式监听（不依赖 DOM）
    let fetchHookInstalled = false;
    let fetchStreamActive = false;

    function extractStreamDeltaText(parsed) {
        if (!parsed) return '';
        // OpenAI 兼容
        const openAiDelta = parsed.choices?.[0]?.delta?.content;
        if (typeof openAiDelta === 'string') return openAiDelta;
        // Gemini 兼容
        const geminiText = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
        if (typeof geminiText === 'string') return geminiText;
        // Claude 兼容
        const claudeText = parsed.delta?.text;
        if (typeof claudeText === 'string') return claudeText;
        return '';
    }

    async function consumeSseStreamFromResponse(response) {
        if (!response?.body) return;

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let fullText = '';
        let lastProcessedLen = 0;
        const maxKeep = 60000; // 防止无限增长

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith('data:')) continue;

                    let data = trimmed.slice(5);
                    if (data.startsWith(' ')) data = data.slice(1);
                    if (!data || data === '[DONE]') continue;

                    try {
                        const parsed = JSON.parse(data);
                        const chunk = extractStreamDeltaText(parsed);
                        if (!chunk) continue;

                        fullText += chunk;
                        if (fullText.length > maxKeep) fullText = fullText.slice(fullText.length - maxKeep);

                        // 降低调用频率：只在文本明显增长时处理
                        if (fullText.length - lastProcessedLen >= 8) {
                            lastProcessedLen = fullText.length;
                            processStreamingText(fullText);
                        }
                    } catch {
                        continue;
                    }
                }
            }

            // 最后一轮补处理
            if (fullText.length !== lastProcessedLen) {
                processStreamingText(fullText);
            }
        } catch (e) {
            debugLog('⚠️ SSE 监听异常:', e?.message || e);
        }
    }

    function installFetchStreamHook() {
        if (!settings.streamFetchHookEnabled) return;
        if (fetchHookInstalled) return;

        const w = unsafeWindow || window;
        if (!w || typeof w.fetch !== 'function') return;

        const originalFetch = w.fetch.bind(w);

        w.fetch = async (...args) => {
            const response = await originalFetch(...args);

            try {
                const contentType = response.headers?.get?.('content-type') || '';
                if (contentType.includes('text/event-stream') && response.clone) {
                    // 多路 SSE 可能并存，这里只处理一个活跃流，避免重复触发
                    if (!fetchStreamActive) {
                        fetchStreamActive = true;
                        resetStreamingDetectionState();

                        const cloned = response.clone();
                        consumeSseStreamFromResponse(cloned).finally(() => {
                            fetchStreamActive = false;
                        });
                    }
                }
            } catch (_e) {
                // 忽略
            }

            return response;
        };

        fetchHookInstalled = true;
        console.log('[Vertex文生图] 已安装网络层 SSE 流式监听');
    }

    function startStreamObserver() {
        if (streamObserverActive) return;

        // 查找流式输出区域
        const streamingContainers = document.querySelectorAll('.streaming-narrative-content, .streaming-text');

        if (streamingContainers.length === 0) return;

        streamObserverActive = true;
        resetStreamingDetectionState();

        debugLog('👁️ 流式监听器启动');

        streamContentObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                // 获取当前完整文本
                const container = (mutation.target && mutation.target.nodeType === Node.ELEMENT_NODE ? mutation.target : mutation.target?.parentElement)?.closest?.('.streaming-narrative-content, .streaming-text');
                if (container) {
                    const currentText = container.textContent || '';
                    if (currentText !== streamBuffer && currentText.length > streamBuffer.length) {
                        streamBuffer = currentText;
                        processStreamingText(currentText);
                    }
                }
            }
        });

        // 监听所有流式容器
        for (const container of streamingContainers) {
            streamContentObserver.observe(container, {
                childList: true,
                subtree: true,
                characterData: true,
                characterDataOldValue: true
            });
        }
    }

    function stopStreamObserver() {
        if (streamContentObserver) {
            streamContentObserver.disconnect();
            streamContentObserver = null;
        }
        streamObserverActive = false;
        streamBuffer = '';
        debugLog('👁️ 流式监听器停止');
    }

    // 检查预生成状态
    function getPreGeneratedImage(promptHash) {
        const cache = preGenerateCache.get(promptHash);
        if (cache && cache.status === 'done') {
            return cache.imageUrl;
        }
        return null;
    }

    // 自动生成处理函数（并行版本）
    async function processAutoGenerateQueue() {
        if (isAutoGenerating || autoGenerateQueue.size === 0) return;

        isAutoGenerating = true;
        const queueSize = autoGenerateQueue.size;
        debugLog('🚀 开始自动生成队列处理，待处理:', queueSize);

        // 计算并发数：优先使用配置值，否则使用反代URL数量，最少为1
        const proxyCount = getProxyUrls().length || 1;
        const maxConcurrency = settings.proxyConcurrency > 0
            ? settings.proxyConcurrency
            : (settings.requestMode === 'proxy' ? proxyCount : 1);

        debugLog(`📊 并发配置: 最大并发数=${maxConcurrency}, 反代数=${proxyCount}`);

        // 将队列转为数组
        const buttonIds = Array.from(autoGenerateQueue);
        autoGenerateQueue.clear();

        // 单个按钮的生成任务
        async function processButton(buttonId) {
            const button = document.getElementById(buttonId);
            if (!button || button.disabled) return;

            const prompt = button.dataset.prompt;
            const promptHash = button.dataset.promptHash;
            const span = document.querySelector(`.vertex-image-span[data-button-id="${buttonId}"]`);

            if (!span) return;

            // 检查缓存
            const cachedImage = await getCachedImage(promptHash);
            if (cachedImage) {
                debugLog('📦 自动生成 - 使用缓存:', buttonId);
                displayImageInSpan(span, cachedImage, button);
                return;
            }

            debugLog('🎨 自动生成 - 开始请求:', buttonId);
            button.disabled = true;
            button.textContent = '自动生成中...';
            button.style.opacity = '0.7';

            try {
                const imageUrl = await generateImage(prompt, button);
                if (imageUrl) {
                    await setCachedImage(promptHash, imageUrl);
                    displayImageInSpan(span, imageUrl, button);
                    debugLog('✅ 自动生成成功:', buttonId);
                }
            } catch (error) {
                debugLog('❌ 自动生成失败:', buttonId, error.message);
                button.textContent = '生成失败，点击重试';
            } finally {
                button.disabled = false;
                button.style.opacity = '1';
            }
        }

        // 并发控制器：限制同时运行的任务数
        async function runWithConcurrencyLimit(tasks, limit) {
            const results = [];
            const executing = new Set();

            for (const task of tasks) {
                const promise = task().finally(() => executing.delete(promise));
                executing.add(promise);
                results.push(promise);

                if (executing.size >= limit) {
                    await Promise.race(executing);
                }
            }

            return Promise.all(results);
        }

        // 创建任务列表
        const tasks = buttonIds.map(buttonId => () => processButton(buttonId));

        // 并行执行（受并发数限制）
        await runWithConcurrencyLimit(tasks, maxConcurrency);

        isAutoGenerating = false;
        debugLog('✨ 自动生成队列处理完成');
    }

    // 多标签版本：支持同一条消息出现多个 image:{...} 和 imageref:名称{...}
    async function processMessagesMultiTag() {
        // 检查是否在酒馆页面
        const isSillyTavern = document.querySelector('#chat') ||
                              document.querySelector('.mes_text') ||
                              document.title.toLowerCase().includes('sillytavern');

        // 检查是否在仙途(XianTu)页面
        const isXianTu = document.querySelector('.main-game-panel') ||
                         document.querySelector('.formatted-text') ||
                         document.querySelector('.narrative-text') ||
                         document.title.includes('仙途') ||
                         document.title.toLowerCase().includes('xiantu');

        if (!isSillyTavern && !isXianTu) return;

        // 根据平台选择消息容器
        let messageElements = [];
        if (isSillyTavern) {
            messageElements = document.querySelectorAll('.mes_text');
        } else if (isXianTu) {
            messageElements = document.querySelectorAll('.formatted-text, .narrative-text .formatted-text, .streaming-narrative-content .formatted-text');
        }

        // 匹配普通 image 标签和 imageref 标签
        const imageRefRegex = /imageref:([^{]+)\{([^}]*)\}/g;

        for (const msgEl of messageElements) {
            const originalHtml = msgEl.innerHTML;
            if (!originalHtml) continue;

            // 检查是否包含任一种标签
            const hasImageTag = getImageTagRegex(false).test(originalHtml);
            const hasImageRefTag = originalHtml.includes('imageref:');
            if (!hasImageTag && !hasImageRefTag) continue;

            const occurrencesByHash = new Map();
            const insertedItems = [];
            let newHtml = originalHtml;

            // 处理普通 image 标签
            if (hasImageTag) {
                const htmlRegex = getImageTagRegex(false);
                newHtml = newHtml.replace(htmlRegex, (matchedText, ...args) => {
                    // 当正则包含多个捕获组时，offset/fullText 位于参数尾部
                    const fullText = args[args.length - 1];
                    const offset = args[args.length - 2];
                    const plain = extractPrompt(matchedText);
                    const tags = extractImageTagsFromText(plain);
                    const prompt = tags[0]?.prompt;
                    if (!prompt) return matchedText;

                    const promptHash = hashPrompt(prompt);

                    if (settings.showOriginalPrompt && typeof offset === 'number' && typeof fullText === 'string') {
                        const after = fullText.slice(offset + matchedText.length, offset + matchedText.length + 600);
                        if (after.includes('class=\"vertex-generate-btn\"') && after.includes(`data-prompt-hash=\"${promptHash}\"`)) {
                            return matchedText;
                        }
                    }

                    const count = (occurrencesByHash.get(promptHash) || 0) + 1;
                    occurrencesByHash.set(promptHash, count);

                    const buttonId = `vertex_btn_${promptHash}_${count}`;
                    const spanId = `vertex_span_${promptHash}_${count}`;

                    if (document.getElementById(buttonId) || document.getElementById(spanId)) {
                        return matchedText;
                    }

                    insertedItems.push({ buttonId, spanId, prompt, promptHash, refName: null });

                    const safePrompt = prompt.replace(/\"/g, '&quot;');
                    const buttonStyle = settings.showOriginalPrompt
                        ? 'margin-left: 8px; padding: 4px 12px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; vertical-align: middle;'
                        : 'padding: 8px 16px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 14px;';

                    const buttonHtml = `<button id=\"${buttonId}\" class=\"vertex-generate-btn\" data-prompt=\"${safePrompt}\" data-prompt-hash=\"${promptHash}\" style=\"${buttonStyle}\">生成图片</button>`;
                    const spanHtml = `<span id=\"${spanId}\" class=\"vertex-image-span\" data-button-id=\"${buttonId}\" data-prompt-hash=\"${promptHash}\" style=\"display: block; text-align: center; margin-top: 10px;\"></span>`;

                    return settings.showOriginalPrompt ? `${matchedText}${buttonHtml}${spanHtml}` : `${buttonHtml}${spanHtml}`;
                });
            }

            // 处理 imageref 标签
            if (hasImageRefTag) {
                newHtml = newHtml.replace(imageRefRegex, (matchedText, refName, prompt) => {
                    refName = refName.trim();
                    prompt = prompt.trim();
                    if (!refName || !prompt) return matchedText;

                    // 对于参考图标签，hash 需要包含参考图名称
                    const hashKey = `${refName}:${prompt}`;
                    const promptHash = hashPrompt(hashKey);

                    if (settings.showOriginalPrompt) {
                        // 检查是否已经有按钮
                        if (newHtml.includes(`data-prompt-hash=\"${promptHash}\"`)) {
                            return matchedText;
                        }
                    }

                    const count = (occurrencesByHash.get(promptHash) || 0) + 1;
                    occurrencesByHash.set(promptHash, count);

                    const buttonId = `vertex_btn_${promptHash}_${count}`;
                    const spanId = `vertex_span_${promptHash}_${count}`;

                    if (document.getElementById(buttonId) || document.getElementById(spanId)) {
                        return matchedText;
                    }

                    insertedItems.push({ buttonId, spanId, prompt, promptHash, refName });

                    const safePrompt = prompt.replace(/\"/g, '&quot;');
                    // 图生图按钮使用不同的渐变色以区分
                    const buttonStyle = settings.showOriginalPrompt
                        ? 'margin-left: 8px; padding: 4px 12px; background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; vertical-align: middle;'
                        : 'padding: 8px 16px; background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 14px;';

                    const buttonHtml = `<button id=\"${buttonId}\" class=\"vertex-generate-btn vertex-imageref-btn\" data-prompt=\"${safePrompt}\" data-prompt-hash=\"${promptHash}\" data-ref-name=\"${refName}\" style=\"${buttonStyle}\">🖼️ 图生图</button>`;
                    const spanHtml = `<span id=\"${spanId}\" class=\"vertex-image-span\" data-button-id=\"${buttonId}\" data-prompt-hash=\"${promptHash}\" style=\"display: block; text-align: center; margin-top: 10px;\"></span>`;

                    return settings.showOriginalPrompt ? `${matchedText}${buttonHtml}${spanHtml}` : `${buttonHtml}${spanHtml}`;
                });
            }

            if (insertedItems.length === 0) continue;

            msgEl.innerHTML = newHtml;

            // 初始化每个按钮/占位
            for (const item of insertedItems) {
                const button = document.getElementById(item.buttonId);
                const imageSpan = document.getElementById(item.spanId);
                if (!button || !imageSpan) continue;

                const preGenImage = getPreGeneratedImage(item.promptHash);
                if (preGenImage) {
                    displayImageInSpan(imageSpan, preGenImage, button);
                    continue;
                }

                const cachedImage = await getCachedImage(item.promptHash);
                if (cachedImage) {
                    displayImageInSpan(imageSpan, cachedImage, button);
                    continue;
                }

                const preGenStatus = preGenerateCache.get(item.promptHash);
                if (preGenStatus && preGenStatus.status === 'generating') {
                    button.textContent = '预生成中...';
                    button.style.opacity = '0.7';
                    continue;
                }

                if (settings.autoGenerateOnComplete) {
                    autoGenerateQueue.add(item.buttonId);
                    setTimeout(() => processAutoGenerateQueue(), 1000);
                }
            }

            // 绑定点击事件（事件委托）
            if (!msgEl.dataset.vertexClickBound) {
                msgEl.dataset.vertexClickBound = 'true';
                msgEl.addEventListener('click', async function(event) {
                    if (!event.target.classList.contains('vertex-generate-btn')) return;

                    const btn = event.target;
                    if (btn.disabled) return;

                    const btnPrompt = btn.dataset.prompt;
                    const btnHash = btn.dataset.promptHash;
                    const btnRefName = btn.dataset.refName || null; // 获取参考图名称
                    const btnSpan = document.querySelector(`.vertex-image-span[data-button-id=\"${btn.id}\"]`);
                    if (!btnSpan) return;

                    btn.disabled = true;
                    btn.textContent = btnRefName ? '图生图中...' : '生成中...';
                    btn.style.opacity = '0.7';

                    try {
                        // 如果是图生图，获取参考图数据
                        let refImageData = null;
                        if (btnRefName) {
                            refImageData = await getRefImage(btnRefName);
                            if (!refImageData) {
                                throw new Error(`找不到参考图: ${btnRefName}，请先在设置中上传`);
                            }
                        }

                        const imageUrl = await generateImage(btnPrompt, btn, refImageData);
                        if (imageUrl) {
                            await setCachedImage(btnHash, imageUrl);
                            displayImageInSpan(btnSpan, imageUrl, btn);
                        }
                    } catch (error) {
                        alert(`生成失败: ${error.message}`);
                        btn.textContent = btnRefName ? '🖼️ 重新生成' : '重新生成';
                    } finally {
                        btn.disabled = false;
                        btn.style.opacity = '1';
                    }
                });
            }
        }
    }

    // 处理消息，添加生成按钮（在标签位置替换）
    async function processMessages() {
        if (!settings.scriptEnabled) {
            debugLog('⚠️ 脚本已禁用，跳过处理');
            return;
        }

        // 新版：支持同一条消息多个 image 标签
        return processMessagesMultiTag();

        // 检查是否在酒馆页面
        const isSillyTavern = document.querySelector('#chat') ||
                              document.querySelector('.mes_text') ||
                              document.title.toLowerCase().includes('sillytavern');

        // 检查是否在仙途(XianTu)页面
        const isXianTu = document.querySelector('.main-game-panel') ||
                         document.querySelector('.formatted-text') ||
                         document.querySelector('.narrative-text') ||
                         document.title.includes('仙途') ||
                         document.title.toLowerCase().includes('xiantu');

        debugLog('🔍 环境检测:', {
            isSillyTavern,
            isXianTu,
            pageTitle: document.title,
            hasMainGamePanel: !!document.querySelector('.main-game-panel'),
            hasFormattedText: !!document.querySelector('.formatted-text'),
            hasNarrativeText: !!document.querySelector('.narrative-text'),
            hasMesText: !!document.querySelector('.mes_text')
        });

        if (!isSillyTavern && !isXianTu) {
            debugLog('❌ 未检测到支持的环境，跳过处理');
            return;
        }

        // 根据平台选择消息容器
        let messageElements = [];
        if (isSillyTavern) {
            messageElements = document.querySelectorAll('.mes_text');
            debugLog('📦 使用 SillyTavern 选择器');
        } else if (isXianTu) {
            // XianTu 的消息容器: .formatted-text (在 .narrative-text 或 .streaming-text 内)
            messageElements = document.querySelectorAll('.formatted-text, .narrative-text .formatted-text, .streaming-narrative-content .formatted-text');
            debugLog('📦 使用 XianTu 选择器');
        }

        debugLog(`📝 找到 ${messageElements.length} 个消息容器`);

        for (const msgEl of messageElements) {
            // 获取原始HTML用于匹配
            const originalHtml = msgEl.innerHTML;

            // 清理HTML用于提取提示词
            let cleanText = originalHtml.replace(/<br\s*\/?>/gi, '\n');
            cleanText = cleanText.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
            cleanText = cleanText.replace(/<\/?(span|div|p|a|b|i|u|em|strong|font|img|table|tr|td|th|ul|ol|li|h[1-6])[^>]*>/gi, '');

            // 匹配标签
            const regex = new RegExp(`${escapeRegExp(settings.startTag)}([\\s\\S]*?)${escapeRegExp(settings.endTag)}`);
            const matches = cleanText.match(regex);

            // 调试：显示当前扫描的内容片段
            if (cleanText.includes('image:') || cleanText.includes(settings.startTag)) {
                debugLog('🔎 扫描内容含有关键词:', cleanText.substring(0, 200) + '...');
            }

            if (matches) {
                const prompt = extractPrompt(matches[1]);
                debugLog('✨ 匹配到提示词标签:', {
                    fullMatch: matches[0],
                    extractedPrompt: prompt
                });
                if (!prompt) continue;

                // 检查是否已有对应按钮（通过按钮ID检查）
                const promptHash = hashPrompt(prompt);
                const buttonId = 'vertex_btn_' + promptHash;
                if (document.getElementById(buttonId)) {
                    debugLog('⏭️ 按钮已存在，跳过:', buttonId);
                    continue;
                }

                // 在原始HTML中匹配完整标签（包含可能的HTML标签）
                const htmlRegex = new RegExp(`${escapeRegExp(settings.startTag)}[\\s\\S]*?${escapeRegExp(settings.endTag)}`);
                const htmlMatch = originalHtml.match(htmlRegex);

                if (!htmlMatch) {
                    debugLog('⚠️ HTML匹配失败');
                    continue;
                }

                const matchedText = htmlMatch[0];

                // 创建按钮HTML
                const spanId = 'vertex_span_' + promptHash;
                let buttonHtml;

                if (settings.showOriginalPrompt) {
                    // 显示原始提示词 + 按钮（不替换原文）
                    buttonHtml = `${matchedText}<button id="${buttonId}" class="vertex-generate-btn" data-prompt="${prompt.replace(/"/g, '&quot;')}" data-prompt-hash="${promptHash}" style="margin-left: 8px; padding: 4px 12px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; vertical-align: middle;">生成图片</button><span id="${spanId}" class="vertex-image-span" data-button-id="${buttonId}" style="display: block; text-align: center; margin-top: 10px;"></span>`;
                } else {
                    // 替换模式（原行为）
                    buttonHtml = `<button id="${buttonId}" class="vertex-generate-btn" data-prompt="${prompt.replace(/"/g, '&quot;')}" data-prompt-hash="${promptHash}" style="padding: 8px 16px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 14px;">生成图片</button><span id="${spanId}" class="vertex-image-span" data-button-id="${buttonId}" style="display: block; text-align: center; margin-top: 10px;"></span>`;
                }

                debugLog('🎨 创建按钮:', { buttonId, showOriginalPrompt: settings.showOriginalPrompt, prompt: prompt.substring(0, 50) + '...' });

                // 替换原始标签为按钮
                msgEl.innerHTML = originalHtml.replace(matchedText, buttonHtml);

                // 重新获取按钮元素并绑定事件
                const button = document.getElementById(buttonId);
                const imageSpan = document.getElementById(spanId);

                if (button && imageSpan) {
                    // 优先检查预生成缓存（流式期间已生成的图片）
                    const preGenImage = getPreGeneratedImage(promptHash);
                    if (preGenImage) {
                        debugLog('🎯 使用预生成图片:', promptHash);
                        displayImageInSpan(imageSpan, preGenImage, button);
                    } else {
                        // 其次检查 IndexedDB 缓存
                        const cachedImage = await getCachedImage(promptHash);
                        if (cachedImage) {
                            displayImageInSpan(imageSpan, cachedImage, button);
                        } else {
                            // 检查是否正在预生成中
                            const preGenStatus = preGenerateCache.get(promptHash);
                            if (preGenStatus && preGenStatus.status === 'generating') {
                                // 正在生成中，更新按钮状态
                                button.textContent = '预生成中...';
                                button.style.opacity = '0.7';
                                debugLog('⏳ 等待预生成完成:', promptHash);
                            } else if (settings.autoGenerateOnComplete) {
                                // 自动生成模式：加入队列
                                autoGenerateQueue.add(buttonId);
                                debugLog('📥 加入自动生成队列:', buttonId);
                                // 延迟触发队列处理（等待流式完成）
                                setTimeout(() => processAutoGenerateQueue(), 1000);
                            }
                        }
                    }

                    // 绑定点击事件（使用事件委托方式）
                    if (!msgEl.dataset.vertexClickBound) {
                        msgEl.dataset.vertexClickBound = 'true';
                        msgEl.addEventListener('click', async function(event) {
                            if (event.target.classList.contains('vertex-generate-btn')) {
                                const btn = event.target;
                                if (btn.disabled) return;

                                const btnPrompt = btn.dataset.prompt;
                                const btnHash = btn.dataset.promptHash;
                                const btnSpan = document.querySelector(`.vertex-image-span[data-button-id="${btn.id}"]`);

                                if (!btnSpan) return;

                                btn.disabled = true;
                                btn.textContent = '生成中...';
                                btn.style.opacity = '0.7';

                                try {
                                    const imageUrl = await generateImage(btnPrompt, btn);
                                    if (imageUrl) {
                                        await setCachedImage(btnHash, imageUrl);
                                        displayImageInSpan(btnSpan, imageUrl, btn);
                                    }
                                } catch (error) {
                                    alert(`生成失败: ${error.message}`);
                                    btn.textContent = '重新生成';
                                } finally {
                                    btn.disabled = false;
                                    btn.style.opacity = '1';
                                }
                            }
                        });
                    }
                }
            }
        }
    }

    // 在span中显示图片
    function displayImageInSpan(span, imageUrl, button) {
        span.innerHTML = '';

        const img = document.createElement('img');
        img.src = imageUrl;
        img.alt = 'Generated Image';
        img.style.cssText = `
            max-width: 100%;
            max-height: 500px;
            border-radius: 8px;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
            cursor: pointer;
        `;

        // 点击放大
        img.onclick = (e) => {
            e.stopPropagation();
            const overlay = document.createElement('div');
            // 使用 position: absolute 避免酒馆框架干扰
            overlay.style.cssText = `
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.9);
                display: flex;
                justify-content: center;
                align-items: center;
                z-index: 10000;
                cursor: pointer;
            `;

            const fullImg = document.createElement('img');
            fullImg.src = imageUrl;
            fullImg.style.cssText = 'max-width: 95%; max-height: 95%; object-fit: contain;';

            overlay.appendChild(fullImg);
            overlay.onclick = () => overlay.remove();
            // 使用 body，与通用插图脚本保持一致
            document.body.appendChild(overlay);
        };

        span.appendChild(img);

        // 隐藏或修改按钮
        if (settings.hideButtonAfterGenerate) {
            button.style.display = 'none';
        } else {
            button.textContent = '重新生成';
        }
    }

    // 显示图片
    function displayImage(container, imageUrl, button) {
        container.innerHTML = '';

        const img = document.createElement('img');
        img.src = imageUrl;
        img.alt = 'Generated Image';
        img.style.cssText = `
            max-width: 100%;
            max-height: 500px;
            border-radius: 8px;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
            cursor: pointer;
        `;

        // 点击放大
        img.onclick = () => {
            const overlay = document.createElement('div');
            // 使用 position: absolute 避免酒馆框架干扰
            overlay.style.cssText = `
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.9);
                display: flex;
                justify-content: center;
                align-items: center;
                z-index: 10000;
                cursor: pointer;
            `;

            const fullImg = document.createElement('img');
            fullImg.src = imageUrl;
            fullImg.style.cssText = 'max-width: 95%; max-height: 95%; object-fit: contain;';

            overlay.appendChild(fullImg);
            overlay.onclick = () => overlay.remove();
            // 使用 body，与通用插图脚本保持一致
            document.body.appendChild(overlay);
        };

        container.appendChild(img);

        // 隐藏或修改按钮
        if (settings.hideButtonAfterGenerate) {
            button.style.display = 'none';
        } else {
            button.textContent = '重新生成';
        }
    }

    // ==================== 设置面板 ====================

    function createSettingsPanel() {
        // 检查是否已存在
        if (document.getElementById('vertex-settings-panel')) return;

        // 检测是否为移动端
        const isMobile = window.innerWidth <= 600 || /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

        const panel = document.createElement('div');
        panel.id = 'vertex-settings-panel';

        // 根据设备类型应用不同的面板样式
        // 使用 position: absolute 而不是 fixed，避免酒馆框架的 CSS 干扰
        if (isMobile) {
            // 移动端：全屏填充式布局
            panel.style.cssText = `
                position: absolute;
                top: 10px;
                left: 10px;
                right: 10px;
                bottom: 10px;
                background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
                padding: 16px;
                border-radius: 8px;
                z-index: 10000;
                overflow-y: auto;
                box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
                color: #e0e0e0;
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                box-sizing: border-box;
            `;
        } else {
            // 桌面端：居中弹窗
            panel.style.cssText = `
                position: absolute;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
                padding: 25px;
                border-radius: 12px;
                z-index: 10000;
                width: 450px;
                max-height: 80vh;
                overflow-y: auto;
                box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
                color: #e0e0e0;
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                box-sizing: border-box;
            `;
        }

        panel.innerHTML = `
            <style>
                #vertex-settings-panel h2 {
                    margin: 0 0 20px 0;
                    color: #667eea;
                    font-size: 20px;
                    border-bottom: 2px solid #667eea;
                    padding-bottom: 10px;
                }
                #vertex-settings-panel label {
                    display: block;
                    margin: 12px 0 5px 0;
                    font-size: 14px;
                    color: #b0b0b0;
                }
                #vertex-settings-panel input,
                #vertex-settings-panel select,
                #vertex-settings-panel textarea {
                    width: 100%;
                    padding: 10px;
                    border: 1px solid #3a3a5c;
                    border-radius: 6px;
                    background: #0f0f23;
                    color: #e0e0e0;
                    font-size: 14px;
                    box-sizing: border-box;
                }
                #vertex-settings-panel input:focus,
                #vertex-settings-panel select:focus,
                #vertex-settings-panel textarea:focus {
                    outline: none;
                    border-color: #667eea;
                    box-shadow: 0 0 0 2px rgba(102, 126, 234, 0.2);
                }
                #vertex-settings-panel textarea {
                    min-height: 60px;
                    resize: vertical;
                }
                #vertex-settings-panel .btn-group {
                    display: flex;
                    gap: 10px;
                    margin-top: 20px;
                }
                #vertex-settings-panel button {
                    flex: 1;
                    padding: 12px;
                    border: none;
                    border-radius: 6px;
                    cursor: pointer;
                    font-size: 14px;
                    font-weight: bold;
                    transition: all 0.3s ease;
                }
                #vertex-settings-panel .btn-save {
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: white;
                }
                #vertex-settings-panel .btn-save:hover {
                    transform: translateY(-2px);
                    box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
                }
                #vertex-settings-panel .btn-close {
                    background: #3a3a5c;
                    color: #e0e0e0;
                }
                #vertex-settings-panel .btn-close:hover {
                    background: #4a4a6c;
                }
                #vertex-settings-panel .section-title {
                    font-size: 16px;
                    color: #667eea;
                    margin-top: 20px;
                    margin-bottom: 10px;
                    padding-top: 15px;
                    border-top: 1px solid #3a3a5c;
                }
                #vertex-settings-panel .tip {
                    font-size: 12px;
                    color: #888;
                    margin-top: 3px;
                }
                #vertex-settings-panel .checkbox-wrapper {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }
                #vertex-settings-panel .checkbox-wrapper input {
                    width: auto;
                }
                /* 分页标签样式 */
                #vertex-settings-panel .tab-container {
                    display: flex;
                    border-bottom: 2px solid #3a3a5c;
                    margin-bottom: 15px;
                }
                #vertex-settings-panel .tab-btn {
                    flex: 1;
                    padding: 10px 15px;
                    background: transparent;
                    border: none;
                    color: #888;
                    cursor: pointer;
                    font-size: 14px;
                    font-weight: bold;
                    transition: all 0.3s ease;
                    border-bottom: 3px solid transparent;
                    margin-bottom: -2px;
                }
                #vertex-settings-panel .tab-btn:hover {
                    color: #b0b0b0;
                }
                #vertex-settings-panel .tab-btn.active {
                    color: #667eea;
                    border-bottom-color: #667eea;
                }
                #vertex-settings-panel .tab-btn.active-zimage {
                    color: #ec4899;
                    border-bottom-color: #ec4899;
                }
                #vertex-settings-panel .tab-btn.active-refimage {
                    color: #f093fb;
                    border-bottom-color: #f093fb;
                }
                #vertex-settings-panel .tab-content {
                    display: none;
                }
                #vertex-settings-panel .tab-content.active {
                    display: block;
                }
                #vertex-settings-panel .zimage-section .section-title {
                    color: #ec4899;
                    border-top-color: #4a3a4c;
                }
                #vertex-settings-panel .refimage-section .section-title {
                    color: #f093fb;
                    border-top-color: #4a3a4c;
                }
            </style>

            <h2>Vertex文生图设置 (酒馆/仙途通用)</h2>

            <!-- 分页标签 -->
            <div class="tab-container">
                <button class="tab-btn active" data-tab="vertex-tab">Vertex</button>
                <button class="tab-btn" data-tab="refimage-tab">参考图</button>
                <button class="tab-btn" data-tab="zimage-tab">ZImage</button>
                <button class="tab-btn" data-tab="zimagebase-tab">ZImage-Base</button>
                <button class="tab-btn" data-tab="anima-tab">Anima</button>
            </div>

            <!-- Vertex 分页内容 -->
            <div id="vertex-tab" class="tab-content active">

            <div class="checkbox-wrapper">
                <input type="checkbox" id="vs-scriptEnabled" ${settings.scriptEnabled ? 'checked' : ''}>
                <label for="vs-scriptEnabled" style="display: inline; margin: 0;">启用脚本</label>
            </div>

            <div class="section-title">请求模式</div>

            <label for="vs-requestMode">请求模式</label>
            <select id="vs-requestMode">
                <option value="apikey" ${settings.requestMode === 'apikey' ? 'selected' : ''}>API Key 模式（直连Google）</option>
                <option value="proxy" ${settings.requestMode === 'proxy' ? 'selected' : ''}>反代模式（通用代理服务）</option>
                <option value="antigravity" ${settings.requestMode === 'antigravity' ? 'selected' : ''}>反重力反代模式</option>
            </select>
            <div class="tip">API Key模式直连Google；反代模式使用HF等代理；反重力模式使用antigravity2api</div>

            <div id="vs-apikey-section">
                <label for="vs-apiKeys">API Keys（多个用逗号分隔）</label>
                <textarea id="vs-apiKeys" placeholder="AIzaSy..., AIzaSy..., AIzaSy...">${settings.apiKeys}</textarea>
                <div class="tip">支持多个Key轮询使用，避免单Key限额</div>
            </div>

            <div id="vs-proxy-section">
                <label for="vs-proxyUrl">反代服务URL（多个用逗号分隔）</label>
                <textarea id="vs-proxyUrl" placeholder="https://proxy1.hf.space, https://proxy2.hf.space">${settings.proxyUrl}</textarea>
                <div class="tip">支持多个URL负载均衡，用逗号分隔。如：https://proxy1.hf.space, https://proxy2.hf.space</div>

                <label for="vs-proxyLoadBalanceMode">负载均衡模式</label>
                <select id="vs-proxyLoadBalanceMode">
                    <option value="round-robin" ${settings.proxyLoadBalanceMode === 'round-robin' ? 'selected' : ''}>轮询（Round-Robin）</option>
                    <option value="random" ${settings.proxyLoadBalanceMode === 'random' ? 'selected' : ''}>随机（Random）</option>
                </select>
                <div class="tip">轮询=依次使用每个URL；随机=每次随机选择一个</div>

                <label for="vs-proxyConcurrency">并行生成数</label>
                <input type="number" id="vs-proxyConcurrency" min="0" max="10" value="${settings.proxyConcurrency}">
                <div class="tip">0=自动（等于反代URL数量）；>0=固定并发数。多图并行生成更快！</div>

                <label for="vs-proxyApiKey">反代API Key</label>
                <input type="text" id="vs-proxyApiKey" value="${settings.proxyApiKey}" placeholder="sk-xxx">
                <div class="tip">反代服务的访问密钥（需要sk-开头）</div>
            </div>

            <div id="vs-antigravity-section">
                <label for="vs-antigravityUrl">反重力反代URL</label>
                <input type="text" id="vs-antigravityUrl" value="${settings.antigravityUrl}" placeholder="http://localhost:8045">
                <div class="tip">antigravity2api 服务地址，如 http://localhost:8045</div>

                <label for="vs-antigravityApiKey">反重力API Key</label>
                <input type="text" id="vs-antigravityApiKey" value="${settings.antigravityApiKey}" placeholder="sk-xxx">
                <div class="tip">反重力反代的访问密钥</div>
            </div>

            <label for="vs-model">模型</label>
            <select id="vs-model">
                <option value="gemini-3-pro-image-preview" ${settings.model === 'gemini-3-pro-image-preview' ? 'selected' : ''}>gemini-3-pro-image-preview</option>
            </select>

            <div class="section-title">提示词配置</div>

            <label for="vs-startTag">开始标记</label>
            <input type="text" id="vs-startTag" value="${settings.startTag}">

            <label for="vs-endTag">结束标记</label>
            <input type="text" id="vs-endTag" value="${settings.endTag}">
            <div class="tip">AI输出中使用这些标记包裹提示词，如: image:{一只可爱的猫咪}</div>

            <label for="vs-fixedPrompt">固定正向提示词</label>
            <textarea id="vs-fixedPrompt" placeholder="会添加到每个提示词前面">${settings.fixedPrompt}</textarea>

            <div class="section-title">图片配置</div>

            <label for="vs-aspectRatio">宽高比</label>
            <select id="vs-aspectRatio">
                <option value="1:1" ${settings.aspectRatio === '1:1' ? 'selected' : ''}>1:1 (正方形)</option>
                <option value="16:9" ${settings.aspectRatio === '16:9' ? 'selected' : ''}>16:9 (横向)</option>
                <option value="9:16" ${settings.aspectRatio === '9:16' ? 'selected' : ''}>9:16 (竖向)</option>
                <option value="4:3" ${settings.aspectRatio === '4:3' ? 'selected' : ''}>4:3</option>
                <option value="3:4" ${settings.aspectRatio === '3:4' ? 'selected' : ''}>3:4</option>
            </select>

            <label for="vs-imageSize">图片尺寸</label>
            <select id="vs-imageSize">
                <option value="1K" ${settings.imageSize === '1K' ? 'selected' : ''}>1K (1024px)</option>
                <option value="2K" ${settings.imageSize === '2K' ? 'selected' : ''}>2K (2048px)</option>
                <option value="4K" ${settings.imageSize === '4K' ? 'selected' : ''}>4K (4096px)</option>
            </select>

            <label for="vs-mimeType">图片格式</label>
            <select id="vs-mimeType">
                <option value="image/png" ${settings.mimeType === 'image/png' ? 'selected' : ''}>PNG</option>
                <option value="image/jpeg" ${settings.mimeType === 'image/jpeg' ? 'selected' : ''}>JPEG</option>
            </select>

            <div class="section-title">其他设置</div>

            <label for="vs-cacheDays">缓存天数</label>
            <select id="vs-cacheDays">
                <option value="0" ${settings.cacheDays === 0 ? 'selected' : ''}>不缓存</option>
                <option value="1" ${settings.cacheDays === 1 ? 'selected' : ''}>1天</option>
                <option value="7" ${settings.cacheDays === 7 ? 'selected' : ''}>7天</option>
                <option value="30" ${settings.cacheDays === 30 ? 'selected' : ''}>30天</option>
            </select>

            <div class="checkbox-wrapper" style="margin-top: 15px;">
                <input type="checkbox" id="vs-hideButtonAfterGenerate" ${settings.hideButtonAfterGenerate ? 'checked' : ''}>
                <label for="vs-hideButtonAfterGenerate" style="display: inline; margin: 0;">生成后隐藏按钮</label>
            </div>

            <div class="checkbox-wrapper" style="margin-top: 10px;">
                <input type="checkbox" id="vs-showOriginalPrompt" ${settings.showOriginalPrompt ? 'checked' : ''}>
                <label for="vs-showOriginalPrompt" style="display: inline; margin: 0;">显示原始提示词（不替换）</label>
            </div>
            <div class="tip">开启后会保留 image:{...} 原文，按钮显示在后面</div>

            <div class="checkbox-wrapper" style="margin-top: 10px;">
                <input type="checkbox" id="vs-preGenerateDuringStreaming" ${settings.preGenerateDuringStreaming ? 'checked' : ''}>
                <label for="vs-preGenerateDuringStreaming" style="display: inline; margin: 0;">流式过程中预生成图片（更快）</label>
            </div>
            <div class="tip">开启后只要流式输出中出现完整的 image:{...}，就会立刻后台生成，等消息稳定后自动展示</div>

            <div class="checkbox-wrapper" style="margin-top: 10px;">
                <input type="checkbox" id="vs-streamFetchHookEnabled" ${settings.streamFetchHookEnabled ? 'checked' : ''}>
                <label for="vs-streamFetchHookEnabled" style="display: inline; margin: 0;">网络层 SSE 流式监听（更稳定）</label>
            </div>
            <div class="tip">开启后会在网络层解析流式增量文本，不依赖页面 DOM 是否被框架重绘</div>

            <div class="checkbox-wrapper" style="margin-top: 10px;">
                <input type="checkbox" id="vs-autoGenerateFromStreamText" ${settings.autoGenerateFromStreamText ? 'checked' : ''}>
                <label for="vs-autoGenerateFromStreamText" style="display: inline; margin: 0;">流式文本自动插图（无需 image:{...}）</label>
            </div>
            <div class="tip">开启后会从流式响应的 JSON \"text\" 字段中尽早提取片段并立刻生成插图</div>

            <label for="vs-autoGenerateFromStreamTextMinChars" style="margin-top: 10px;">自动插图触发阈值（字符数）</label>
            <input type="number" id="vs-autoGenerateFromStreamTextMinChars" min="20" max="2000" value="${settings.autoGenerateFromStreamTextMinChars}">
            <div class="tip">越小越早触发，但提示词更不稳定</div>

            <label for="vs-autoGenerateFromStreamTextMaxChars" style="margin-top: 10px;">自动插图最大使用长度（字符数）</label>
            <input type="number" id="vs-autoGenerateFromStreamTextMaxChars" min="60" max="6000" value="${settings.autoGenerateFromStreamTextMaxChars}">
            <div class="tip">过长会影响生成质量/成本，建议 200-600</div>

            <div class="checkbox-wrapper" style="margin-top: 10px;">
                <input type="checkbox" id="vs-showStreamAutoWidget" ${settings.showStreamAutoWidget ? 'checked' : ''}>
                <label for="vs-showStreamAutoWidget" style="display: inline; margin: 0;">显示流式插图悬浮预览窗口</label>
            </div>
            <div class="tip">插图会显示在页面右下角悬浮窗（避免被 Vue 重绘删掉）</div>

            <div class="checkbox-wrapper" style="margin-top: 10px;">
                <input type="checkbox" id="vs-autoGenerateOnComplete" ${settings.autoGenerateOnComplete ? 'checked' : ''}>
                <label for="vs-autoGenerateOnComplete" style="display: inline; margin: 0;">流式完成后自动生成图片</label>
            </div>
            <div class="tip">开启后无需点击按钮，AI回复完成后自动在后台生成图片</div>

            </div><!-- 结束 Vertex 分页 -->

            <!-- 参考图管理分页内容 -->
            <div id="refimage-tab" class="tab-content refimage-section">

            <div class="section-title" style="margin-top: 0; padding-top: 0; border-top: none;">参考图管理（图生图）</div>
            <div class="tip">上传参考图用于人物一致性生成。使用格式: <code style="background: #3a3a5c; padding: 2px 6px; border-radius: 3px;">imageref:图片名称{提示词}</code></div>

            <div style="margin-top: 15px;">
                <label>上传新参考图</label>
                <div style="display: flex; flex-direction: column; gap: 10px; margin-top: 5px;">
                    <input type="text" id="vs-refImageName" placeholder="输入名称（如：唐夏天）">
                    <label for="vs-refImageFile" style="display: inline-block; padding: 10px 16px; background: #3a3a5c; color: #e0e0e0; border-radius: 6px; cursor: pointer; text-align: center;">点击选择图片</label>
                    <input type="file" id="vs-refImageFile" accept="image/*" style="display: none;">
                    <div id="vs-refImagePreview" style="font-size: 12px; color: #888;">未选择文件</div>
                </div>
                <button class="btn-save" id="vs-uploadRefImage" style="margin-top: 10px; flex: none; width: auto; padding: 8px 16px;">上传参考图</button>
            </div>

            <div class="section-title">已保存的参考图</div>
            <div id="vs-refImageList" style="max-height: 300px; overflow-y: auto;">
                <div class="tip">加载中...</div>
            </div>

            </div><!-- 结束参考图分页 -->

            <!-- ZImage 分页内容 -->
            <div id="zimage-tab" class="tab-content zimage-section">

            <div class="checkbox-wrapper">
                <input type="checkbox" id="vs-zimageEnabled" ${settings.zimageEnabled ? 'checked' : ''}>
                <label for="vs-zimageEnabled" style="display: inline; margin: 0;">启用 ZImage 模式（使用 ComfyUI）</label>
            </div>
            <div class="tip">开启后将使用 ComfyUI 的 ZImage 工作流生成图片，而不是 Vertex API</div>

            <div class="section-title">ComfyUI 连接</div>

            <label for="vs-zimageUrl">ComfyUI URL</label>
            <input type="text" id="vs-zimageUrl" value="${settings.zimageUrl}" placeholder="http://127.0.0.1:8188">
            <div class="tip">ComfyUI 服务地址，需要开启 API 功能</div>
            <button class="btn-save" id="vs-testZimage" style="margin-top: 10px; flex: none; width: auto; padding: 8px 16px;">测试连接</button>

            <div class="section-title">模型配置</div>

            <label for="vs-zimageUnetName">UNet 模型</label>
            <input type="text" id="vs-zimageUnetName" value="${settings.zimageUnetName}">

            <label for="vs-zimageClipName">CLIP 模型</label>
            <input type="text" id="vs-zimageClipName" value="${settings.zimageClipName}">

            <label for="vs-zimageVaeName">VAE 模型</label>
            <input type="text" id="vs-zimageVaeName" value="${settings.zimageVaeName}">

            <div class="section-title">LoRA 配置</div>

            <label>LoRA 1</label>
            <div style="display: flex; gap: 10px;">
                <input type="text" id="vs-zimageLora1Name" value="${settings.zimageLora1Name}" style="flex: 3;" placeholder="LoRA 名称">
                <input type="number" id="vs-zimageLora1Strength" value="${settings.zimageLora1Strength}" step="0.1" min="0" max="2" style="flex: 1;" placeholder="强度">
            </div>

            <label>LoRA 2</label>
            <div style="display: flex; gap: 10px;">
                <input type="text" id="vs-zimageLora2Name" value="${settings.zimageLora2Name}" style="flex: 3;" placeholder="None = 不使用">
                <input type="number" id="vs-zimageLora2Strength" value="${settings.zimageLora2Strength}" step="0.1" min="0" max="2" style="flex: 1;">
            </div>

            <label>LoRA 3</label>
            <div style="display: flex; gap: 10px;">
                <input type="text" id="vs-zimageLora3Name" value="${settings.zimageLora3Name}" style="flex: 3;" placeholder="None = 不��用">
                <input type="number" id="vs-zimageLora3Strength" value="${settings.zimageLora3Strength}" step="0.1" min="0" max="2" style="flex: 1;">
            </div>

            <label>LoRA 4</label>
            <div style="display: flex; gap: 10px;">
                <input type="text" id="vs-zimageLora4Name" value="${settings.zimageLora4Name}" style="flex: 3;" placeholder="None = 不使用">
                <input type="number" id="vs-zimageLora4Strength" value="${settings.zimageLora4Strength}" step="0.1" min="0" max="2" style="flex: 1;">
            </div>

            <div class="section-title">采样配置</div>

            <label for="vs-zimageSampler">采样器</label>
            <select id="vs-zimageSampler">
                <option value="er_sde" ${settings.zimageSampler === 'er_sde' ? 'selected' : ''}>er_sde</option>
                <option value="euler" ${settings.zimageSampler === 'euler' ? 'selected' : ''}>euler</option>
                <option value="euler_ancestral" ${settings.zimageSampler === 'euler_ancestral' ? 'selected' : ''}>euler_ancestral</option>
                <option value="dpmpp_2m_sde" ${settings.zimageSampler === 'dpmpp_2m_sde' ? 'selected' : ''}>dpmpp_2m_sde</option>
                <option value="dpmpp_3m_sde" ${settings.zimageSampler === 'dpmpp_3m_sde' ? 'selected' : ''}>dpmpp_3m_sde</option>
            </select>

            <label for="vs-zimageScheduler">调度器</label>
            <select id="vs-zimageScheduler">
                <option value="sgm_uniform" ${settings.zimageScheduler === 'sgm_uniform' ? 'selected' : ''}>sgm_uniform</option>
                <option value="ddim_uniform" ${settings.zimageScheduler === 'ddim_uniform' ? 'selected' : ''}>ddim_uniform</option>
                <option value="simple" ${settings.zimageScheduler === 'simple' ? 'selected' : ''}>simple</option>
                <option value="normal" ${settings.zimageScheduler === 'normal' ? 'selected' : ''}>normal</option>
                <option value="karras" ${settings.zimageScheduler === 'karras' ? 'selected' : ''}>karras</option>
            </select>

            <div style="display: flex; gap: 10px; margin-top: 10px;">
                <div style="flex: 1;">
                    <label for="vs-zimageCfg">CFG</label>
                    <input type="number" id="vs-zimageCfg" value="${settings.zimageCfg}" step="0.1" min="0" max="20">
                </div>
                <div style="flex: 1;">
                    <label for="vs-zimageSteps">步数</label>
                    <input type="number" id="vs-zimageSteps" value="${settings.zimageSteps}" min="1" max="100">
                </div>
            </div>

            <div class="section-title">图片尺寸</div>

            <div style="display: flex; gap: 10px;">
                <div style="flex: 1;">
                    <label for="vs-zimageWidth">宽度</label>
                    <input type="number" id="vs-zimageWidth" value="${settings.zimageWidth}" min="64" max="4096" step="8">
                </div>
                <div style="flex: 1;">
                    <label for="vs-zimageHeight">高度</label>
                    <input type="number" id="vs-zimageHeight" value="${settings.zimageHeight}" min="64" max="4096" step="8">
                </div>
                <div style="flex: 1;">
                    <label for="vs-zimageBatchSize">批量</label>
                    <input type="number" id="vs-zimageBatchSize" value="${settings.zimageBatchSize}" min="1" max="4">
                </div>
            </div>
            <div class="tip">宽高建议为 8 的倍数，批量=同时生成的图片数</div>

            </div><!-- 结束 ZImage 分页 -->

            <!-- ZImage-Base 分页内容 -->
            <div id="zimagebase-tab" class="tab-content zimage-section">

            <div class="checkbox-wrapper">
                <input type="checkbox" id="vs-zimageBaseEnabled" ${settings.zimageBaseEnabled ? 'checked' : ''}>
                <label for="vs-zimageBaseEnabled" style="display: inline; margin: 0;">启用 ZImage-Base 模式（支持负面提示词）</label>
            </div>
            <div class="tip">开启后将使用 ComfyUI 的 ZImage-Base 工作流生成图片，支持负面提示词</div>

            <div class="section-title">ComfyUI 连接</div>

            <label for="vs-zimageBaseUrl">ComfyUI URL</label>
            <input type="text" id="vs-zimageBaseUrl" value="${settings.zimageBaseUrl}" placeholder="http://127.0.0.1:8188">
            <div class="tip">ComfyUI 服务地址，需要开启 API 功能</div>
            <button class="btn-save" id="vs-testZimageBase" style="margin-top: 10px; flex: none; width: auto; padding: 8px 16px;">测试连接</button>

            <div class="section-title">模型配置</div>

            <label for="vs-zimageBaseUnetName">UNet 模型</label>
            <input type="text" id="vs-zimageBaseUnetName" value="${settings.zimageBaseUnetName}">
            <div class="tip">推荐使用 z_image_base_fp8.safetensors</div>

            <label for="vs-zimageBaseClipName">CLIP 模型</label>
            <input type="text" id="vs-zimageBaseClipName" value="${settings.zimageBaseClipName}">

            <label for="vs-zimageBaseVaeName">VAE 模型</label>
            <input type="text" id="vs-zimageBaseVaeName" value="${settings.zimageBaseVaeName}">

            <div class="section-title">负面提示词</div>

            <label for="vs-zimageBaseNegativePrompt">负面提示词</label>
            <textarea id="vs-zimageBaseNegativePrompt" placeholder="输入不希望出现的内容..." style="height: 80px;">${settings.zimageBaseNegativePrompt}</textarea>
            <div class="tip">用于排除不希望出现的内容，如模糊、低质量等</div>

            <div class="section-title">采样配置</div>

            <label for="vs-zimageBaseSampler">采样器</label>
            <select id="vs-zimageBaseSampler">
                <option value="er_sde" ${settings.zimageBaseSampler === 'er_sde' ? 'selected' : ''}>er_sde</option>
                <option value="euler" ${settings.zimageBaseSampler === 'euler' ? 'selected' : ''}>euler</option>
                <option value="euler_ancestral" ${settings.zimageBaseSampler === 'euler_ancestral' ? 'selected' : ''}>euler_ancestral</option>
                <option value="dpmpp_2m_sde" ${settings.zimageBaseSampler === 'dpmpp_2m_sde' ? 'selected' : ''}>dpmpp_2m_sde</option>
                <option value="dpmpp_3m_sde" ${settings.zimageBaseSampler === 'dpmpp_3m_sde' ? 'selected' : ''}>dpmpp_3m_sde</option>
            </select>

            <label for="vs-zimageBaseScheduler">调度器</label>
            <select id="vs-zimageBaseScheduler">
                <option value="sgm_uniform" ${settings.zimageBaseScheduler === 'sgm_uniform' ? 'selected' : ''}>sgm_uniform</option>
                <option value="ddim_uniform" ${settings.zimageBaseScheduler === 'ddim_uniform' ? 'selected' : ''}>ddim_uniform</option>
                <option value="simple" ${settings.zimageBaseScheduler === 'simple' ? 'selected' : ''}>simple</option>
                <option value="normal" ${settings.zimageBaseScheduler === 'normal' ? 'selected' : ''}>normal</option>
                <option value="karras" ${settings.zimageBaseScheduler === 'karras' ? 'selected' : ''}>karras</option>
            </select>

            <div style="display: flex; gap: 10px; margin-top: 10px;">
                <div style="flex: 1;">
                    <label for="vs-zimageBaseCfg">CFG</label>
                    <input type="number" id="vs-zimageBaseCfg" value="${settings.zimageBaseCfg}" step="0.1" min="0" max="20">
                </div>
                <div style="flex: 1;">
                    <label for="vs-zimageBaseSteps">步数</label>
                    <input type="number" id="vs-zimageBaseSteps" value="${settings.zimageBaseSteps}" min="1" max="100">
                </div>
                <div style="flex: 1;">
                    <label for="vs-zimageBaseShift">Shift</label>
                    <input type="number" id="vs-zimageBaseShift" value="${settings.zimageBaseShift}" step="0.1" min="0" max="10">
                </div>
            </div>
            <div class="tip">Base 模型推荐 CFG=4，步数=30，Shift=3</div>

            <div class="section-title">图片尺寸</div>

            <div style="display: flex; gap: 10px;">
                <div style="flex: 1;">
                    <label for="vs-zimageBaseWidth">宽度</label>
                    <input type="number" id="vs-zimageBaseWidth" value="${settings.zimageBaseWidth}" min="64" max="4096" step="8">
                </div>
                <div style="flex: 1;">
                    <label for="vs-zimageBaseHeight">高度</label>
                    <input type="number" id="vs-zimageBaseHeight" value="${settings.zimageBaseHeight}" min="64" max="4096" step="8">
                </div>
                <div style="flex: 1;">
                    <label for="vs-zimageBaseBatchSize">批量</label>
                    <input type="number" id="vs-zimageBaseBatchSize" value="${settings.zimageBaseBatchSize}" min="1" max="4">
                </div>
            </div>
            <div class="tip">宽高建议为 8 的倍数，批量=同时生成的图片数</div>

            </div><!-- 结束 ZImage-Base 分页 -->


            <!-- Anima ???? -->
            <div id="anima-tab" class="tab-content zimage-section">

            <div class="checkbox-wrapper">
                <input type="checkbox" id="vs-animaEnabled" ${settings.animaEnabled ? 'checked' : ''}>
                <label for="vs-animaEnabled" style="display: inline; margin: 0;">Enable Anima mode (ComfyUI)</label>
            </div>
            <div class="tip">When enabled, image generation uses the Anima workflow.</div>

            <div class="section-title">ComfyUI Connection</div>

            <label for="vs-animaUrl">ComfyUI URL</label>
            <input type="text" id="vs-animaUrl" value="${settings.animaUrl}" placeholder="http://127.0.0.1:8188">
            <div class="tip">ComfyUI service URL with API enabled.</div>
            <button class="btn-save" id="vs-testAnima" style="margin-top: 10px; flex: none; width: auto; padding: 8px 16px;">Test Connection</button>

            <div class="section-title">Model Settings</div>

            <label for="vs-animaUnetName">UNet Model</label>
            <input type="text" id="vs-animaUnetName" value="${settings.animaUnetName}">

            <label for="vs-animaClipName">CLIP Model</label>
            <input type="text" id="vs-animaClipName" value="${settings.animaClipName}">

            <label for="vs-animaVaeName">VAE Model</label>
            <input type="text" id="vs-animaVaeName" value="${settings.animaVaeName}">

            <div class="section-title">Prompt Settings</div>

            <label for="vs-animaPromptPrefix">Prompt Prefix</label>
            <textarea id="vs-animaPromptPrefix" placeholder="Prefix appended before prompts" style="height: 70px;">${settings.animaPromptPrefix}</textarea>

            <label for="vs-animaNegativePrompt">Negative Prompt</label>
            <textarea id="vs-animaNegativePrompt" placeholder="What to avoid in generated images" style="height: 80px;">${settings.animaNegativePrompt}</textarea>

            <div class="section-title">Sampling</div>

            <label for="vs-animaSampler">Sampler</label>
            <select id="vs-animaSampler">
                <option value="er_sde" ${settings.animaSampler === 'er_sde' ? 'selected' : ''}>er_sde</option>
                <option value="euler" ${settings.animaSampler === 'euler' ? 'selected' : ''}>euler</option>
                <option value="euler_ancestral" ${settings.animaSampler === 'euler_ancestral' ? 'selected' : ''}>euler_ancestral</option>
                <option value="dpmpp_2m_sde" ${settings.animaSampler === 'dpmpp_2m_sde' ? 'selected' : ''}>dpmpp_2m_sde</option>
                <option value="dpmpp_3m_sde" ${settings.animaSampler === 'dpmpp_3m_sde' ? 'selected' : ''}>dpmpp_3m_sde</option>
            </select>

            <label for="vs-animaScheduler">Scheduler</label>
            <select id="vs-animaScheduler">
                <option value="simple" ${settings.animaScheduler === 'simple' ? 'selected' : ''}>simple</option>
                <option value="normal" ${settings.animaScheduler === 'normal' ? 'selected' : ''}>normal</option>
                <option value="sgm_uniform" ${settings.animaScheduler === 'sgm_uniform' ? 'selected' : ''}>sgm_uniform</option>
                <option value="ddim_uniform" ${settings.animaScheduler === 'ddim_uniform' ? 'selected' : ''}>ddim_uniform</option>
                <option value="karras" ${settings.animaScheduler === 'karras' ? 'selected' : ''}>karras</option>
            </select>

            <div style="display: flex; gap: 10px; margin-top: 10px;">
                <div style="flex: 1;">
                    <label for="vs-animaCfg">CFG</label>
                    <input type="number" id="vs-animaCfg" value="${settings.animaCfg}" step="0.1" min="0" max="20">
                </div>
                <div style="flex: 1;">
                    <label for="vs-animaSteps">Steps</label>
                    <input type="number" id="vs-animaSteps" value="${settings.animaSteps}" min="1" max="100">
                </div>
                <div style="flex: 1;">
                    <label for="vs-animaShift">Shift</label>
                    <input type="number" id="vs-animaShift" value="${settings.animaShift}" step="0.1" min="0" max="10">
                </div>
            </div>

            <div class="section-title">Image Size</div>

            <div style="display: flex; gap: 10px;">
                <div style="flex: 1;">
                    <label for="vs-animaWidth">Width</label>
                    <input type="number" id="vs-animaWidth" value="${settings.animaWidth}" min="64" max="4096" step="8">
                </div>
                <div style="flex: 1;">
                    <label for="vs-animaHeight">Height</label>
                    <input type="number" id="vs-animaHeight" value="${settings.animaHeight}" min="64" max="4096" step="8">
                </div>
                <div style="flex: 1;">
                    <label for="vs-animaBatchSize">Batch</label>
                    <input type="number" id="vs-animaBatchSize" value="${settings.animaBatchSize}" min="1" max="4">
                </div>
            </div>

            </div><!-- End Anima Tab -->

            <div class="btn-group">
                <button class="btn-save" id="vs-save">保存设置</button>
                <button class="btn-close" id="vs-close">关闭</button>
            </div>
        `;

        // 使用 position: absolute 配合 body，与通用插图脚本保持一致
        document.body.appendChild(panel);

        // 绑定事件
        document.getElementById('vs-save').onclick = () => {
            // 保存所有设置
            GM_setValue('scriptEnabled', document.getElementById('vs-scriptEnabled').checked);
            GM_setValue('requestMode', document.getElementById('vs-requestMode').value);
            GM_setValue('proxyUrl', document.getElementById('vs-proxyUrl').value);
            GM_setValue('proxyLoadBalanceMode', document.getElementById('vs-proxyLoadBalanceMode').value);
            GM_setValue('proxyConcurrency', parseInt(document.getElementById('vs-proxyConcurrency').value) || 0);
            GM_setValue('proxyApiKey', document.getElementById('vs-proxyApiKey').value);
            GM_setValue('antigravityUrl', document.getElementById('vs-antigravityUrl').value);
            GM_setValue('antigravityApiKey', document.getElementById('vs-antigravityApiKey').value);
            GM_setValue('apiKeys', document.getElementById('vs-apiKeys').value);
            GM_setValue('model', document.getElementById('vs-model').value);
            GM_setValue('startTag', document.getElementById('vs-startTag').value);
            GM_setValue('endTag', document.getElementById('vs-endTag').value);
            GM_setValue('fixedPrompt', document.getElementById('vs-fixedPrompt').value);
            GM_setValue('aspectRatio', document.getElementById('vs-aspectRatio').value);
            GM_setValue('imageSize', document.getElementById('vs-imageSize').value);
            GM_setValue('mimeType', document.getElementById('vs-mimeType').value);
            GM_setValue('cacheDays', parseInt(document.getElementById('vs-cacheDays').value));
            GM_setValue('hideButtonAfterGenerate', document.getElementById('vs-hideButtonAfterGenerate').checked);
            GM_setValue('showOriginalPrompt', document.getElementById('vs-showOriginalPrompt').checked);
            GM_setValue('preGenerateDuringStreaming', document.getElementById('vs-preGenerateDuringStreaming').checked);
            GM_setValue('streamFetchHookEnabled', document.getElementById('vs-streamFetchHookEnabled').checked);
            GM_setValue('autoGenerateFromStreamText', document.getElementById('vs-autoGenerateFromStreamText').checked);
            GM_setValue('autoGenerateFromStreamTextMinChars', parseInt(document.getElementById('vs-autoGenerateFromStreamTextMinChars').value));
            GM_setValue('autoGenerateFromStreamTextMaxChars', parseInt(document.getElementById('vs-autoGenerateFromStreamTextMaxChars').value));
            GM_setValue('showStreamAutoWidget', document.getElementById('vs-showStreamAutoWidget').checked);
            GM_setValue('autoGenerateOnComplete', document.getElementById('vs-autoGenerateOnComplete').checked);

            // 保存 ZImage 设置
            GM_setValue('zimageEnabled', document.getElementById('vs-zimageEnabled').checked);
            GM_setValue('zimageUrl', document.getElementById('vs-zimageUrl').value);
            GM_setValue('zimageUnetName', document.getElementById('vs-zimageUnetName').value);
            GM_setValue('zimageClipName', document.getElementById('vs-zimageClipName').value);
            GM_setValue('zimageVaeName', document.getElementById('vs-zimageVaeName').value);
            GM_setValue('zimageLora1Name', document.getElementById('vs-zimageLora1Name').value);
            GM_setValue('zimageLora1Strength', parseFloat(document.getElementById('vs-zimageLora1Strength').value) || 0.6);
            GM_setValue('zimageLora2Name', document.getElementById('vs-zimageLora2Name').value);
            GM_setValue('zimageLora2Strength', parseFloat(document.getElementById('vs-zimageLora2Strength').value) || 0.5);
            GM_setValue('zimageLora3Name', document.getElementById('vs-zimageLora3Name').value);
            GM_setValue('zimageLora3Strength', parseFloat(document.getElementById('vs-zimageLora3Strength').value) || 0.5);
            GM_setValue('zimageLora4Name', document.getElementById('vs-zimageLora4Name').value);
            GM_setValue('zimageLora4Strength', parseFloat(document.getElementById('vs-zimageLora4Strength').value) || 0.39);
            GM_setValue('zimageSampler', document.getElementById('vs-zimageSampler').value);
            GM_setValue('zimageScheduler', document.getElementById('vs-zimageScheduler').value);
            GM_setValue('zimageCfg', parseFloat(document.getElementById('vs-zimageCfg').value) || 1);
            GM_setValue('zimageSteps', parseInt(document.getElementById('vs-zimageSteps').value) || 10);
            GM_setValue('zimageWidth', parseInt(document.getElementById('vs-zimageWidth').value) || 720);
            GM_setValue('zimageHeight', parseInt(document.getElementById('vs-zimageHeight').value) || 1280);
            GM_setValue('zimageBatchSize', parseInt(document.getElementById('vs-zimageBatchSize').value) || 1);

            // 保存 ZImage-Base 设置
            GM_setValue('zimageBaseEnabled', document.getElementById('vs-zimageBaseEnabled').checked);
            GM_setValue('zimageBaseUrl', document.getElementById('vs-zimageBaseUrl').value);
            GM_setValue('zimageBaseUnetName', document.getElementById('vs-zimageBaseUnetName').value);
            GM_setValue('zimageBaseClipName', document.getElementById('vs-zimageBaseClipName').value);
            GM_setValue('zimageBaseVaeName', document.getElementById('vs-zimageBaseVaeName').value);
            GM_setValue('zimageBaseNegativePrompt', document.getElementById('vs-zimageBaseNegativePrompt').value);
            GM_setValue('zimageBaseShift', parseFloat(document.getElementById('vs-zimageBaseShift').value) || 3);
            GM_setValue('zimageBaseSampler', document.getElementById('vs-zimageBaseSampler').value);
            GM_setValue('zimageBaseScheduler', document.getElementById('vs-zimageBaseScheduler').value);
            GM_setValue('zimageBaseCfg', parseFloat(document.getElementById('vs-zimageBaseCfg').value) || 4);
            GM_setValue('zimageBaseSteps', parseInt(document.getElementById('vs-zimageBaseSteps').value) || 30);
            GM_setValue('zimageBaseWidth', parseInt(document.getElementById('vs-zimageBaseWidth').value) || 800);
            GM_setValue('zimageBaseHeight', parseInt(document.getElementById('vs-zimageBaseHeight').value) || 1200);
            GM_setValue('zimageBaseBatchSize', parseInt(document.getElementById('vs-zimageBaseBatchSize').value) || 1);

            // ?? Anima ??
            GM_setValue('animaEnabled', document.getElementById('vs-animaEnabled').checked);
            GM_setValue('animaUrl', document.getElementById('vs-animaUrl').value);
            GM_setValue('animaUnetName', document.getElementById('vs-animaUnetName').value);
            GM_setValue('animaClipName', document.getElementById('vs-animaClipName').value);
            GM_setValue('animaVaeName', document.getElementById('vs-animaVaeName').value);
            GM_setValue('animaPromptPrefix', document.getElementById('vs-animaPromptPrefix').value);
            GM_setValue('animaNegativePrompt', document.getElementById('vs-animaNegativePrompt').value);
            GM_setValue('animaShift', parseFloat(document.getElementById('vs-animaShift').value) || 3);
            GM_setValue('animaSampler', document.getElementById('vs-animaSampler').value);
            GM_setValue('animaScheduler', document.getElementById('vs-animaScheduler').value);
            GM_setValue('animaCfg', parseFloat(document.getElementById('vs-animaCfg').value) || 4);
            GM_setValue('animaSteps', parseInt(document.getElementById('vs-animaSteps').value) || 20);
            GM_setValue('animaWidth', parseInt(document.getElementById('vs-animaWidth').value) || 896);
            GM_setValue('animaHeight', parseInt(document.getElementById('vs-animaHeight').value) || 1152);
            GM_setValue('animaBatchSize', parseInt(document.getElementById('vs-animaBatchSize').value) || 1);

            loadSettings();
            installFetchStreamHook();
            alert('设置已保存！');
            panel.remove();
        };

        document.getElementById('vs-close').onclick = () => panel.remove();

        // 分页切换逻辑
        const tabBtns = panel.querySelectorAll('.tab-btn');
        const tabContents = panel.querySelectorAll('.tab-content');
        tabBtns.forEach(btn => {
            btn.onclick = () => {
                const targetTab = btn.dataset.tab;
                tabBtns.forEach(b => {
                    b.classList.remove('active', 'active-zimage', 'active-refimage');
                });
                tabContents.forEach(c => c.classList.remove('active'));

                if (targetTab === 'zimage-tab' || targetTab === 'anima-tab') {
                    btn.classList.add('active-zimage');
                } else if (targetTab === 'refimage-tab') {
                    btn.classList.add('active-refimage');
                } else {
                    btn.classList.add('active');
                }
                document.getElementById(targetTab).classList.add('active');
            };
        });

        // ZImage 测试连接按钮
        document.getElementById('vs-testZimage').onclick = async () => {
            const url = document.getElementById('vs-zimageUrl').value.replace(/\/+$/, '');
            if (!url) {
                alert('请先输入 ComfyUI URL！');
                return;
            }
            try {
                const testBtn = document.getElementById('vs-testZimage');
                testBtn.textContent = '连接中...';
                testBtn.disabled = true;

                const response = await new Promise((resolve, reject) => {
                    GM_xmlhttpRequest({
                        method: 'GET',
                        url: `${url}/system_stats`,
                        timeout: 10000,
                        onload: resolve,
                        onerror: reject,
                        ontimeout: () => reject(new Error('连接超时'))
                    });
                });

                if (response.status === 200) {
                    const data = JSON.parse(response.responseText);
                    alert(`✅ 连接成功！\n\nComfyUI 信息:\nVRAM: ${(data.devices?.[0]?.vram_total / 1024 / 1024 / 1024).toFixed(1)} GB\n已使用: ${(data.devices?.[0]?.vram_free ? ((data.devices[0].vram_total - data.devices[0].vram_free) / 1024 / 1024 / 1024).toFixed(1) : 'N/A')} GB`);
                } else {
                    alert(`❌ 连接失败: HTTP ${response.status}`);
                }
            } catch (e) {
                alert(`❌ 连接失败: ${e.message}`);
            } finally {
                const testBtn = document.getElementById('vs-testZimage');
                testBtn.textContent = '测试连接';
                testBtn.disabled = false;
            }
        };

        // ZImage-Base 测试连接
        document.getElementById('vs-testZimageBase').onclick = async () => {
            const url = document.getElementById('vs-zimageBaseUrl').value.replace(/\/+$/, '');
            if (!url) {
                alert('请先输入 ComfyUI URL！');
                return;
            }
            try {
                const testBtn = document.getElementById('vs-testZimageBase');
                testBtn.textContent = '连接中...';
                testBtn.disabled = true;

                const response = await new Promise((resolve, reject) => {
                    GM_xmlhttpRequest({
                        method: 'GET',
                        url: `${url}/system_stats`,
                        timeout: 10000,
                        onload: resolve,
                        onerror: reject,
                        ontimeout: () => reject(new Error('连接超时'))
                    });
                });

                if (response.status === 200) {
                    const data = JSON.parse(response.responseText);
                    alert(`✅ 连接成功！\n\nComfyUI 信息:\nVRAM: ${(data.devices?.[0]?.vram_total / 1024 / 1024 / 1024).toFixed(1)} GB\n已使用: ${(data.devices?.[0]?.vram_free ? ((data.devices[0].vram_total - data.devices[0].vram_free) / 1024 / 1024 / 1024).toFixed(1) : 'N/A')} GB`);
                } else {
                    alert(`❌ 连接失败: HTTP ${response.status}`);
                }
            } catch (e) {
                alert(`❌ 连接失败: ${e.message}`);
            } finally {
                const testBtn = document.getElementById('vs-testZimageBase');
                testBtn.textContent = '测试连接';
                testBtn.disabled = false;
            }
        };

        // 模式切换时显示/隐藏对应配置区域
        // Anima ????
        document.getElementById('vs-testAnima').onclick = async () => {
            const url = document.getElementById('vs-animaUrl').value.replace(/\/+$/, '');
            if (!url) {
                alert('Please input ComfyUI URL first.');
                return;
            }
            try {
                const testBtn = document.getElementById('vs-testAnima');
                testBtn.textContent = 'Connecting...';
                testBtn.disabled = true;

                const response = await new Promise((resolve, reject) => {
                    GM_xmlhttpRequest({
                        method: 'GET',
                        url: url + '/system_stats',
                        timeout: 10000,
                        onload: resolve,
                        onerror: reject,
                        ontimeout: () => reject(new Error('Connection timeout'))
                    });
                });

                if (response.status === 200) {
                    const data = JSON.parse(response.responseText);
                    alert('Connection success!\n\nComfyUI:\nVRAM: ' + (data.devices?.[0]?.vram_total / 1024 / 1024 / 1024).toFixed(1) + ' GB\nUsed: ' + (data.devices?.[0]?.vram_free ? ((data.devices[0].vram_total - data.devices[0].vram_free) / 1024 / 1024 / 1024).toFixed(1) : 'N/A') + ' GB');
                } else {
                    alert('Connection failed: HTTP ' + response.status);
                }
            } catch (e) {
                alert('Connection failed: ' + e.message);
            } finally {
                const testBtn = document.getElementById('vs-testAnima');
                testBtn.textContent = 'Test Connection';
                testBtn.disabled = false;
            }
        };

        function updateModeVisibility() {
            const mode = document.getElementById('vs-requestMode').value;
            const apikeySection = document.getElementById('vs-apikey-section');
            const proxySection = document.getElementById('vs-proxy-section');
            const antigravitySection = document.getElementById('vs-antigravity-section');

            apikeySection.style.display = 'none';
            proxySection.style.display = 'none';
            antigravitySection.style.display = 'none';

            if (mode === 'proxy') {
                proxySection.style.display = 'block';
            } else if (mode === 'antigravity') {
                antigravitySection.style.display = 'block';
            } else {
                apikeySection.style.display = 'block';
            }
        }

        document.getElementById('vs-requestMode').onchange = updateModeVisibility;
        updateModeVisibility(); // 初始化显示状态

        // ==================== 参考图管理逻辑 ====================

        // 刷新参考图列表显示
        async function refreshRefImageList() {
            const listContainer = document.getElementById('vs-refImageList');
            if (!listContainer) return;

            const refImages = await getAllRefImages();

            if (refImages.length === 0) {
                listContainer.innerHTML = '<div class="tip">暂无参考图，请上传</div>';
                return;
            }

            listContainer.innerHTML = refImages.map(img => `
                <div style="display: flex; align-items: center; gap: 10px; padding: 10px; background: #3a3a5c; border-radius: 6px; margin-bottom: 8px;">
                    <img src="${img.imageData}" style="width: 60px; height: 60px; object-fit: cover; border-radius: 4px; cursor: pointer;" onclick="window.open('${img.imageData}', '_blank')" title="点击查看大图">
                    <div style="flex: 1;">
                        <div style="font-weight: bold; color: #f093fb;">${img.name}</div>
                        <div style="font-size: 11px; color: #888;">使用: imageref:${img.name}{提示词}</div>
                    </div>
                    <button class="vs-delete-ref-btn" data-name="${img.name}" style="padding: 6px 12px; background: #dc3545; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">删除</button>
                </div>
            `).join('');

            // 绑定删除按钮事件
            listContainer.querySelectorAll('.vs-delete-ref-btn').forEach(btn => {
                btn.onclick = async () => {
                    const name = btn.dataset.name;
                    if (confirm(`确定删除参考图 "${name}" 吗？`)) {
                        await deleteRefImage(name);
                        refreshRefImageList();
                    }
                };
            });
        }

        // 文件选择预览
        document.getElementById('vs-refImageFile').onchange = function() {
            const file = this.files[0];
            const preview = document.getElementById('vs-refImagePreview');
            if (file) {
                preview.textContent = `已选择: ${file.name}`;
                preview.style.color = '#f093fb';
            } else {
                preview.textContent = '未选择文件';
                preview.style.color = '#888';
            }
        };

        // 上传参考图按钮事件
        document.getElementById('vs-uploadRefImage').onclick = async () => {
            const nameInput = document.getElementById('vs-refImageName');
            const fileInput = document.getElementById('vs-refImageFile');

            const name = nameInput.value.trim();
            const file = fileInput.files[0];

            if (!name) {
                alert('请输入参考图名称！');
                return;
            }

            if (!file) {
                alert('请选择图片文件！');
                return;
            }

            // 检查是否已存在同名参考图
            const existing = await getRefImage(name);
            if (existing) {
                if (!confirm(`参考图 "${name}" 已存在，是否覆盖？`)) {
                    return;
                }
            }

            const uploadBtn = document.getElementById('vs-uploadRefImage');
            uploadBtn.textContent = '上传中...';
            uploadBtn.disabled = true;

            try {
                // 读取文件为 base64
                const reader = new FileReader();
                const imageData = await new Promise((resolve, reject) => {
                    reader.onload = () => resolve(reader.result);
                    reader.onerror = reject;
                    reader.readAsDataURL(file);
                });

                // 保存到 IndexedDB
                const success = await saveRefImage(name, imageData, file.type);
                if (success) {
                    alert(`参考图 "${name}" 上传成功！`);
                    nameInput.value = '';
                    fileInput.value = '';
                    refreshRefImageList();
                } else {
                    alert('保存失败，请重试');
                }
            } catch (e) {
                alert(`上传失败: ${e.message}`);
            } finally {
                uploadBtn.textContent = '上传参考图';
                uploadBtn.disabled = false;
            }
        };

        // 初始化加载参考图列表
        refreshRefImageList();
    }

    // 添加菜单按钮
    function addMenuButton() {
        // 等待酒馆加载
        const checkInterval = setInterval(() => {
            // 尝试多种可能的菜单位置
            const menuContainers = [
                document.querySelector('#options_button')?.parentElement,
                document.querySelector('.drawer-content'),
                document.querySelector('#extensions_settings'),
                document.querySelector('#leftNavDrawerIcon')?.parentElement
            ].filter(Boolean);

            if (menuContainers.length > 0) {
                clearInterval(checkInterval);

                // 检查是否已添加
                if (document.getElementById('vertex-menu-btn')) return;

                const btn = document.createElement('div');
                btn.id = 'vertex-menu-btn';
                btn.innerHTML = `
                    <a class="drawer-icon" title="Vertex文生图设置" style="cursor: pointer;">
                        <span style="font-size: 20px;">🎨</span>
                    </a>
                `;
                btn.onclick = createSettingsPanel;

                // 尝试插入到最合适的位置
                const target = menuContainers[0];
                if (target) {
                    target.appendChild(btn);
                }
            }
        }, 1000);

        // 30秒后停止检查
        setTimeout(() => clearInterval(checkInterval), 30000);
    }

    // 添加浮动按钮（备用入口）
    function addFloatingButton() {
        const btn = document.createElement('div');
        btn.id = 'vertex-floating-btn';
        btn.innerHTML = '🎨';
        btn.title = 'Vertex文生图设置';
        // 使用 position: absolute 避免酒馆框架干扰
        btn.style.cssText = `
            position: absolute;
            bottom: 20px;
            right: 20px;
            width: 50px;
            height: 50px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            border-radius: 50%;
            display: flex;
            justify-content: center;
            align-items: center;
            font-size: 24px;
            cursor: pointer;
            z-index: 10000;
            box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
            transition: all 0.3s ease;
        `;

        btn.onmouseover = () => {
            btn.style.transform = 'scale(1.1)';
        };
        btn.onmouseout = () => {
            btn.style.transform = 'scale(1)';
        };
        btn.onclick = createSettingsPanel;

        // 使用 body，与通用插图脚本保持一致
        document.body.appendChild(btn);
    }

    // ==================== 初始化 ====================

    async function init() {
        console.log('[Vertex文生图] 脚本已加载 (支持SillyTavern和XianTu)');
        console.log('[Vertex文生图] 调试模式:', DEBUG ? '开启' : '关闭');
        console.log('[Vertex文生图] 当前设置:', {
            startTag: settings.startTag,
            endTag: settings.endTag,
            scriptEnabled: settings.scriptEnabled,
            preGenerateDuringStreaming: settings.preGenerateDuringStreaming,
            streamFetchHookEnabled: settings.streamFetchHookEnabled,
            autoGenerateFromStreamText: settings.autoGenerateFromStreamText,
            autoGenerateFromStreamTextMinChars: settings.autoGenerateFromStreamTextMinChars,
            autoGenerateFromStreamTextMaxChars: settings.autoGenerateFromStreamTextMaxChars,
            showStreamAutoWidget: settings.showStreamAutoWidget,
            autoGenerateOnComplete: settings.autoGenerateOnComplete
        });

        // 初始化数据库
        try {
            await openDatabase();
            console.log('[Vertex文生图] IndexedDB 缓存已就绪');
        } catch (e) {
            console.warn('[Vertex文生图] IndexedDB 初始化失败，将不使用缓存');
        }

        // 安装网络层 SSE 流式监听（尽早抓到增量文本）
        installFetchStreamHook();

        // 添加菜单按钮
        addMenuButton();

        // 添加浮动按钮作为备用入口
        setTimeout(addFloatingButton, 2000);

        // 定期处理消息
        setInterval(processMessages, 2000);

        // 初始处理
        setTimeout(processMessages, 1000);

        // 监听DOM变化
        const observer = new MutationObserver((mutations) => {
            let shouldProcess = false;
            let hasStreamingContent = false;
            let streamingRemoved = false;

            for (const mutation of mutations) {
                // 检查新增节点
                if (mutation.addedNodes.length > 0) {
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType === 1) {
                            // 检测流式内容出现
                            if (node.classList?.contains('streaming-narrative-content') ||
                                node.classList?.contains('streaming-text') ||
                                node.querySelector?.('.streaming-narrative-content') ||
                                node.querySelector?.('.streaming-text')) {
                                hasStreamingContent = true;
                            }

                            if (
                                // SillyTavern 选择器
                                node.classList?.contains('mes') ||
                                node.classList?.contains('mes_text') ||
                                node.querySelector?.('.mes_text') ||
                                // XianTu 选择器
                                node.classList?.contains('formatted-text') ||
                                node.classList?.contains('narrative-text') ||
                                node.classList?.contains('narrative-content') ||
                                node.classList?.contains('streaming-narrative-content') ||
                                node.querySelector?.('.formatted-text') ||
                                node.querySelector?.('.narrative-text')
                            ) {
                                shouldProcess = true;
                            }
                        }
                    }
                }

                // 检查移除节点（流式结束）
                if (mutation.removedNodes.length > 0) {
                    for (const node of mutation.removedNodes) {
                        if (node.nodeType === 1 && (
                            node.classList?.contains('streaming-narrative-content') ||
                            node.classList?.contains('streaming-text') ||
                            node.classList?.contains('ai-processing-indicator')
                        )) {
                            streamingRemoved = true;
                        }
                    }
                }
            }

            // 流式内容出现时启动监听器
            if (hasStreamingContent && (settings.preGenerateDuringStreaming || settings.autoGenerateOnComplete)) {
                debugLog('🌊 检测到流式内容开始');
                startStreamObserver();
            }

            // 流式结束时停止监听器
            if (streamingRemoved) {
                debugLog('🌊 检测到流式内容结束');
                stopStreamObserver();
            }

            if (shouldProcess) {
                debugLog('👀 MutationObserver 检测到新内容，触发处理');
                setTimeout(processMessages, 500);
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    // 页面加载完成后初始化
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();

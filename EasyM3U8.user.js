// ==UserScript==
// @name              无广告视频-加速下载视频-EasyM3U8
// @version           1.0.0
// @description       智能拦截并过滤 m3u8 视频流中的广告切片，基于块分析算法精准识别广告，避免误删。支持一键复制/下载 m3u8 地址，提供智能/暴力双模式切换，可视化操作面板，详细过滤日志。
// @author            xcanwin
// @namespace         https://github.com/xcanwin/EasyM3U8/
// @supportURL        https://github.com/xcanwin/EasyM3U8/
// @match             *://*/*
// @run-at            document-start
// @grant             unsafeWindow
// @grant             GM_getResourceText
// @grant             GM_xmlhttpRequest
// @connect           *
// @license           MIT
// @downloadURL https://raw.githubusercontent.com/xcanwin/EasyM3U8/main/EasyM3U8.user.js
// @updateURL https://raw.githubusercontent.com/xcanwin/EasyM3U8/main/EasyM3U8.user.js
// ==/UserScript==

(function () {
    "use strict";
    // 广告测试:https://nnyy.in/dongman/20249669.html,牧神记72集,MD,14:25,有效
    /**
     * 识别 Cloudflare / 验证码 / 人机校验类中间页：把地址与标题拼成一个
     * 小写文本，再用三组正则（服务商URL特征 / 英文提示 / 中文提示）逐组匹配，
     * 命中任意一组即认为当前是校验页。
     */
    function looks_like_challenge_page() {
        const haystack =
            `${unsafeWindow.location.href} ${unsafeWindow.document.title}`.toLowerCase();
        const provider_pattern =
            /challenges\.cloudflare\.com|geetest\.com|captcha|challenge-platform/;
        const en_pattern =
            /just a moment|checking (?:your browser|browser security)|security (?:check|challenge)|(?:verify you are|are you a) human|please verify|human verification|are you a robot|not a robot|bot detection/;
        const zh_pattern =
            /验证|安全(?:防护|检测|检查)|正在检查您的浏览器|请稍候|我不是机器人/;
        return (
            provider_pattern.test(haystack) ||
            en_pattern.test(haystack) ||
            zh_pattern.test(haystack)
        );
    }
    // 命中校验页则直接放弃后续所有注入，避免干扰验证流程
    if (looks_like_challenge_page()) {
        return;
    }
    let captured_m3u8_url = ""; // 跟踪拦截到的m3u8 URL，用于UI面板
    // Configuration constants
    const CONFIG = {
        AD_SCORE_THRESHOLD: 40, // 广告评分阈值
        PANEL_HIDE_WIDTH: 55, // 面板收起宽度 (px)
        TOAST_DURATION: 3000, // Toast 显示时长 (ms)
        PANEL_AUTO_HIDE_DELAY: 2000, // 面板自动收起延迟 (ms)
        MAX_INPUT_WIDTH_OFFSET: 280, // 输入框最大宽度偏移量（无法测量按钮时的兜底值）
    };
    /**
     * 文件名安全化：白名单只保留 字母(含中日韩)/数字/下划线/连字符/点，其余全部删除。
     * 这样可同时阻断 shell 命令注入（" ` $ \ 等）和 yt-dlp 模板注入（% ( ) ），空则返回 NULL。
     */
    function safe_filename_part(s) {
        const cleaned = (s || "").replace(/[^\p{L}\p{N}_.-]/gu, "");
        return cleaned || "NULL";
    }
    /**
     * 从页面标题解析剧名/集数，返回 "剧名_集数_" 形式的文件名前缀。
     * 标题来自网站，务必经过 safe_filename_part 白名单过滤后才可拼入命令。
     */
    function get_title_chapter_prefix() {
        let title = "";
        let chapter = "";
        try {
            const { document: doc } = getTargetWindowAndDocument();
            const raw = (doc.title || "").trim();
            const match = raw.match(
                /^(?:在线播放)?《?(.+?)》?(?:[ _-]*(?:全集在线观看|(第\d+集)))?(?=\s+[-－|]\s*|$)/,
            );
            title = match?.[1]?.trim() ?? "";
            const match_id = title.match(
                /^([A-Za-z0-9]{2,5}-[A-Za-z0-9]{2,5}) /,
            );
            if (title.length > 15 && match_id) {
                title = match_id?.[1]?.trim() ?? "";
            }
            chapter = match?.[2] ?? "";
            if (!chapter) {
                const el = [
                    ...document.querySelectorAll(
                        ':is([class*="play" i][class*="list" i],[id*="play" i][id*="list" i]) :is([class*="active" i],[class*="selected" i])',
                    ),
                ].find((el) => /第\s*\d+\s*集/.test(el.textContent));
                chapter =
                    el?.textContent
                        .match(/第\s*\d+\s*集/)?.[0]
                        .replace(/\s/g, "") ?? "";
            }
        } catch (e) {
            Logger.warn("解析页面标题失败，文件名前缀使用 NULL");
        }
        return `${safe_filename_part(title)}_${safe_filename_part(chapter)}_`;
    }
    /**
     * URL 安全化：仅允许 http/https；对双引号内的 shell 危险字符（空白/控制符/ " $ ` \ DEL）
     * 做百分号编码——服务器会解码，不改变语义，但杜绝 "$(...)"、反引号等命令注入。
     */
    function shell_safe_url(url) {
        if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return "";
        return url.replace(
            /[- "$`\\]/g,
            (c) =>
                "%" +
                c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"),
        );
    }
    /**
     * 生成本地日期戳 YYYYMMDD（纯数字，天然安全，用于替代 m3u8 常缺失的 %(upload_date)s）。
     */
    function get_date_stamp() {
        const d = new Date();
        const pad = (n) => String(n).padStart(2, "0");
        return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
    }
    // 生成 yt-dlp 下载命令（原始 URL 与命令彻底分离，唯一真源）
    function build_ytdlp_command(url) {
        const safe_url = shell_safe_url(url);
        const prefix = get_title_chapter_prefix();
        // 日期用 JS 本地年月日（纯数字），避免 m3u8 无 upload_date 元数据时文件名出现 NA
        const output = `~/Downloads/${prefix}${get_date_stamp()}.%(ext)s`;
        return (
            `yt-dlp -f "bv*+ba/b" -N 16 --add-header "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:143.0) Gecko/20100101 Firefox/143.0" ` +
            `-o "${output}" --proxy=http://127.0.0.1:10809 ` +
            `--force-overwrites --restrict-filenames --no-check-certificates "${safe_url}"`
        );
    }
    // Unified Logger system
    const Logger = {
        _log(level, color, ...args) {
            const style = `font-weight: bold; color: white; background: ${color}; padding: 2px 6px; border-radius: 3px;`;
            console.log(`%c[EasyM3U8:${level}]`, style, ...args);
        },
        info: (...args) => Logger._log("INFO", "#00a8cc", ...args),
        success: (...args) => Logger._log("OK", "#00cc88", ...args),
        warn: (...args) => Logger._log("WARN", "#ffaa00", ...args),
        error: (...args) => Logger._log("ERROR", "#ff4d4d", ...args),
        debug: (...args) => Logger._log("DEBUG", "#6c757d", ...args),
    };
    // Toast 通知系统
    const TOAST_CONTAINER_ID = "easym3u8-toast-container";
    const TOAST_STYLES = `
        #easym3u8-toast-container {
            position: fixed;
            top: 20px;
            right: 20px;
            z-index: 2147483647;
            display: flex;
            flex-direction: column;
            gap: 12px;
            pointer-events: none;
        }
        .easym3u8-toast {
            min-width: 300px;
            max-width: 400px;
            padding: 16px 20px;
            background: linear-gradient(135deg, #0a0e1a 0%, #0d1117 100%);
            border: 1px solid #00a8cc;
            border-radius: 8px;
            box-shadow: 0 4px 16px rgba(0, 168, 204, 0.3), 0 0 0 1px rgba(0, 168, 204, 0.1);
            display: flex;
            align-items: center;
            gap: 12px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            font-size: 14px;
            color: #00cccc;
            pointer-events: auto;
            animation: easym3u8-toast-slide-in 0.3s cubic-bezier(0.16, 1, 0.3, 1);
            position: relative;
            overflow: hidden;
        }
        .easym3u8-toast.easym3u8-toast-removing {
            animation: easym3u8-toast-slide-out 0.3s cubic-bezier(0.7, 0, 0.84, 0);
        }
        @keyframes easym3u8-toast-slide-in {
            from {
                transform: translateX(calc(100% + 40px));
                opacity: 0;
            }
            to {
                transform: translateX(0);
                opacity: 1;
            }
        }
        @keyframes easym3u8-toast-slide-out {
            from {
                transform: translateX(0);
                opacity: 1;
            }
            to {
                transform: translateX(calc(100% + 40px));
                opacity: 0;
            }
        }
        .easym3u8-toast-icon {
            flex-shrink: 0;
            width: 24px;
            height: 24px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 50%;
            font-weight: bold;
            font-size: 16px;
        }
        .easym3u8-toast-success .easym3u8-toast-icon {
            background: rgba(0, 168, 204, 0.2);
            color: #00a8cc;
        }
        .easym3u8-toast-error .easym3u8-toast-icon {
            background: rgba(255, 77, 77, 0.2);
            color: #ff4d4d;
            border: 1px solid rgba(255, 77, 77, 0.3);
        }
        .easym3u8-toast-warning .easym3u8-toast-icon {
            background: rgba(255, 170, 0, 0.2);
            color: #ffaa00;
            border: 1px solid rgba(255, 170, 0, 0.3);
        }
        .easym3u8-toast-info .easym3u8-toast-icon {
            background: rgba(0, 204, 204, 0.2);
            color: #00cccc;
        }
        .easym3u8-toast-message {
            flex: 1;
            line-height: 1.5;
        }
        .easym3u8-toast-close {
            flex-shrink: 0;
            width: 20px;
            height: 20px;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            color: #00a8cc;
            opacity: 0.6;
            transition: all 0.2s;
            border-radius: 4px;
            font-size: 18px;
            line-height: 1;
        }
        .easym3u8-toast-close:hover {
            opacity: 1;
            background: rgba(0, 168, 204, 0.1);
            transform: scale(1.1);
        }
        .easym3u8-toast-progress {
            position: absolute;
            bottom: 0;
            left: 0;
            height: 2px;
            background: linear-gradient(90deg, #00a8cc, #00cccc);
            animation: easym3u8-toast-progress 3s linear;
        }
        @keyframes easym3u8-toast-progress {
            from { width: 100%; }
            to { width: 0%; }
        }
    `;
    // 初始化Toast样式
    function init_toast_styles() {
        if (unsafeWindow.document.getElementById("easym3u8-toast-styles"))
            return;
        const style = unsafeWindow.document.createElement("style");
        style.id = "easym3u8-toast-styles";
        style.textContent = TOAST_STYLES;
        (
            unsafeWindow.document.head || unsafeWindow.document.documentElement
        ).appendChild(style);
    }
    // 获取或创建Toast容器
    function get_toast_container() {
        let container =
            unsafeWindow.document.getElementById(TOAST_CONTAINER_ID);
        if (!container) {
            container = unsafeWindow.document.createElement("div");
            container.id = TOAST_CONTAINER_ID;
            unsafeWindow.document.body.appendChild(container);
        }
        return container;
    }
    // 显示Toast通知
    function show_toast(text, type = "info", duration = 3000) {
        init_toast_styles();
        const container = get_toast_container();
        const toast = unsafeWindow.document.createElement("div");
        toast.className = `easym3u8-toast easym3u8-toast-${type}`;
        const icons = {
            success: "✓",
            error: "✕",
            warning: "!",
            info: "i",
            question: "?",
        };
        toast.innerHTML = `
            <div class="easym3u8-toast-icon">${icons[type] || icons.info}</div>
            <div class="easym3u8-toast-message">${text}</div>
            <div class="easym3u8-toast-close">×</div>
            <div class="easym3u8-toast-progress"></div>
        `;
        container.appendChild(toast);
        // 关闭按钮事件
        const close_btn = toast.querySelector(".easym3u8-toast-close");
        const remove_toast = () => {
            toast.classList.add("easym3u8-toast-removing");
            setTimeout(() => {
                if (toast.parentNode) {
                    toast.parentNode.removeChild(toast);
                }
            }, 300);
        };
        close_btn.addEventListener("click", remove_toast);
        // 自动关闭
        let auto_close_timer = setTimeout(remove_toast, duration);
        // 鼠标悬停暂停/继续
        toast.addEventListener("mouseenter", () => {
            clearTimeout(auto_close_timer);
            const progress = toast.querySelector(".easym3u8-toast-progress");
            if (progress) {
                progress.style.animationPlayState = "paused";
            }
        });
        toast.addEventListener("mouseleave", () => {
            const remaining_time = duration * 0.3; // 剩余30%时间
            auto_close_timer = setTimeout(remove_toast, remaining_time);
            const progress = toast.querySelector(".easym3u8-toast-progress");
            if (progress) {
                progress.style.animationPlayState = "running";
            }
        });
        return toast;
    }
    // Toast 简易调用接口
    const message = {
        success: (text) => show_toast(text, "success"),
        error: (text) => show_toast(text, "error"),
        warning: (text) => show_toast(text, "warning"),
        info: (text) => show_toast(text, "info"),
        question: (text) => show_toast(text, "question"),
    };
    function is_m3u8_url(url) {
        return /\.m3u8($|\?)/.test(url);
    }
    function get_segment_url_base(url) {
        if (url.startsWith("http://") || url.startsWith("https://")) {
            try {
                const u = new URL(url);
                return u.hostname;
            } catch (e) {
                return url.substring(0, url.lastIndexOf("/"));
            }
        }
        const last_slash = url.lastIndexOf("/");
        if (last_slash > 0) {
            return url.substring(0, last_slash);
        }
        return "";
    }
    function get_ts_name_len(url) {
        const idx = url.indexOf(".ts");
        return idx > 0 ? idx : -1;
    }
    function find_most_common(arr) {
        if (arr.length === 0) return null;
        const counts = {};
        let max_count = 0;
        let max_val = arr[0];
        for (const val of arr) {
            counts[val] = (counts[val] || 0) + 1;
            if (counts[val] > max_count) {
                max_count = counts[val];
                max_val = val;
            }
        }
        return max_val;
    }
    function parse_m3u8_blocks(lines) {
        const blocks = [];
        let current_block = { lines: [], segment_urls: [] };
        for (const line of lines) {
            if (line.startsWith("#EXT-X-DISCONTINUITY")) {
                blocks.push(current_block);
                current_block = { lines: [], segment_urls: [] };
            } else {
                current_block.lines.push(line);
                if (line.trim() !== "" && !line.startsWith("#")) {
                    current_block.segment_urls.push(line.trim());
                }
            }
        }
        blocks.push(current_block);
        return blocks;
    }
    function build_main_profile(blocks) {
        const all_bases = [];
        const all_ts_lens = [];
        const all_seg_counts = [];
        const all_is_absolute = [];
        for (const block of blocks) {
            if (block.segment_urls.length === 0) continue;
            all_seg_counts.push(block.segment_urls.length);
            for (const url of block.segment_urls) {
                all_bases.push(get_segment_url_base(url));
                const ts_len = get_ts_name_len(url);
                if (ts_len > 0) {
                    all_ts_lens.push(ts_len);
                }
                all_is_absolute.push(
                    url.startsWith("http://") || url.startsWith("https://"),
                );
            }
        }
        return {
            main_base: find_most_common(all_bases),
            main_ts_len: find_most_common(all_ts_lens),
            main_seg_count:
                all_seg_counts.length > 0 ? Math.max(...all_seg_counts) : 0,
            // 注意：map(String) 将布尔值转为 'true'/'false'，再判断最常见值
            // 若大多数为 false（相对 URL），则 main_is_absolute 为 true
            main_is_absolute:
                find_most_common(all_is_absolute.map(String)) === "false",
        };
    }
    /**
     * 计算块的广告可能性评分
     *
     * 评分权重设计：
     * - URL 域名不同（+30）: 广告通常来自不同 CDN
     * - 使用绝对 URL（+20）: 插入的广告常用完整链接
     * - ts 文件名长度差异（+15）: 广告切片命名规则可能不同
     * - 段数量过少（+10）: 广告通常只有几个切片
     * - 两侧有 DISCONTINUITY（+10）: 被明确标记为独立内容
     *
     * 阈值 40 分：经验值，平衡误判率和召回率
     *
     * @param {Object} block - 待评估的块
     * @param {Object} main_profile - 主内容特征
     * @param {number} block_index - 块索引
     * @param {number} total_blocks - 总块数
     * @returns {number} 评分 (0-100)
     */
    function score_block_as_ad(block, main_profile, block_index, total_blocks) {
        if (block.segment_urls.length === 0) return 0;
        let score = 0;
        const reasons = [];
        // 检查URL基础是否不同
        const block_bases = block.segment_urls.map(get_segment_url_base);
        const block_main_base = find_most_common(block_bases);
        if (
            main_profile.main_base &&
            block_main_base &&
            block_main_base !== main_profile.main_base
        ) {
            score += 30;
            reasons.push("URL基础不同(+30)");
        }
        // 检查绝对/相对URL差异
        const block_has_absolute = block.segment_urls.some(
            (u) => u.startsWith("http://") || u.startsWith("https://"),
        );
        if (main_profile.main_is_absolute && block_has_absolute) {
            score += 20;
            reasons.push("使用绝对URL而主内容使用相对URL(+20)");
        }
        // 检查ts文件名长度差异
        if (main_profile.main_ts_len) {
            const block_ts_lens = block.segment_urls
                .map(get_ts_name_len)
                .filter((l) => l > 0);
            const block_main_ts_len = find_most_common(block_ts_lens);
            if (
                block_main_ts_len &&
                Math.abs(block_main_ts_len - main_profile.main_ts_len) > 2
            ) {
                score += 15;
                reasons.push("ts文件名长度差异(+15)");
            }
        }
        // 检查段数量是否远少于主内容
        if (
            main_profile.main_seg_count > 3 &&
            block.segment_urls.length <=
                Math.max(2, main_profile.main_seg_count * 0.1)
        ) {
            score += 10;
            reasons.push("段数量远少于主内容(+10)");
        }
        // 两侧都有DISCONTINUITY边界（即非首尾块）
        if (block_index > 0 && block_index < total_blocks - 1) {
            score += 10;
            reasons.push("两侧DISCONTINUITY边界(+10)");
        }
        if (reasons.length > 0) {
            Logger.debug(
                `块 ${block_index} 广告评分: ${score}`,
                reasons.join(", "),
            );
        }
        return score;
    }
    function filter_ad_blocks(lines) {
        // 预检查1：跳过master playlist
        const has_stream_inf = lines.some((l) =>
            l.startsWith("#EXT-X-STREAM-INF"),
        );
        if (has_stream_inf) {
            Logger.info("检测到master playlist (#EXT-X-STREAM-INF)，跳过过滤");
            return lines;
        }
        // 统计DISCONTINUITY标签数量
        const discontinuity_count = lines.filter((l) =>
            l.startsWith("#EXT-X-DISCONTINUITY"),
        ).length;
        // 预检查2：没有DISCONTINUITY标签 → 不可能有广告，原样返回
        if (discontinuity_count === 0) {
            Logger.info(
                "未检测到 #EXT-X-DISCONTINUITY 标签，无需过滤，原样返回",
            );
            return lines;
        }
        // 预检查3：只有1个DISCONTINUITY标签 → 原样返回
        if (discontinuity_count === 1) {
            Logger.info("仅检测到1个 #EXT-X-DISCONTINUITY 标签，原样返回");
            return lines;
        }
        Logger.info(
            `检测到 ${discontinuity_count} 个 #EXT-X-DISCONTINUITY 标签，开始分析`,
        );
        // 解析为块
        const blocks = parse_m3u8_blocks(lines);
        Logger.info(`解析为 ${blocks.length} 个块`);
        // 构建主内容特征
        const main_profile = build_main_profile(blocks);
        Logger.info(
            `主内容特征: URL基础=${main_profile.main_base}, ts长度=${main_profile.main_ts_len}, 最大段数=${main_profile.main_seg_count}, 使用相对URL=${main_profile.main_is_absolute}`,
        );
        // 评估每个块
        const ad_block_indices = new Set();
        for (let i = 0; i < blocks.length; i++) {
            const score = score_block_as_ad(
                blocks[i],
                main_profile,
                i,
                blocks.length,
            );
            if (score >= CONFIG.AD_SCORE_THRESHOLD) {
                ad_block_indices.add(i);
                Logger.warn(
                    `标记块 ${i} 为广告 (评分=${score}, ${blocks[i].segment_urls.length} 个段)`,
                );
            }
        }
        // 关键修复：如果没有检测到广告 → 原样返回
        if (ad_block_indices.size === 0) {
            Logger.info("未检测到广告块，原样返回，不做任何修改");
            return lines;
        }
        Logger.info(`共检测到 ${ad_block_indices.size} 个广告块，开始重建`);
        // 重建：保留非广告块，移除广告块及其边界DISCONTINUITY
        const result = [];
        for (let i = 0; i < blocks.length; i++) {
            if (ad_block_indices.has(i)) {
                // 记录被过滤的内容
                for (const line of blocks[i].lines) {
                    if (line.trim() !== "") {
                        Logger.debug("剔除切片:", line);
                    }
                }
                continue;
            }
            // 添加非广告块的行
            for (const line of blocks[i].lines) {
                result.push(line);
            }
            // 如果下一块不是广告，且不是最后一块，添加DISCONTINUITY分隔
            if (i < blocks.length - 1 && !ad_block_indices.has(i + 1)) {
                result.push("#EXT-X-DISCONTINUITY");
            }
        }
        Logger.success(
            `过滤完成: 原始 ${lines.length} 行 → ${result.length} 行`,
        );
        return result;
    }
    async function clean_m3u8_content(url, content) {
        try {
            captured_m3u8_url = url;
            const lines = content.split("\n");
            const new_lines = filter_ad_blocks(lines);
            return new_lines.join("\n");
        } catch (e) {
            Logger.error(`清洗 m3u8 内容失败: ${url}`, e);
            return content;
        }
    }
    /**
     * 返回“面板所在窗口”的 window/document。
     * 面板永远由顶层帧在它自己的文档里创建（子帧通过 postMessage 把 URL 上抛给顶层，
     * 见 present_video_url / init_top_message_listener），因此这里始终返回当前帧的本地
     * 对象，绝不跨域访问 top.document，从根上杜绝
     * “Permission denied to access ... on cross-origin object”。
     */
    function getTargetWindowAndDocument() {
        return { window: unsafeWindow, document: unsafeWindow.document };
    }
    /**
     * 测量文本在指定样式下的宽度
     */
    function measureTextWidth(
        text,
        styles = "font-size:12px;font-family:sans-serif;padding:5px 8px;",
    ) {
        const { document: doc } = getTargetWindowAndDocument();
        const temp = doc.createElement("span");
        temp.style.cssText = `visibility:hidden;position:absolute;white-space:nowrap;${styles}`;
        temp.textContent = text;
        doc.body.appendChild(temp);
        const width = temp.offsetWidth;
        doc.body.removeChild(temp);
        return width;
    }
    // 视频面板 UI
    let video_panel_created = false;
    // 面板按钮统一样式
    const PANEL_BTN_STYLE =
        "padding:5px 12px;border:1px solid #00a8cc;border-radius:4px;cursor:pointer;font-size:12px;font-weight:bold;transition:all 0.2s;flex-shrink:0;white-space:nowrap;";
    /**
     * 面板按钮工厂：统一样式、悬停变色、空 URL 校验
     * onClick 收到的始终是原始 m3u8 URL（captured_m3u8_url）
     */
    function create_panel_button(doc, opts) {
        const btn = doc.createElement("button");
        btn.textContent = opts.text;
        btn.style.cssText =
            PANEL_BTN_STYLE + `background:${opts.bg};color:${opts.color};`;
        btn.addEventListener("mouseenter", function () {
            btn.style.background = opts.hoverBg;
            btn.style.boxShadow = `0 0 10px ${opts.hoverGlow}`;
        });
        btn.addEventListener("mouseleave", function () {
            btn.style.background = opts.bg;
            btn.style.boxShadow = "none";
        });
        btn.addEventListener("click", function () {
            if (!captured_m3u8_url) {
                message.warning("还没有拦截到 m3u8 地址");
                return;
            }
            opts.onClick(captured_m3u8_url);
        });
        return btn;
    }
    /**
     * 计算并应用输入框宽度。
     * 运行时测量面板内其它子元素的实际宽度作为预留量，避免按钮数量变化时写死偏移出错；
     * 面板尚未渲染时回退到 CONFIG.MAX_INPUT_WIDTH_OFFSET。
     */
    function update_url_input_width() {
        const { window: target_window, document: target_document } =
            getTargetWindowAndDocument();
        const input = target_document.getElementById("easym3u8-url-input");
        if (!input) return;
        const panel = target_document.getElementById("easym3u8-panel");
        let reserved = CONFIG.MAX_INPUT_WIDTH_OFFSET;
        if (panel && panel.children.length > 1) {
            reserved = 40; // padding + 余量
            for (const child of panel.children) {
                if (child === input) continue;
                reserved += child.offsetWidth + 8; // 8 = flex gap
            }
        }
        const text = input.value || input.placeholder;
        const text_width = text ? measureTextWidth(text) : 0;
        const max_input_width = target_window.innerWidth - reserved;
        const final_width = Math.min(
            Math.max(text_width + 20, 200),
            max_input_width,
        );
        input.style.width = final_width + "px";
    }
    function try_create_video_panel() {
        if (video_panel_created) return;
        // 使用统一的窗口获取函数
        const { window: target_window, document: target_document } =
            getTargetWindowAndDocument();
        // 避免重复创建
        if (target_document.getElementById("easym3u8-panel")) {
            video_panel_created = true;
            return;
        }
        let try_n = 0;
        const try_create = function () {
            // 确保body已加载
            if (!target_document.body) {
                try_n++;
                if (try_n < 60) {
                    setTimeout(try_create, 500);
                }
                return;
            }
            const panel = target_document.createElement("div");
            panel.id = "easym3u8-panel";
            panel.style.cssText =
                "display:flex;align-items:center;gap:8px;padding:8px 12px;background:linear-gradient(135deg, #0a0e1a 0%, #0d1117 100%);border:1px solid #00a8cc;border-right:none;border-radius:6px 0 0 6px;font-family:sans-serif;font-size:13px;z-index:2147483647;position:fixed;top:10px;right:0;flex-wrap:nowrap;transition:transform 0.3s ease-in-out;transform:translateX(0);box-shadow:-2px 2px 6px rgba(0,168,204,0.3);max-width:calc(100vw - 20px);";
            const label = target_document.createElement("span");
            label.innerHTML = "EASY";
            label.style.cssText =
                "color:#00cccc;font-weight:bold;flex-shrink:0;text-shadow:0 0 8px rgba(0,204,204,0.6);";
            const url_input = target_document.createElement("input");
            url_input.id = "easym3u8-url-input";
            url_input.type = "text";
            url_input.readOnly = true;
            // 输入框始终只显示原始 m3u8 URL；yt-dlp 命令由按钮按需生成
            url_input.value = captured_m3u8_url || "";
            url_input.placeholder = "等待拦截 m3u8 地址...";
            url_input.style.cssText =
                "padding:5px 8px;border:1px solid #00a8cc;border-radius:4px;background:#0a0e1a;color:#00cccc;font-size:12px;outline:none;box-sizing:border-box;min-width:200px;max-width:100%;";
            // 三按钮：复制视频链接 / 下载视频 / 复制 yt-dlp 命令
            const copy_link_btn = create_panel_button(target_document, {
                text: "复制视频链接",
                bg: "#0d9488",
                color: "#fff",
                hoverBg: "#14b8a6",
                hoverGlow: "rgba(20,184,166,0.45)",
                onClick: (url) => copy_text(url, "已复制视频链接"),
            });
            const download_btn = create_panel_button(target_document, {
                text: "下载视频",
                bg: "#2563eb",
                color: "#fff",
                hoverBg: "#3b82f6",
                hoverGlow: "rgba(59,130,246,0.45)",
                onClick: (url) => download_m3u8_video(url),
            });
            const copy_ytdlp_btn = create_panel_button(target_document, {
                text: "复制yt-dlp命令",
                bg: "#6366f1",
                color: "#fff",
                hoverBg: "#818cf8",
                hoverGlow: "rgba(129,140,248,0.45)",
                onClick: (url) =>
                    copy_text(build_ytdlp_command(url), "已复制 yt-dlp 命令"),
            });
            panel.appendChild(label);
            panel.appendChild(url_input);
            panel.appendChild(copy_link_btn);
            panel.appendChild(download_btn);
            panel.appendChild(copy_ytdlp_btn);
            // 自动收回和展开逻辑
            let auto_collapse_timer = null;
            let is_collapsed = false;
            const collapse_panel = function () {
                if (!is_collapsed) {
                    panel.style.transform = `translateX(calc(100% - ${CONFIG.PANEL_HIDE_WIDTH}px))`;
                    is_collapsed = true;
                }
            };
            const expand_panel = function () {
                if (is_collapsed) {
                    panel.style.transform = "translateX(0)";
                    is_collapsed = false;
                }
            };
            // 自动收回
            auto_collapse_timer = setTimeout(
                collapse_panel,
                CONFIG.PANEL_AUTO_HIDE_DELAY,
            );
            // 鼠标移入展开
            panel.addEventListener("mouseenter", function () {
                if (auto_collapse_timer) {
                    clearTimeout(auto_collapse_timer);
                    auto_collapse_timer = null;
                }
                expand_panel();
            });
            // 鼠标移出收回
            panel.addEventListener("mouseleave", function () {
                collapse_panel();
            });
            // 监听窗口大小改变，重新计算输入框宽度
            target_window.addEventListener("resize", function () {
                update_url_input_width();
            });
            // 插入到顶层页面的body
            target_document.body.appendChild(panel);
            // 面板已渲染，此时可测量按钮实际宽度并计算输入框宽度
            update_url_input_width();
            video_panel_created = true;
            Logger.info("视频面板已创建在顶层窗口");
        };
        try_create();
    }
    function fallback_copy(text, success_msg = "已复制") {
        Logger.debug("降级到 execCommand 复制");
        const { document: target_document } = getTargetWindowAndDocument();
        const textarea = target_document.createElement("textarea");
        textarea.value = text;
        textarea.style.cssText = "position:fixed;left:-9999px;";
        target_document.body.appendChild(textarea);
        textarea.select();
        try {
            target_document.execCommand("copy");
            message.success(success_msg);
        } catch (e) {
            message.error("复制失败，请手动复制");
        }
        target_document.body.removeChild(textarea);
    }
    // 通用复制：优先 Clipboard API，失败降级 execCommand
    function copy_text(text, success_msg) {
        const { window: target_window } = getTargetWindowAndDocument();
        try {
            if (
                target_window.navigator.clipboard &&
                target_window.navigator.clipboard.writeText
            ) {
                target_window.navigator.clipboard
                    .writeText(text)
                    .then(function () {
                        message.success(success_msg);
                    })
                    .catch(function () {
                        fallback_copy(text, success_msg);
                    });
            } else {
                fallback_copy(text, success_msg);
            }
        } catch (e) {
            fallback_copy(text, success_msg);
        }
    }
    function update_video_panel_url(url) {
        const { document: target_document } = getTargetWindowAndDocument();
        const input = target_document.getElementById("easym3u8-url-input");
        if (input) {
            input.value = url; // 只显示原始 URL
            update_url_input_width();
        }
    }
    function download_m3u8_video(url) {
        try {
            Logger.info(`开始下载 m3u8`);
            const { document: target_document } = getTargetWindowAndDocument();
            GM_xmlhttpRequest({
                method: "GET",
                url: url,
                onload: function (response) {
                    if (response.status === 200) {
                        const blob = new Blob([response.responseText], {
                            type: "application/vnd.apple.mpegurl",
                        });
                        const download_url = URL.createObjectURL(blob);
                        const a = target_document.createElement("a");
                        a.href = download_url;
                        // 从URL中提取文件名
                        let filename = "video.m3u8";
                        try {
                            const url_obj = new URL(url);
                            const path_parts = url_obj.pathname.split("/");
                            const last_part = path_parts[path_parts.length - 1];
                            if (last_part && last_part.includes(".m3u8")) {
                                filename = last_part.split("?")[0];
                            }
                        } catch (e) {
                            // 使用默认文件名
                        }
                        a.download = filename;
                        target_document.body.appendChild(a);
                        a.click();
                        target_document.body.removeChild(a);
                        URL.revokeObjectURL(download_url);
                        Logger.success(`下载完成: ${filename}`);
                        message.success("m3u8 文件下载成功");
                    } else {
                        Logger.error(`下载失败: HTTP ${response.status}`);
                        message.error("下载失败: HTTP " + response.status);
                    }
                },
                onerror: function () {
                    Logger.error("下载失败：网络错误");
                    message.error("下载失败，请检查网络");
                },
            });
        } catch (e) {
            Logger.error("下载m3u8出错:", e);
            message.error("下载出错");
        }
    }
    /**
     * 展示拦截到的视频 URL：
     * - 顶层帧：直接在本地文档创建/更新面板（同源，无任何限制）
     * - 子帧：通过 postMessage 把 URL 上抛给顶层帧，由顶层帧监听器建面板
     * 只传视频 URL 一个字符串，不触碰任何一方的 DOM，不削弱同源隔离。
     */
    function present_video_url(url) {
        if (unsafeWindow.self === unsafeWindow.top) {
            try_create_video_panel();
            update_video_panel_url(url);
            return;
        }
        try {
            unsafeWindow.top.postMessage({ __easym3u8: true, url: url }, "*");
        } catch (e) {
            Logger.warn("向顶层窗口发送 m3u8 URL 失败");
        }
    }
    /**
     * 顶层帧监听子帧上抛的 m3u8 URL。
     * 严格校验：必须带 __easym3u8 标记、且为 http(s) 的 .m3u8 地址，否则丢弃，
     * 避免恶意帧伪造消息注入面板 / 下载按钮。
     */
    function init_top_message_listener() {
        if (unsafeWindow.self !== unsafeWindow.top) return;
        unsafeWindow.addEventListener("message", function (e) {
            const data = e.data;
            if (!data || data.__easym3u8 !== true) return;
            const url = data.url;
            if (
                typeof url !== "string" ||
                !/^https?:\/\//i.test(url) ||
                !is_m3u8_url(url)
            ) {
                return;
            }
            captured_m3u8_url = url;
            try_create_video_panel();
            update_video_panel_url(url);
        });
    }
    /**
     * 处理 m3u8 拦截的通用逻辑
     */
    async function handleM3U8Interception(url, originalContent) {
        Logger.success(`拦截到 m3u8 请求: ${url}`);
        captured_m3u8_url = url;
        const modifiedContent = await clean_m3u8_content(url, originalContent);
        present_video_url(url);
        return modifiedContent;
    }
    function intercept_xhr() {
        const OriginalXHR = unsafeWindow.XMLHttpRequest;
        unsafeWindow.XMLHttpRequest = class extends OriginalXHR {
            constructor() {
                super();
                this.addEventListener(
                    "readystatechange",
                    async function () {
                        if (
                            this.readyState === 4 &&
                            this.status === 200 &&
                            is_m3u8_url(this.responseURL)
                        ) {
                            const modifiedResponse =
                                await handleM3U8Interception(
                                    this.responseURL,
                                    this.responseText,
                                );
                            Object.defineProperty(this, "responseText", {
                                value: modifiedResponse,
                            });
                            Object.defineProperty(this, "response", {
                                value: modifiedResponse,
                            });
                        }
                    },
                    false,
                );
            }
        };
    }
    function intercept_fetch() {
        const OriginalFetch = unsafeWindow.fetch;
        unsafeWindow.fetch = function (...args) {
            return OriginalFetch.apply(this, args).then(
                async function (response) {
                    try {
                        if (response.ok && is_m3u8_url(response.url)) {
                            const original_text = await response.text();
                            const modified_text = await handleM3U8Interception(
                                response.url,
                                original_text,
                            );
                            return new Response(modified_text, {
                                status: response.status,
                                statusText: response.statusText,
                                headers: response.headers,
                            });
                        }
                    } catch (e) {
                        Logger.error("intercept_fetch处理出错:", e);
                    }
                    return response;
                },
            );
        };
    }
    function install_interceptors() {
        intercept_xhr();
        intercept_fetch();
    }
    install_interceptors();
    init_top_message_listener();
})();

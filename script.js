/**
 * Hacker News Reader Application
 * Загружает и отображает посты, комментарии с Hacker News API
 */

// Конфигурация приложения - все настраиваемые параметры в одном месте
const CONFIG = {
    ITEMS_PER_PAGE: 10,           // Количество постов на страницу
    MAX_COMMENT_DEPTH: 3,         // Максимальная глубина вложенности комментариев
    LIVE_UPDATE_INTERVAL: 5000,   // Интервал проверки обновлений (мс)
    THROTTLE_DELAY: 200,          // Задержка throttle (мс)
    DEBOUNCE_DELAY: 300,          // Задержка debounce (мс)
    INITIAL_COMMENTS_BATCH: 5,    // Начальное количество комментариев
    MORE_COMMENTS_BATCH: 10,      // Количество комментариев при подгрузке
    FETCH_RETRIES: 3,             // Количество попыток при ошибке сети
    NOTIFICATION_TIMEOUT: 10000,  // Время показа уведомления (мс)
    REFRESH_FEEDBACK_DELAY: 2000  // Время показа "Refreshed!" (мс)
};

class HackerNewsReader {
    constructor() {
        // URL для API запросов
        this.baseUrl = "https://hacker-news.firebaseio.com/v0";
        this.algoliaUrl = "https://hn.algolia.com/api/v1";

        // Текущее состояние приложения
        this.currentType = "topstories"; // Активный тип постов
        this.loadedItems = []; // ID загруженных постов (предотвращает дубликаты)
        this.currentPage = 0; // Текущая страница пагинации

        // DOM элементы
        this.postsContainer = document.getElementById("postsContainer");
        this.loadMoreBtn = document.getElementById("loadMoreBtn");
        this.checkUpdatesBtn = document.getElementById("checkUpdatesBtn");
        this.lastCheckTimeEl = document.getElementById("lastCheckTime");

        // Оптимизация производительности
        this.throttle = this.createThrottle(CONFIG.THROTTLE_DELAY); // Ограничение частоты вызовов
        this.debounce = this.createDebounce(CONFIG.DEBOUNCE_DELAY); // Задержка перед вызовом

        // Система live updates
        this.liveUpdateInterval = null; // Интервал проверки обновлений
        this.lastKnownTopId = null; // ID последнего известного топ поста

        this.init();
    }

    /**
     * Создает throttle функцию - ограничивает частоту вызовов
     */
    createThrottle(delay) {
        let lastCall = 0;
        return (func) => {
            const now = Date.now();
            if (now - lastCall >= delay) {
                lastCall = now;
                func();
            }
        };
    }

    /**
     * Создает debounce функцию - задерживает вызов
     */
    createDebounce(delay) {
        let timeoutId;
        return (func) => {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(func, delay);
        };
    }

    /**
     * Инициализация приложения
     */
    async init() {
        this.setupEventListeners();
        await this.loadPosts();
        this.startLiveUpdates();
    }

    /**
     * Настройка обработчиков событий
     */
    setupEventListeners() {
        document.querySelectorAll(".filter-btn").forEach((btn) => {
            btn.addEventListener("click", (e) => {
                this.debounce(() => {
                    document.querySelectorAll(".filter-btn").forEach((b) =>
                        b.classList.remove("active")
                    );
                    e.target.classList.add("active");
                    this.currentType = e.target.dataset.type;
                    this.resetAndLoad();
                });
            });
        });

        this.loadMoreBtn.addEventListener("click", () => {
            this.throttle(() => this.loadMorePosts());
        });

        this.checkUpdatesBtn.addEventListener("click", () => {
            this.manualUpdateCheck();
        });
    }

    /**
     * Сброс состояния и перезагрузка
     */
    async resetAndLoad() {
        if (this.liveUpdateInterval) {
            clearInterval(this.liveUpdateInterval);
        }

        this.loadedItems = [];
        this.currentPage = 0;
        this.lastKnownTopId = null;
        this.postsContainer.innerHTML = '<div class="loading">Loading posts...</div>';

        await this.loadPosts();
        this.startLiveUpdates();
    }

    /**
     * Система автоматических обновлений
     */
    startLiveUpdates() {
        if (this.liveUpdateInterval) clearInterval(this.liveUpdateInterval);
        this.checkForUpdates();
        this.liveUpdateInterval = setInterval(() => {
            this.checkForUpdates();
        }, CONFIG.LIVE_UPDATE_INTERVAL);
    }

    // Проверяет наличие новых постов, сравнивая ID последнего поста с сохранённым
    async checkForUpdates() {
        try {
            let storyIds;
            if (this.currentType === "polls") {
                const data = await this.fetchWithRetry(
                    `${this.algoliaUrl}/search_by_date?tags=poll&hitsPerPage=1`
                );
                if (data.hits && data.hits.length > 0) {
                    storyIds = [parseInt(data.hits[0].objectID)];
                }
            } else {
                const endpoint = this.currentType === "askstories" ? "askstories" : this.currentType;
                storyIds = await this.fetchWithRetry(`${this.baseUrl}/${endpoint}.json`);
            }

            this.updateLastCheckTime();

            if (storyIds && storyIds.length > 0) {
                const topId = storyIds[0];
                if (this.lastKnownTopId === null) {
                    this.lastKnownTopId = topId;
                } else if (topId !== this.lastKnownTopId) {
                    this.notifyNewPosts();
                    this.lastKnownTopId = topId;
                }
            }
        } catch (error) {
            console.error('Live update check failed:', error);
            this.lastCheckTimeEl.textContent = 'Check failed';
        }
    }

    // Ручное обновление по нажатию кнопки "Check for Updates"
    async manualUpdateCheck() {
        this.checkUpdatesBtn.classList.add('checking');
        const originalText = '🔔 Check for Updates';
        this.checkUpdatesBtn.textContent = '🔄 Refreshing...';

        await this.resetAndLoad();

        this.checkUpdatesBtn.classList.remove('checking');
        this.checkUpdatesBtn.textContent = '✅ Refreshed!';
        setTimeout(() => {
            this.checkUpdatesBtn.textContent = originalText;
        }, CONFIG.REFRESH_FEEDBACK_DELAY);
    }

    // Обновляет отображение времени последней проверки в UI
    updateLastCheckTime() {
        const now = new Date();
        this.lastCheckTimeEl.textContent = `Last checked: ${now.toLocaleTimeString()}`;
    }

    // Показывает всплывающее уведомление о новых постах
    notifyNewPosts() {
        const oldNotification = document.querySelector('.live-update-notification');
        if (oldNotification) oldNotification.remove();

        const notification = document.createElement('div');
        notification.className = 'live-update-notification';
        notification.innerHTML = `
            <span>🔔 New posts available!</span>
            <button class="refresh-btn">Refresh</button>
            <button class="close-btn">✕</button>
        `;

        document.body.appendChild(notification);
        notification.querySelector('.refresh-btn').addEventListener('click', () => {
            this.resetAndLoad();
            notification.remove();
        });
        notification.querySelector('.close-btn').addEventListener('click', () => notification.remove());
        setTimeout(() => { if (notification.parentNode) notification.remove(); }, CONFIG.NOTIFICATION_TIMEOUT);
    }

    // Выполняет HTTP запрос с автоматическими повторами при ошибке
    async fetchWithRetry(url, retries = CONFIG.FETCH_RETRIES) {
        for (let i = 0; i < retries; i++) {
            try {
                const response = await fetch(url);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return await response.json();
            } catch (error) {
                if (i === retries - 1) throw error;
                await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1)));
            }
        }
    }

    // Загружает посты с API и отображает их (поддерживает пагинацию)
    async loadPosts() {
        try {
            if (this.currentType === "polls") {
                const data = await this.fetchWithRetry(
                    `${this.algoliaUrl}/search_by_date?tags=poll&hitsPerPage=${CONFIG.ITEMS_PER_PAGE}&page=${this.currentPage}`
                );
                if (this.currentPage === 0) this.postsContainer.innerHTML = "";
                if (!data.hits || data.hits.length === 0) {
                    this.loadMoreBtn.style.display = "none";
                    return;
                }
                for (const hit of data.hits) {
                    if (hit.objectID && !this.loadedItems.includes(parseInt(hit.objectID))) {
                        const post = await this.fetchWithRetry(`${this.baseUrl}/item/${hit.objectID}.json`);
                        if (post && !post.deleted && post.type === "poll") {
                            await this.renderPost(post);
                            this.loadedItems.push(post.id);
                        }
                    }
                }
                this.currentPage++;
                this.loadMoreBtn.style.display = data.hits.length === CONFIG.ITEMS_PER_PAGE ? "block" : "none";
            } else {
                const endpoint = this.currentType === "askstories" ? "askstories" : this.currentType;
                const storyIds = await this.fetchWithRetry(`${this.baseUrl}/${endpoint}.json`);
                if (this.currentPage === 0) this.postsContainer.innerHTML = "";

                const startIndex = this.currentPage * CONFIG.ITEMS_PER_PAGE;
                const itemsToLoad = storyIds.slice(startIndex, startIndex + CONFIG.ITEMS_PER_PAGE);

                if (itemsToLoad.length === 0) {
                    this.loadMoreBtn.style.display = "none";
                    return;
                }

                const posts = await Promise.all(itemsToLoad.map(id => this.fetchWithRetry(`${this.baseUrl}/item/${id}.json`)));

                for (const post of posts) {
                    if (post && !post.deleted && post.title && !this.loadedItems.includes(post.id)) {
                        if (this.shouldRenderPost(post, this.currentType)) {
                            await this.renderPost(post);
                            this.loadedItems.push(post.id);
                        }
                    }
                }
                this.currentPage++;
                this.loadMoreBtn.style.display = itemsToLoad.length === CONFIG.ITEMS_PER_PAGE ? "block" : "none";
            }
        } catch (error) {
            console.error("Error loading posts:", error);
            this.postsContainer.innerHTML = '<div class="loading">Error loading posts.</div>';
        }
    }

    // Определяет, нужно ли отображать пост в текущей категории
    shouldRenderPost(post, currentType) {
        if (currentType === "askstories") return post.type === "story";
        if (currentType === "jobstories") return post.type === "job";
        if (currentType === "polls") return post.type === "poll";
        return post.type === "story" || post.type === "job" || post.type === "poll";
    }

    // Подгружает следующую порцию постов при нажатии "Load More"
    async loadMorePosts() {
        this.loadMoreBtn.textContent = 'Loading...';
        await this.loadPosts();
        this.loadMoreBtn.textContent = "Load More Posts";
    }

    /**
     * Отображение карточки поста с аватаркой и футером
     */
    async renderPost(item) {
        const postElement = document.createElement("div");
        postElement.className = "post";

        const postType = this.getPostType(item);
        const timeAgo = this.getTimeAgo(item.time);
        let domain = "hacker-news.org";
        if (item.url) {
            try {
                domain = new URL(item.url).hostname.replace("www.", "");
            } catch (e) {
                // Невалидный URL — используем значение по умолчанию
                domain = "hacker-news.org";
            }
        }
        const hnLink = `https://news.ycombinator.com/item?id=${item.id}`;

        let pollOptionsHTML = "";
        if (item.type === "poll" && item.parts) {
            const options = await this.loadPollOptions(item.parts);
            pollOptionsHTML = this.renderPollOptions(options);
        }

        postElement.innerHTML = `
            <div class="post-content">
                <span class="post-type ${postType}">${postType}</span>
                <h2 class="post-title">
                    <a href="${hnLink}" target="_blank" class="post-title-link">${item.title}</a>
                </h2>
                ${item.text ? `<div class="post-text">${item.text}</div>` : ""}
                ${pollOptionsHTML}
            </div>
            <div class="post-footer">
                <div class="author-info">
                    <img src="https://ui-avatars.com/api/?name=${item.by || 'A'}&background=random" class="author-avatar">
                    <div class="author-details">
                        <span class="author-name">@${item.by || 'anon'}</span>
                        <span class="author-location">📍 ${domain}</span>
                    </div>
                </div>
                <div class="post-stats">
                    ${item.descendants !== undefined ? `<span class="comments-trigger" id="trigger-${item.id}">💬 ${item.descendants}</span>` : ""}
                    <span class="post-score">⭐ ${item.score || 0}</span>
                    <span class="post-time">${timeAgo}</span>
                </div>
            </div>
            <div class="comments-section" id="comments-${item.id}" style="display: none;">
                <div class="comments-loading">Loading discussion...</div>
            </div>
        `;

        this.postsContainer.appendChild(postElement);

        const trigger = postElement.querySelector(`#trigger-${item.id}`);
        if (trigger && item.kids) {
            trigger.addEventListener('click', () => this.debounce(() => this.toggleComments(item.id, item.kids)));
        }

        if (item.url) {
            postElement.querySelector('.post-title-link').addEventListener('click', (e) => {
                if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
                    e.preventDefault();
                    window.open(item.url, '_blank');
                }
            });
        }
    }

    // Загружает варианты ответов для опроса (poll)
    async loadPollOptions(partIds) {
        const options = await Promise.all(partIds.map(id => this.fetchWithRetry(`${this.baseUrl}/item/${id}.json`)));
        return options.filter(opt => opt && opt.text).sort((a, b) => (b.score || 0) - (a.score || 0));
    }

    // Генерирует HTML для отображения вариантов опроса
    renderPollOptions(options) {
        return `<div class="poll-options">${options.map(opt => `
            <div class="poll-option">${opt.text} <span class="poll-option-score">${opt.score} votes</span></div>
        `).join('')}</div>`;
    }

    // Определяет тип поста (story, job, poll, ask)
    getPostType(item) {
        if (item.type === "job") return "job";
        if (item.type === "poll") return "poll";
        if (!item.url || item.url.includes("item?id=")) return "ask";
        return "story";
    }

    // Преобразует timestamp в читаемый формат (5m ago, 2h ago)
    getTimeAgo(timestamp) {
        const seconds = Math.floor(Date.now() / 1000 - timestamp);
        if (seconds < 60) return `${seconds}s ago`;
        if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
        if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
        return `${Math.floor(seconds / 86400)}d ago`;
    }

    // Показывает/скрывает секцию комментариев для поста
    async toggleComments(itemId, kids) {
        const section = document.getElementById(`comments-${itemId}`);
        if (section.style.display === 'none') {
            section.style.display = 'block';
            if (section.querySelector('.comments-loading')) await this.loadComments(itemId, kids, section);
        } else {
            section.style.display = 'none';
        }
    }

    // Загружает и отображает комментарии первой порцией
    async loadComments(itemId, kids, container) {
        if (!kids || kids.length === 0) {
            container.innerHTML = '<div class="no-comments">No comments yet</div>';
            return;
        }
        try {
            container.innerHTML = '<div class="comments-loading">Loading comments...</div>';
            const initialBatch = kids.slice(0, CONFIG.INITIAL_COMMENTS_BATCH);
            const remaining = kids.slice(CONFIG.INITIAL_COMMENTS_BATCH);
            const data = await this.fetchAllComments(initialBatch, 0, itemId);
            container.innerHTML = `<div class="comments-list">${this.buildCommentHTML(data, 0, itemId)}</div>`;
            if (remaining.length > 0) {
                const btn = document.createElement('button');
                btn.className = 'load-more-comments-btn';
                btn.textContent = `Load ${remaining.length} more`;
                btn.onclick = () => this.loadMoreComments(itemId, remaining, container, btn);
                container.appendChild(btn);
            }
        } catch (e) { container.innerHTML = '<div class="error">Error.</div>'; }
    }

    // Подгружает дополнительные комментарии при нажатии кнопки
    async loadMoreComments(itemId, remaining, container, btn) {
        btn.disabled = true;
        const nextBatch = remaining.slice(0, CONFIG.MORE_COMMENTS_BATCH);
        const stillLeft = remaining.slice(CONFIG.MORE_COMMENTS_BATCH);
        const data = await this.fetchAllComments(nextBatch, 0, itemId);
        container.querySelector('.comments-list').insertAdjacentHTML('beforeend', this.buildCommentHTML(data, 0, itemId));
        if (stillLeft.length > 0) {
            btn.textContent = `Load ${stillLeft.length} more`;
            btn.disabled = false;
            btn.onclick = () => this.loadMoreComments(itemId, stillLeft, container, btn);
        } else btn.remove();
    }

    // Рекурсивно загружает комментарии с вложенностью до MAX_COMMENT_DEPTH
    async fetchAllComments(kids, depth, rootId) {
        if (!kids || depth >= CONFIG.MAX_COMMENT_DEPTH) return [];
        const res = await Promise.all(kids.map(async id => {
            const c = await this.fetchWithRetry(`${this.baseUrl}/item/${id}.json`);
            if (c && !c.deleted && c.text) {
                c.children = (c.kids && depth < CONFIG.MAX_COMMENT_DEPTH - 1) ? await this.fetchAllComments(c.kids, depth + 1, rootId) : [];
                return c;
            }
            return null;
        }));
        return res.filter(c => c !== null).sort((a, b) => b.time - a.time);
    }

    // Генерирует HTML разметку для комментариев с отступами по глубине
    buildCommentHTML(comments, depth, rootId) {
        return comments.map(c => `
            <div class="comment" style="margin-left: ${depth * 20}px;">
                <div class="comment-header">
                    <span class="comment-author">👤 ${c.by}</span>
                    <span class="comment-time">🕐 ${this.getTimeAgo(c.time)}</span>
                </div>
                <div class="comment-text">${c.text}</div>
                ${c.children ? this.buildCommentHTML(c.children, depth + 1, rootId) : ""}
            </div>
        `).join('');
    }
}

const hackerNews = new HackerNewsReader();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Локальный файл — используется как быстрый кэш и запасной вариант.
const DATA_FILE = path.join(__dirname, 'data.json');
const DATA_PATH_ON_DISK = '/workaut/app-data.json';

const APP_TOKEN = process.env.APP_TOKEN;
if (!APP_TOKEN) {
  throw new Error('APP_TOKEN must be configured in the server environment');
}
const YANDEX_OAUTH_TOKEN = process.env.YANDEX_TOKEN;

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));
const allowedOrigin = process.env.FRONTEND_ORIGIN;
app.use(cors({ origin: allowedOrigin || false }));

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }
});

// ---------------------------------------------------------------------------
// Персистентное хранилище
// ---------------------------------------------------------------------------
function emptyStore() {
  return { cloudData: { dates: {}, templates: {}, comments: {}, videos: {} }, videoPaths: {} };
}

function loadLocalStore() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      cloudData: parsed.cloudData || emptyStore().cloudData,
      videoPaths: parsed.videoPaths || {}
    };
  } catch (e) {
    return emptyStore();
  }
}

function saveLocalStoreSnapshot(snapshot) {
  const tempFile = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tempFile, snapshot, 'utf-8');
  fs.renameSync(tempFile, DATA_FILE);
}

let persistQueue = Promise.resolve();
function persistStoreNow() {
  const snapshot = JSON.stringify(store, null, 2);
  persistQueue = persistQueue.then(async () => {
    saveLocalStoreSnapshot(snapshot);
    await uploadStoreToYandex(snapshot);
  });
  return persistQueue;
}

// ---------------------------------------------------------------------------
// Защита от одновременных запросов к Яндекс Диску (предотвращает DiskResourceLockedError)
let isDiskBusy = false;
async function runWithDiskLock(fn) {
  while (isDiskBusy) {
    await new Promise((r) => setTimeout(r, 500));
  }
  isDiskBusy = true;
  try {
    return await fn();
  } finally {
    isDiskBusy = false;
  }
}

async function downloadStoreFromYandex() {
  if (!YANDEX_OAUTH_TOKEN) return null;
  return await runWithDiskLock(async () => {
    try {
      const linkRes = await axiosWithRetry({
        method: 'get',
        url: 'https://cloud-api.yandex.net/v1/disk/resources/download',
        params: { path: DATA_PATH_ON_DISK },
        headers: { Authorization: `OAuth ${YANDEX_OAUTH_TOKEN}` }
      });
      const fileRes = await axiosWithRetry({ method: 'get', url: linkRes.data.href });
      const data = fileRes.data;
      return {
        cloudData: data.cloudData || emptyStore().cloudData,
        videoPaths: data.videoPaths || {}
      };
    } catch (e) {
      console.log('Не удалось загрузить data.json с Яндекс.Диска (возможно, его ещё нет):', e.response?.status || e.message);
      return null;
    }
  });
}

async function uploadStoreToYandex(snapshot = JSON.stringify(store)) {
  if (!YANDEX_OAUTH_TOKEN) return;
  await runWithDiskLock(async () => {
    const uploadUrlRes = await axiosWithRetry({
      method: 'get',
      url: 'https://cloud-api.yandex.net/v1/disk/resources/upload',
      params: { path: DATA_PATH_ON_DISK, overwrite: true },
      headers: { Authorization: `OAuth ${YANDEX_OAUTH_TOKEN}` }
    });
    await axiosWithRetry({
      method: 'put',
      url: uploadUrlRes.data.href,
      data: snapshot,
      headers: { 'Content-Type': 'application/json' },
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });
  });
}

let store = emptyStore();
let saveTimeout = null;
function saveStore() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    persistStoreNow().catch((err) => console.error('Ошибка фонового сохранения:', err.message));
  }, 1000);
}

async function initStore() {
  const remote = await downloadStoreFromYandex();
  if (remote) {
    store = remote;
    console.log('Данные загружены с Яндекс.Диска.');
  } else {
    store = loadLocalStore();
    console.log('Данные загружены из локального кэша (или созданы пустыми).');
  }
}

// ---------------------------------------------------------------------------
// Авторизация
// ---------------------------------------------------------------------------
function checkAuth(req, res, next) {
  const token = req.headers['x-app-token'];
  if (token !== APP_TOKEN) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
}

app.get('/', (req, res) => {
  res.send('WorkAut Server with Yandex Disk is running!');
});

async function axiosWithRetry(config, retries = 2) {
  try {
    return await axios({ timeout: 15000, family: 4, ...config });
  } catch (err) {
    const retryable = ['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'ENETUNREACH', 'EAI_AGAIN'].includes(err.code);
    if (retryable && retries > 0) {
      await new Promise((r) => setTimeout(r, 1500));
      return axiosWithRetry(config, retries - 1);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Яндекс.Диск (Работа с медиафайлами)
// ---------------------------------------------------------------------------
async function uploadToYandexDisk(buffer, filename) {
  if (!YANDEX_OAUTH_TOKEN) {
    throw new Error('YANDEX_TOKEN не задан на сервере (переменные окружения)');
  }

  const pathOnDisk = `/workaut/${Date.now()}-${filename}`;

  return await runWithDiskLock(async () => {
    let uploadUrl;
    try {
      const uploadUrlRes = await axiosWithRetry({
        method: 'get',
        url: 'https://cloud-api.yandex.net/v1/disk/resources/upload',
        params: { path: pathOnDisk, overwrite: true },
        headers: { Authorization: `OAuth ${YANDEX_OAUTH_TOKEN}` }
      });
      uploadUrl = uploadUrlRes.data.href;
    } catch (error) {
      console.error(`[uploadToYandexDisk] Ошибка получения upload-url (${error.response?.status}):`, error.response?.data || error.message);
      throw error;
    }

    try {
      await axiosWithRetry({
        method: 'put',
        url: uploadUrl,
        data: buffer,
        headers: { 'Content-Type': 'application/octet-stream' },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 120000
      });
    } catch (error) {
      console.error(`[uploadToYandexDisk] Ошибка загрузки файла (${error.response?.status}):`, error.response?.data || error.message);
      throw error;
    }

    try {
      await axiosWithRetry({
        method: 'put',
        url: 'https://cloud-api.yandex.net/v1/disk/resources/publish',
        params: { path: pathOnDisk },
        headers: { Authorization: `OAuth ${YANDEX_OAUTH_TOKEN}` }
      });
    } catch (error) {
      console.error(`[uploadToYandexDisk] Ошибка публикации файла (${error.response?.status}):`, error.response?.data || error.message);
      throw error;
    }

    let resourceRes;
    try {
      resourceRes = await axiosWithRetry({
        method: 'get',
        url: 'https://cloud-api.yandex.net/v1/disk/resources',
        params: { path: pathOnDisk },
        headers: { Authorization: `OAuth ${YANDEX_OAUTH_TOKEN}` }
      });
    } catch (error) {
      console.error(`[uploadToYandexDisk] Ошибка получения инфо о файле (${error.response?.status}):`, error.response?.data || error.message);
      throw error;
    }

    return { publicUrl: resourceRes.data.public_url, diskPath: pathOnDisk };
  });
}

async function deleteFromYandexDisk(pathOnDisk) {
  if (!pathOnDisk) return true;
  if (!YANDEX_OAUTH_TOKEN) return false;
  return await runWithDiskLock(async () => {
    try {
      await axiosWithRetry({
        method: 'delete',
        url: 'https://cloud-api.yandex.net/v1/disk/resources',
        params: { path: pathOnDisk, permanently: true },
        headers: { Authorization: `OAuth ${YANDEX_OAUTH_TOKEN}` }
      });
      return true;
    } catch (error) {
      console.error('Ошибка при удалении с Яндекс Диска:', error.response?.data || error.message);
      return false;
    }
  });
}

// ---------------------------------------------------------------------------
// Роуты приложения
// ---------------------------------------------------------------------------
app.get('/api/data', checkAuth, (req, res) => {
  res.status(200).json(store.cloudData);
});

app.post('/api/data', checkAuth, async (req, res) => {
  try {
    const body = req.body || {};
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ success: false, error: 'Invalid data object' });
    }
    store.cloudData = {
      dates: body.dates && typeof body.dates === 'object' ? body.dates : {},
      templates: body.templates && typeof body.templates === 'object' ? body.templates : {},
      comments: body.comments && typeof body.comments === 'object' ? body.comments : {},
      videos: body.videos && typeof body.videos === 'object' ? body.videos : {}
    };
    await persistStoreNow();
    res.status(200).json({ success: true, data: store.cloudData });
  } catch (error) {
    console.error('Ошибка сохранения данных:', error.message);
    res.status(500).json({ success: false, error: 'Не удалось сохранить данные' });
  }
});

app.post('/api/workout', checkAuth, upload.any(), async (req, res) => {
  try {
    const key = req.body.key;
    let videoUrl = null;
    let thumbUrl = null;

    if (req.files && req.files.length > 0) {
      if (key) {
        if (!store.videoPaths[key]) store.videoPaths[key] = {};
      }

      for (const file of req.files) {
        console.log(`Загрузка ${file.fieldname} на Яндекс Диск...`);
        const { publicUrl, diskPath } = await uploadToYandexDisk(file.buffer, file.originalname);

        if (file.fieldname === 'video') {
          videoUrl = publicUrl;
          if (key) store.videoPaths[key].videoPath = diskPath;
        } else if (file.fieldname === 'thumbnail') {
          thumbUrl = publicUrl;
          if (key) store.videoPaths[key].thumbPath = diskPath;
        }
      }
      if (key) {
        if (!store.cloudData.videos || typeof store.cloudData.videos !== 'object') {
          store.cloudData.videos = {};
        }
        store.cloudData.videos[key] = { hasVideo: true };
      }
      await persistStoreNow();
    }

    const urls = (videoUrl || thumbUrl) ? { videoUrl, thumbUrl } : null;

    res.status(200).json({
      success: true,
      message: 'Saved successfully to Yandex Disk',
      key,
      video: store.videoPaths[key] || null,
      urls
    });
  } catch (error) {
    console.error('Ошибка при сохранении:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Исправленный эндпоинт с прямым редиректом на Яндекс.Диск
app.get('/api/media/:type/:key', async (req, res) => {
  if (req.query.token !== APP_TOKEN) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const { type, key } = req.params;
  const decodedKey = decodeURIComponent(key);
  const paths = store.videoPaths[decodedKey];
  if (!paths) return res.status(404).json({ success: false, error: 'Not found' });

  const diskPath = type === 'video' ? paths.videoPath : paths.thumbPath;
  if (!diskPath || !YANDEX_OAUTH_TOKEN) return res.status(404).json({ success: false, error: 'Not found' });

  try {
    const linkRes = await axiosWithRetry({
      method: 'get',
      url: 'https://cloud-api.yandex.net/v1/disk/resources/download',
      params: { path: diskPath },
      headers: { Authorization: `OAuth ${YANDEX_OAUTH_TOKEN}` }
    });
    
    // Перенаправляем браузер сразу на реальный медиафайл в облаке
    return res.redirect(302, linkRes.data.href);
  } catch (error) {
    console.error('Ошибка получения прямой ссылки на медиа:', error.response?.data || error.message);
    res.status(504).json({ success: false, error: 'Не удалось получить ссылку с Яндекс.Диска' });
  }
});

// Эндпоинт для безопасной потоковой передачи (стриминга) видео через прокси
app.get('/api/stream/:type/:key', async (req, res) => {
  try {
    const { type } = req.params;
    const decodedKey = decodeURIComponent(req.params.key);
    const token = req.query.token;

    if (token !== APP_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const paths = store.videoPaths && store.videoPaths[decodedKey];
    if (!paths) {
      console.warn(`[Stream 404] Ключ не найден в videoPaths: "${decodedKey}"`);
      return res.status(404).json({ error: 'File not found in store' });
    }

    const diskPath = type === 'video' ? paths.videoPath : paths.thumbPath;
    if (!diskPath || !YANDEX_OAUTH_TOKEN) {
      return res.status(404).json({ error: 'Disk path or token missing' });
    }

    const yaRes = await axiosWithRetry({
      method: 'get',
      url: 'https://cloud-api.yandex.net/v1/disk/resources/download',
      params: { path: diskPath },
      headers: { Authorization: `OAuth ${YANDEX_OAUTH_TOKEN}` }
    });

    const downloadUrl = yaRes.data.href;

    const response = await axiosWithRetry({
      method: 'get',
      url: downloadUrl,
      responseType: 'stream',
      timeout: 60000
    });

    if (response.headers['content-type']) {
      res.setHeader('Content-Type', response.headers['content-type']);
    }
    if (response.headers['content-length']) {
      res.setHeader('Content-Length', response.headers['content-length']);
    }

    response.data.on('error', (err) => {
      console.error('Ошибка передачи потока (stream error):', err.message);
      if (!res.headersSent) {
        res.status(500).send('Ошибка передачи потока');
      } else {
        res.end();
      }
    });

    response.data.pipe(res);

  } catch (error) {
    console.error('Ошибка в эндпоинте стриминга:', error.response?.data || error.message);
    if (!res.headersSent) {
      if (error.response && error.response.status === 404) {
        return res.status(404).json({ error: 'File not found on Yandex Disk' });
      }
      res.status(500).json({ error: 'Не удалось загрузить медиафайл' });
    }
  }
});

app.post('/api/delete-video', checkAuth, async (req, res) => {
  try {
    const { key } = req.body;
    if (!key) {
      return res.status(400).json({ success: false, error: 'key is required' });
    }

    const paths = store.videoPaths[key];
    if (paths) {
      const videoDeleted = await deleteFromYandexDisk(paths.videoPath);
      const thumbDeleted = await deleteFromYandexDisk(paths.thumbPath);
      if (!videoDeleted || !thumbDeleted) {
        return res.status(502).json({ success: false, error: 'Не удалось полностью удалить файл' });
      }
      delete store.videoPaths[key];
      if (store.cloudData.videos) delete store.cloudData.videos[key];
      if (store.cloudData.comments) delete store.cloudData.comments[key];
      await persistStoreNow();
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Ошибка при удалении видео:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

initStore().then(() => {
  const server = app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    if (!YANDEX_OAUTH_TOKEN) {
      console.warn('ВНИМАНИЕ: переменная окружения YANDEX_TOKEN не задана — загрузка видео и сохранение данных на Диск работать не будут.');
    }
  });

  server.timeout = 300000;
  server.keepAliveTimeout = 300000;
});

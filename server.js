const express = require('express');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const PORT = process.env.PORT || 3000;

// Локальный файл — используется как быстрый кэш и запасной вариант.
const DATA_FILE = path.join(__dirname, 'data.json');
const DATA_PATH_ON_DISK = '/workaut/app-data.json';

const APP_TOKEN = process.env.APP_TOKEN || '1234';
const YANDEX_OAUTH_TOKEN = process.env.YANDEX_TOKEN;

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));
app.use(cors());

// Файлы пишутся сразу на диск, а не держатся целиком в RAM — иначе на бесплатном Render
// (мало памяти) видео + его копия для ffmpeg вместе могли вызвать падение процесса по OOM.
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, os.tmpdir()),
  filename: (req, file, cb) => {
    const uniq = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    cb(null, `upload_${uniq}${path.extname(file.originalname) || ''}`);
  }
});
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

// Раньше store.videoPaths[key] был одним объектом {videoPath, thumbPath} — теперь это массив
// (несколько видео на упражнение). Эта функция приводит старые записи к новому формату на лету,
// так что уже загруженные видео не потеряются.
function getVideoEntries(key) {
  const existing = store.videoPaths[key];
  if (!existing) return [];
  if (Array.isArray(existing)) return existing;
  // старый формат — один объект без id
  const migrated = [{ id: 'legacy', videoPath: existing.videoPath, thumbPath: existing.thumbPath }];
  store.videoPaths[key] = migrated;
  return migrated;
}

function generateVideoId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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

function saveLocalStore() {
  fs.writeFile(DATA_FILE, JSON.stringify(store, null, 2), (err) => {
    if (err) console.error('Ошибка сохранения локального кэша data.json:', err);
  });
}

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
      const linkRes = await axios.get(
        'https://cloud-api.yandex.net/v1/disk/resources/download',
        {
          params: { path: DATA_PATH_ON_DISK },
          headers: { Authorization: `OAuth ${YANDEX_OAUTH_TOKEN}` }
        }
      );
      const fileRes = await axios.get(linkRes.data.href);
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

async function uploadStoreToYandex() {
  if (!YANDEX_OAUTH_TOKEN) return;
  await runWithDiskLock(async () => {
    try {
      const uploadUrlRes = await axios.get(
        'https://cloud-api.yandex.net/v1/disk/resources/upload',
        {
          params: { path: DATA_PATH_ON_DISK, overwrite: true },
          headers: { Authorization: `OAuth ${YANDEX_OAUTH_TOKEN}` }
        }
      );
      await axios.put(uploadUrlRes.data.href, JSON.stringify(store), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (e) {
      console.error('Ошибка сохранения data.json на Яндекс.Диск:', e.response?.data || e.message);
    }
  });
}

let store = emptyStore();
let saveTimeout = null;

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

function saveStore() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    saveLocalStore();
    uploadStoreToYandex();
  }, 1000);
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
// ---------------------------------------------------------------------------
// Сжатие видео перед загрузкой (чтобы не тащить на Диск исходники в 100+ МБ с телефона)
// Работает с путём к файлу на диске — не грузит его целиком в память лишний раз.
// ---------------------------------------------------------------------------
const COMPRESS_SKIP_THRESHOLD = 15 * 1024 * 1024; // маленькие файлы не трогаем

async function compressVideoFile(inputPath, fileSize) {
  if (fileSize < COMPRESS_SKIP_THRESHOLD) {
    return { path: inputPath, size: fileSize, isNew: false };
  }

  const outputPath = path.join(os.tmpdir(), `out_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp4`);

  try {
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .videoCodec('libx264')
        .outputOptions([
          '-crf 30',
          '-preset ultrafast', // минимум памяти/CPU — критично на бесплатном Render (мало RAM)
          '-threads 1',
          "-vf scale='min(960,iw)':-2", // не увеличиваем, только уменьшаем широкую сторону до 960px
          '-movflags +faststart'
        ])
        .audioCodec('aac')
        .audioBitrate('96k')
        .on('error', reject)
        .on('end', resolve)
        .save(outputPath);
    });

    const compressedSize = fs.statSync(outputPath).size;
    console.log(`[compressVideo] ${(fileSize / 1024 / 1024).toFixed(1)} МБ → ${(compressedSize / 1024 / 1024).toFixed(1)} МБ`);

    if (compressedSize > 0 && compressedSize < fileSize) {
      return { path: outputPath, size: compressedSize, isNew: true };
    }
    // сжатие не помогло — используем оригинал, лишний файл подчищаем
    try { fs.unlinkSync(outputPath); } catch (e) {}
    return { path: inputPath, size: fileSize, isNew: false };
  } catch (e) {
    console.error('[compressVideo] Ошибка сжатия, загружаем оригинал без изменений:', e.message);
    try { fs.unlinkSync(outputPath); } catch (e2) {}
    return { path: inputPath, size: fileSize, isNew: false };
  }
}

async function uploadToYandexDisk(filePath, fileSize, filename) {
  if (!YANDEX_OAUTH_TOKEN) {
    throw new Error('YANDEX_TOKEN не задан на сервере (переменные окружения)');
  }

  const pathOnDisk = `/workaut/${Date.now()}-${filename}`;

  return await runWithDiskLock(async () => {
    // Получаем ссылку на загрузку и сразу заливаем файл — если что-то пошло не так
    // (например, ссылка протухла, пока грузился большой файл), пробуем ЗАНОВО с нуля,
    // с новой ссылкой, а не повторяем PUT со старой (уже нерабочей) ссылкой.
    let lastError;
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
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
        console.error(`[uploadToYandexDisk] Попытка ${attempt}: ошибка получения upload-url (${error.response?.status}):`, error.response?.data || error.message);
        lastError = error;
        continue;
      }

      try {
        // Новый поток чтения на каждую попытку — предыдущий, если был, уже "использован"
        await axiosWithRetry({
          method: 'put',
          url: uploadUrl,
          data: fs.createReadStream(filePath),
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': fileSize
          },
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          timeout: 180000
        }, 0); // саму отправку файла не ретраим с тем же href — при неудаче берём ссылку заново (см. цикл выше)
        lastError = null;
        break; // успех
      } catch (error) {
        console.error(`[uploadToYandexDisk] Попытка ${attempt}: ошибка загрузки файла (${error.response?.status}):`, error.response?.data || error.message);
        lastError = error;
      }
    }
    if (lastError) throw lastError;

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
  if (!pathOnDisk || !YANDEX_OAUTH_TOKEN) return;
  await runWithDiskLock(async () => {
    try {
      await axiosWithRetry({
        method: 'delete',
        url: 'https://cloud-api.yandex.net/v1/disk/resources',
        params: { path: pathOnDisk, permanently: true },
        headers: { Authorization: `OAuth ${YANDEX_OAUTH_TOKEN}` }
      });
    } catch (error) {
      console.error('Ошибка при удалении с Яндекс Диска:', error.response?.data || error.message);
    }
  });
}

// ---------------------------------------------------------------------------
// Роуты приложения
// ---------------------------------------------------------------------------
app.get('/api/data', checkAuth, (req, res) => {
  res.status(200).json(store.cloudData);
});

app.post('/api/data', checkAuth, (req, res) => {
  store.cloudData = req.body;
  saveStore();
  res.status(200).json({ success: true });
});

app.post('/api/workout', checkAuth, (req, res, next) => {
  upload.any()(req, res, (err) => {
    if (err) {
      console.error('[Multer] Ошибка приёма файла:', err.message);
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? 'Файл слишком большой (лимит 100 МБ). Попробуйте снять видео покороче или в меньшем качестве.'
        : `Ошибка загрузки файла: ${err.message}`;
      return res.status(400).json({ success: false, error: message });
    }
    next();
  });
}, async (req, res) => {
  const tempFilesToClean = [];
  try {
    const key = req.body.key;
    let videoDiskPath = null;
    let thumbDiskPath = null;

    if (req.files && req.files.length > 0 && key) {
      for (const file of req.files) {
        // multer.diskStorage уже сохранил файл на диск — чистим его в любом случае в конце
        tempFilesToClean.push(file.path);

        console.log(`Загрузка ${file.fieldname} на Яндекс Диск...`);

        let uploadPath = file.path;
        let uploadSize = file.size;

        if (file.fieldname === 'video') {
          console.log(`Сжатие видео (${(file.size / 1024 / 1024).toFixed(1)} МБ)...`);
          const compressed = await compressVideoFile(file.path, file.size);
          uploadPath = compressed.path;
          uploadSize = compressed.size;
          if (compressed.isNew) tempFilesToClean.push(compressed.path);
        }

        const { diskPath } = await uploadToYandexDisk(uploadPath, uploadSize, file.originalname);

        if (file.fieldname === 'video') {
          videoDiskPath = diskPath;
        } else if (file.fieldname === 'thumbnail') {
          thumbDiskPath = diskPath;
        }
      }

      const entries = getVideoEntries(key);
      const newId = generateVideoId();
      entries.push({ id: newId, videoPath: videoDiskPath, thumbPath: thumbDiskPath });
      store.videoPaths[key] = entries;

      saveStore();

      return res.status(200).json({
        success: true,
        message: 'Saved successfully to Yandex Disk',
        id: newId
      });
    }

    res.status(200).json({ success: true, message: 'Nothing to upload', id: null });
  } catch (error) {
    console.error('Ошибка при сохранении:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.message });
  } finally {
    // Временные файлы (исходник от multer + сжатую копию) подчищаем всегда, успех это был или нет
    for (const p of tempFilesToClean) {
      try { fs.unlinkSync(p); } catch (e) {}
    }
  }
});

// Эндпоинт для безопасной потоковой передачи (стриминга) видео через прокси
app.get('/api/stream/:type/:key/:id?', async (req, res) => {
  try {
    const { type } = req.params;
    const decodedKey = decodeURIComponent(req.params.key);
    const videoId = req.params.id;
    const token = req.query.token;

    if (token !== APP_TOKEN) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const entries = getVideoEntries(decodedKey);
    if (entries.length === 0) {
      console.warn(`[Stream 404] Ключ не найден в videoPaths: "${decodedKey}"`);
      return res.status(404).json({ error: 'File not found in store' });
    }

    // Если id не передан (старые ссылки) — берём первое видео для совместимости
    const entry = videoId ? entries.find((e) => e.id === videoId) : entries[0];
    if (!entry) return res.status(404).json({ error: 'Video id not found' });

    const diskPath = type === 'video' ? entry.videoPath : entry.thumbPath;
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
    const { key, id } = req.body;
    if (!key) {
      return res.status(400).json({ success: false, error: 'key is required' });
    }

    const entries = getVideoEntries(key);
    if (entries.length > 0) {
      // id не передан — для совместимости со старыми вызовами удаляем всё, что есть на этом ключе
      const toDelete = id ? entries.filter((e) => e.id === id) : entries;
      const remaining = id ? entries.filter((e) => e.id !== id) : [];

      for (const entry of toDelete) {
        await deleteFromYandexDisk(entry.videoPath);
        await deleteFromYandexDisk(entry.thumbPath);
      }

      if (remaining.length > 0) {
        store.videoPaths[key] = remaining;
      } else {
        delete store.videoPaths[key];
      }
      saveStore();
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

  server.timeout = 600000;
  server.keepAliveTimeout = 600000;
});

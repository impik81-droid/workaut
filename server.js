const express = require('express');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Файл, в котором храним все данные приложения (переживает обычные рестарты процесса,
// но НЕ переживает передеплой на бесплатном плане Render — там диск эфемерный).
const DATA_FILE = path.join(__dirname, 'data.json');

// Простой общий секрет для защиты API. По умолчанию совпадает с паролем на фронте (1234),
// чтобы всё сразу работало. Рекомендуется задать свой APP_TOKEN в переменных окружения Render.
const APP_TOKEN = process.env.APP_TOKEN || '1234';
const YANDEX_OAUTH_TOKEN = process.env.YANDEX_TOKEN;

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));
app.use(cors());

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }
});

// ---------------------------------------------------------------------------
// Персистентное хранилище
// ---------------------------------------------------------------------------
function loadStore() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      cloudData: parsed.cloudData || { dates: {}, templates: {}, comments: {}, videos: {} },
      videoPaths: parsed.videoPaths || {}
    };
  } catch (e) {
    return { cloudData: { dates: {}, templates: {}, comments: {}, videos: {} }, videoPaths: {} };
  }
}

let store = loadStore();
let saveTimeout = null;

function saveStore() {
  // небольшой дебаунс, чтобы не писать на диск при каждом нажатии клавиши
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify(store, null, 2), (err) => {
      if (err) console.error('Ошибка сохранения data.json:', err);
    });
  }, 200);
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

// ---------------------------------------------------------------------------
// Яндекс.Диск
// ---------------------------------------------------------------------------
async function uploadToYandexDisk(buffer, filename) {
  if (!YANDEX_OAUTH_TOKEN) {
    throw new Error('YANDEX_TOKEN не задан на сервере (переменные окружения)');
  }

  const pathOnDisk = `/workaut/${Date.now()}-${filename}`;

  const uploadUrlRes = await axios.get(
    `https://cloud-api.yandex.net/v1/disk/resources/upload?path=${encodeURIComponent(pathOnDisk)}&overwrite=true`,
    { headers: { Authorization: `OAuth ${YANDEX_OAUTH_TOKEN}` } }
  );

  const uploadUrl = uploadUrlRes.data.href;

  await axios.put(uploadUrl, buffer, {
    headers: { 'Content-Type': 'application/octet-stream' },
    maxContentLength: Infinity,
    maxBodyLength: Infinity
  });

  await axios.put(
    `https://cloud-api.yandex.net/v1/disk/resources/publish?path=${encodeURIComponent(pathOnDisk)}`,
    {},
    { headers: { Authorization: `OAuth ${YANDEX_OAUTH_TOKEN}` } }
  );

  const resourceRes = await axios.get(
    `https://cloud-api.yandex.net/v1/disk/resources?path=${encodeURIComponent(pathOnDisk)}`,
    { headers: { Authorization: `OAuth ${YANDEX_OAUTH_TOKEN}` } }
  );

  return { publicUrl: resourceRes.data.public_url, diskPath: pathOnDisk };
}

async function deleteFromYandexDisk(pathOnDisk) {
  if (!pathOnDisk || !YANDEX_OAUTH_TOKEN) return;
  try {
    await axios.delete(
      `https://cloud-api.yandex.net/v1/disk/resources?path=${encodeURIComponent(pathOnDisk)}&permanently=true`,
      { headers: { Authorization: `OAuth ${YANDEX_OAUTH_TOKEN}` } }
    );
  } catch (error) {
    console.error('Ошибка при удалении с Яндекс Диска:', error.response?.data || error.message);
  }
}

// ---------------------------------------------------------------------------
// Полное состояние приложения (даты, шаблоны, комментарии, ссылки на видео)
// ---------------------------------------------------------------------------
app.get('/api/data', checkAuth, (req, res) => {
  res.status(200).json(store.cloudData);
});

app.post('/api/data', checkAuth, (req, res) => {
  store.cloudData = req.body;
  saveStore();
  res.status(200).json({ success: true });
});

// ---------------------------------------------------------------------------
// Загрузка видео
// ---------------------------------------------------------------------------
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
      saveStore();
    }

    const urls = (videoUrl || thumbUrl) ? { videoUrl, thumbUrl } : null;

    res.status(200).json({
      success: true,
      message: 'Saved successfully to Yandex Disk',
      urls
    });
  } catch (error) {
    console.error('Ошибка при сохранении:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// Удаление видео (реально удаляет файлы с Яндекс.Диска)
// ---------------------------------------------------------------------------
app.post('/api/delete-video', checkAuth, async (req, res) => {
  try {
    const { key } = req.body;
    if (!key) {
      return res.status(400).json({ success: false, error: 'key is required' });
    }

    const paths = store.videoPaths[key];
    if (paths) {
      await deleteFromYandexDisk(paths.videoPath);
      await deleteFromYandexDisk(paths.thumbPath);
      delete store.videoPaths[key];
      saveStore();
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Ошибка при удалении видео:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

const server = app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  if (!YANDEX_OAUTH_TOKEN) {
    console.warn('ВНИМАНИЕ: переменная окружения YANDEX_TOKEN не задана — загрузка видео работать не будет.');
  }
});

server.timeout = 300000;
server.keepAliveTimeout = 300000;

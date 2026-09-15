const express = require('express');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_FILE = path.join(__dirname, 'data.json');
const DATA_PATH_ON_DISK = '/workaut/app-data.json';

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

function saveLocalStore() {
  fs.writeFile(DATA_FILE, JSON.stringify(store, null, 2), (err) => {
    if (err) console.error('Ошибка сохранения локального кэша data.json:', err);
  });
}

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
      const params = new URLSearchParams({ path: DATA_PATH_ON_DISK });
      const linkRes = await axios.get(
        `https://cloud-api.yandex.net/v1/disk/resources/download?${params.toString()}`,
        { headers: { Authorization: `OAuth ${YANDEX_OAUTH_TOKEN}` } }
      );
      const fileRes = await axios.get(linkRes.data.href);
      const data = fileRes.data;
      return {
        cloudData: data.cloudData || emptyStore().cloudData,
        videoPaths: data.videoPaths || {}
      };
    } catch (e) {
      return null;
    }
  });
}

async function uploadStoreToYandex() {
  if (!YANDEX_OAUTH_TOKEN) return;
  await runWithDiskLock(async () => {
    try {
      const params = new URLSearchParams({ path: DATA_PATH_ON_DISK, overwrite: 'true' });
      const uploadUrlRes = await axios.get(
        `https://cloud-api.yandex.net/v1/disk/resources/upload?${params.toString()}`,
        { headers: { Authorization: `OAuth ${YANDEX_OAUTH_TOKEN}` } }
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
    console.log('Данные загружены из локального кэша.');
  }
}

function saveStore() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    saveLocalStore();
    uploadStoreToYandex();
  }, 1000);
}

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

async function axiosWithRetry(config, retries = 3) {
  try {
    return await axios({ timeout: 20000, family: 4, ...config });
  } catch (err) {
    const retryable = ['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'ENETUNREACH', 'EAI_AGAIN'].includes(err.code);
    if (retryable && retries > 0) {
      await new Promise((r) => setTimeout(r, 2000));
      return axiosWithRetry(config, retries - 1);
    }
    throw err;
  }
}

async function uploadAndGetDirectLink(buffer, originalname) {
  if (!YANDEX_OAUTH_TOKEN) {
    throw new Error('YANDEX_TOKEN не задан на сервере');
  }

  const safeName = Buffer.from(originalname, 'latin1').toString('utf8').replace(/[^a-zA-Z0-9_.-]/g, '_');
  const pathOnDisk = `/workaut/${Date.now()}-${safeName}`;

  console.log(`Сформирован путь на диске: ${pathOnDisk}`);

  return await runWithDiskLock(async () => {
    // 1. Получаем урл для загрузки через URLSearchParams
    const uploadParams = new URLSearchParams({ path: pathOnDisk, overwrite: 'true' });
    const uploadUrlRes = await axiosWithRetry({
      method: 'get',
      url: `https://cloud-api.yandex.net/v1/disk/resources/upload?${uploadParams.toString()}`,
      headers: { Authorization: `OAuth ${YANDEX_OAUTH_TOKEN}` }
    });

    // 2. Загружаем сам файл
    await axiosWithRetry({
      method: 'put',
      url: uploadUrlRes.data.href,
      data: buffer,
      headers: { 'Content-Type': 'application/octet-stream' },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      timeout: 120000
    });

    // 3. Публикуем файл
    const publishParams = new URLSearchParams({ path: pathOnDisk });
    await axiosWithRetry({
      method: 'put',
      url: `https://cloud-api.yandex.net/v1/disk/resources/publish?${publishParams.toString()}`,
      headers: { Authorization: `OAuth ${YANDEX_OAUTH_TOKEN}` }
    });

    // 4. Получаем public_url
    const resourceParams = new URLSearchParams({ path: pathOnDisk });
    const resourceRes = await axiosWithRetry({
      method: 'get',
      url: `https://cloud-api.yandex.net/v1/disk/resources?${resourceParams.toString()}`,
      headers: { Authorization: `OAuth ${YANDEX_OAUTH_TOKEN}` }
    });

    const publicUrl = resourceRes.data.public_url;

    // 5. Получаем постоянную прямую ссылку
    const getLinkParams = new URLSearchParams({ public_key: publicUrl });
    const getLinkRes = await axiosWithRetry({
      method: 'get',
      url: `https://cloud-api.yandex.net/v1/disk/resources/download?${getLinkParams.toString()}`,
      headers: { Authorization: `OAuth ${YANDEX_OAUTH_TOKEN}` }
    });

    return {
      diskPath: pathOnDisk,
      directUrl: getLinkRes.data.href
    };
  });
}

async function deleteFromYandexDisk(pathOnDisk) {
  if (!pathOnDisk || !YANDEX_OAUTH_TOKEN) return;
  await runWithDiskLock(async () => {
    try {
      const deleteParams = new URLSearchParams({ path: pathOnDisk, permanently: 'true' });
      await axiosWithRetry({
        method: 'delete',
        url: `https://cloud-api.yandex.net/v1/disk/resources?${deleteParams.toString()}`,
        headers: { Authorization: `OAuth ${YANDEX_OAUTH_TOKEN}` }
      });
    } catch (error) {
      console.error('Ошибка при удалении с Яндекс Диска:', error.message);
    }
  });
}

app.get('/api/data', checkAuth, (req, res) => {
  res.status(200).json(store.cloudData);
});

app.post('/api/data', checkAuth, (req, res) => {
  store.cloudData = req.body;
  saveStore();
  res.status(200).json({ success: true });
});

// Загрузка видео
app.post('/api/workout', checkAuth, upload.any(), async (req, res) => {
  try {
    const key = req.body.key;
    if (key && !store.videoPaths[key]) {
      store.videoPaths[key] = {};
    }

    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        console.log(`Загрузка ${file.fieldname} на Яндекс Диск...`);
        const { diskPath, directUrl } = await uploadAndGetDirectLink(file.buffer, file.originalname);

        if (file.fieldname === 'video') {
          if (key) {
            store.videoPaths[key].videoPath = diskPath;
            store.videoPaths[key].videoDirectUrl = directUrl;
          }
        } else if (file.fieldname === 'thumbnail') {
          if (key) {
            store.videoPaths[key].thumbPath = diskPath;
            store.videoPaths[key].thumbDirectUrl = directUrl;
          }
        }
      }
      saveStore();
    }

    res.status(200).json({ success: true, message: 'Saved successfully' });
  } catch (error) {
    console.error('Ошибка при сохранении:', error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/media/:type/:key', async (req, res) => {
  if (req.query.token !== APP_TOKEN) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const { type, key } = req.params;
  const decodedKey = decodeURIComponent(key);
  const paths = store.videoPaths[decodedKey];
  if (!paths) return res.status(404).json({ success: false, error: 'Not found' });

  const directUrl = type === 'video' ? paths.videoDirectUrl : paths.thumbDirectUrl;
  if (!directUrl) return res.status(404).json({ success: false, error: 'Direct URL not found' });

  res.status(200).json({ success: true, url: directUrl });
});

app.post('/api/delete-video', checkAuth, async (req, res) => {
  try {
    const { key }  = req.body;
    if (!key) {
      return res.status(400).json({ success: false, error: 'key is required' });
    }

    const paths = store.videoPaths[key];
    if (paths) {
      await deleteFromYandexDisk(paths.videoPath);
      await deleteFromYungeonsDisk ? deleteFromYandexDisk(paths.thumbPath) : await deleteFromYandexDisk(paths.thumbPath);
      delete store.videoPaths[key];
      saveStore();
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Ошибка при удалении видео:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

initStore().then(() => {
  const server = app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
  server.timeout = 300000;
  server.keepAliveTimeout = 300000;
});

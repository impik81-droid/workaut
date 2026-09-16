const express = require('express');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Настройка токена и Яндекс.Диска
const YANDEX_TOKEN = process.env.YANDEX_TOKEN || 'ВАШ_ТОКЕН_ЯНДЕКС_ДИСКА';
const APP_TOKEN = process.env.APP_TOKEN || '1234';

// Настройка Multer для сохранения во временную папку ОС (вместо memoryStorage)
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, os.tmpdir());
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
      cb(null, uniqueSuffix + path.extname(file.originalname));
    }
  }),
  limits: { fileSize: 200 * 1024 * 1024 } // Лимит до 200 МБ для видео с телефона
});

// Проверка токена авторизации
const checkAuth = (req, res, next) => {
  const token = req.headers['x-app-token'] || req.query.token;
  if (!token || token !== APP_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// Механизм защиты Яндекс.Диска от одновременных запросов
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

// Повторные попытки при ошибках сети
async function axiosWithRetry(config, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await axios(config);
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, delay * (i + 1)));
    }
  }
}

// Эндпоинт загрузки видео
app.post('/api/workout', checkAuth, upload.single('video'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Файл не найден' });
  }

  const filePath = req.file.path;
  const fileName = req.file.filename;
  const targetPath = `/app_data/videos/${fileName}`;

  try {
    // 1. Создаем папку на Яндекс.Диске (если не существует)
    await runWithDiskLock(async () => {
      try {
        await axiosWithRetry({
          method: 'PUT',
          url: `https://cloud-api.yandex.net/v1/disk/resources?path=${encodeURIComponent('/app_data/videos')}`,
          headers: { Authorization: `OAuth ${YANDEX_TOKEN}` }
        });
      } catch (e) {
        // Папка уже может существовать, это нормально
      }
    });

    // 2. Получаем ссылку для загрузки файла на Яндекс.Диск
    const uploadUrlRes = await runWithDiskLock(async () => {
      return await axiosWithRetry({
        method: 'GET',
        url: `https://cloud-api.yandex.net/v1/disk/resources/upload?path=${encodeURIComponent(targetPath)}&overwrite=true`,
        headers: { Authorization: `OAuth ${YANDEX_TOKEN}` }
      });
    });

    const uploadUrl = uploadUrlRes.data.href;

    // 3. Загружаем файл с локального диска сервера на Яндекс.Диск с помощью потока (stream)
    const fileStream = fs.createReadStream(filePath);
    await axiosWithRetry({
      method: 'PUT',
      url: uploadUrl,
      data: fileStream,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      headers: { 'Content-Type': 'application/octet-stream' },
      timeout: 120000 // 2 минуты таймаут для медленного интернета
    });

    // Удаляем временный файл с диска сервера
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    res.json({ success: true, url: targetPath, filename: fileName });

  } catch (err) {
    console.error('Ошибка при загрузке файла на Яндекс.Диск:', err.message);
    
    // Обязательно удаляем временный файл в случае ошибки
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    res.status(500).json({ error: 'Не удалось загрузить файл: ' + err.message });
  }
});

// Запуск сервера (порт можно настроить под ваш хостинг)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});

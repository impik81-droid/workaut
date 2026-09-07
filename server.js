const express = require('express');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Увеличиваем лимиты для загрузки видео
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
app.use(cors());

// Храним файлы временно в оперативной памяти
const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: { fileSize: 100 * 1024 * 1024 }
});

let workoutData = {};

// Токен подтягивается из переменных окружения Render
const YANDEX_OAUTH_TOKEN = process.env.YANDEX_TOKEN;

app.get('/', (req, res) => {
    res.send("WorkAut Server with Yandex Disk is running!");
});

// Функция для загрузки файла на Яндекс Диск
async function uploadToYandexDisk(buffer, filename) {
    try {
        const folderName = 'app_workouts';
        const pathOnDisk = `${folderName}/${Date.now()}-${filename}`;
        
        // 0. Создаем папку app_workouts (если она уже есть, игнорируем ошибку 409)
        try {
            await axios.put(
                `https://cloud-api.yandex.net/v1/disk/resources?path=${encodeURIComponent(folderName)}`,
                {},
                { headers: { 'Authorization': `OAuth ${YANDEX_OAUTH_TOKEN}` } }
            );
        } catch (folderError) {
            if (folderError.response?.status !== 409) {
                console.log("Папка уже существует или создана");
            }
        }

        // 1. Получаем ссылку для загрузки
        const uploadUrlRes = await axios.get(
            `https://cloud-api.yandex.net/v1/disk/resources/upload?path=${encodeURIComponent(pathOnDisk)}&overwrite=true`,
            { headers: { 'Authorization': `OAuth ${YANDEX_OAUTH_TOKEN}` } }
        );

        const downloadUploadUrl = uploadUrlRes.data.href;

        // 2. Загружаем файл
        await axios.put(downloadUploadUrl, buffer, {
            headers: { 'Content-Type': 'application/octet-stream' },
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });

        // 3. Публикуем файл для получения ссылки
        await axios.put(
            `https://cloud-api.yandex.net/v1/disk/resources/publish?path=${encodeURIComponent(pathOnDisk)}`,
            {},
            { headers: { 'Authorization': `OAuth ${YANDEX_OAUTH_TOKEN}` } }
        );

        // 4. Запрашиваем публичную ссылку
        const resourceRes = await axios.get(
            `https://cloud-api.yandex.net/v1/disk/resources?path=${encodeURIComponent(pathOnDisk)}`,
            { headers: { 'Authorization': `OAuth ${YANDEX_OAUTH_TOKEN}` } }
        );

        return resourceRes.data.public_url;
    } catch (error) {
        console.error("Ошибка при загрузке на Яндекс Диск:", error.response?.data || error.message);
        throw error;
    }
}

app.post('/api/workout', upload.any(), async (req, res) => {
    try {
        console.log("--- Получен запрос на /api/workout ---");
        const data = req.body;
        
        let videoUrl = null;
        let thumbUrl = null;

        if (req.files && req.files.length > 0) {
            for (const file of req.files) {
                console.log(`Загрузка ${file.fieldname} на Яндекс Диск...`);
                const filePublicUrl = await uploadToYandexDisk(file.buffer, file.originalname);
                
                if (file.fieldname === 'video') {
                    videoUrl = filePublicUrl;
                } else if (file.fieldname === 'thumbnail') {
                    thumbUrl = filePublicUrl;
                }
            }
        }

        workoutData = { ...workoutData, ...data };

        let urls = null;
        if (videoUrl || thumbUrl) {
            urls = { videoUrl, thumbUrl };
        }

        res.status(200).json({ 
            success: true, 
            message: "Saved successfully to Yandex Disk",
            urls: urls 
        });
    } catch (error) {
        console.error("Ошибка при сохранении:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/workout', (req, res) => {
    res.status(200).json(workoutData);
});

const server = app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

server.timeout = 300000;
server.keepAliveTimeout = 300000;

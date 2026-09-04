const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Создаем папки для хранения, если их нет
if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');
if (!fs.existsSync('./database.json')) {
    fs.writeFileSync('./database.json', JSON.stringify({ dates: {}, templates: {}, comments: {} }));
}

// Настройка сохранения файлов видео на сервере
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, './uploads/'),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// Раздаем загруженные видео и превью публично
app.use('/uploads', express.static('path' in path ? path.join(__dirname, 'uploads') : 'uploads'));

// Получить все данные (тренировки, комментарии)
app.get('/api/data', (req, res) => {
    const data = JSON.parse(fs.readFileSync('./database.json', 'utf8'));
    res.json(data);
});

// Сохранить прогресс тренировки (веса, повторения, чебоксы)
app.post('/api/data', (req, res) => {
    const newData = req.body;
    fs.writeFileSync('./database.json', JSON.stringify(newData, null, 2));
    res.json({ success: true });
});

// Загрузка видео и превью на сервер
app.post('/api/upload', upload.fields([{ name: 'video', maxCount: 1 }, { name: 'thumbnail', maxCount: 1 }]), (req, res) => {
    const { key } = req.body; // ключ упражнения (например, дата_день_упражнение)
    const videoFile = req.files['video'] ? req.files['video'][0].filename : null;
    const thumbFile = req.files['thumbnail'] ? req.files['thumbnail'][0].filename : null;

    const data = JSON.parse(fs.readFileSync('./database.json', 'utf8'));
    if (!data.videos) data.videos = {};
    
    data.videos[key] = {
        videoUrl: videoFile ? `/uploads/${videoFile}` : null,
        thumbUrl: thumbFile ? `/uploads/${thumbFile}` : null
    };

    fs.writeFileSync('./database.json', JSON.stringify(data, null, 2));
    res.json({ success: true, urls: data.videos[key] });
});

// Удаление видео с сервера
app.post('/api/delete-video', (req, res) => {
    const { key } = req.body;
    const data = JSON.parse(fs.readFileSync('./database.json', 'utf8'));
    
    if (data.videos && data.videos[key]) {
        delete data.videos[key];
        fs.writeFileSync('./database.json', JSON.stringify(data, null, 2));
    }
    res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
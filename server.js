const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Увеличиваем лимиты
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
app.use(cors());

// Создаем папку для файлов
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)){
    fs.mkdirSync(uploadDir);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 100 * 1024 * 1024 }
});

let workoutData = {};

app.get('/', (req, res) => {
    res.send("WorkAut Server is running!");
});

app.post('/api/workout', upload.any(), (req, res) => {
    try {
        console.log("--- Получен запрос на /api/workout ---");
        const data = req.body;
        if (req.files && req.files.length > 0) {
            console.log(`Получено файлов: ${req.files.length}`);
            req.files.forEach(file => {
                console.log(`- Файл: ${file.originalname}, Размер: ${file.size} байт`);
            });
        }
        workoutData = { ...workoutData, ...data };
        res.status(200).json({ success: true, message: "Saved successfully" });
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

// Увеличиваем тайм-аут сервера до 5 минут (300 секунд) для тяжелых видео
server.timeout = 300000;
server.keepAliveTimeout = 300000;

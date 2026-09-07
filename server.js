const express = require('express');
const cors = require('cors');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
app.use(cors());

// Настройка multer для приема видео/файлов до 100 МБ
const upload = multer({ 
  limits: { fileSize: 100 * 1024 * 1024 } // 100 МБ
});

let workoutData = {};

app.get('/', (req, res) => {
    res.send("WorkAut Server is running!");
});

// Эндпоинт с поддержкой загрузки файла в поле 'video' или 'file'
app.post('/api/workout', upload.single('video'), (req, res) => {
    try {
        const data = req.body;
        if (req.file) {
            console.log("Видео получено:", req.file.originalname, "Размер:", req.file.size);
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

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
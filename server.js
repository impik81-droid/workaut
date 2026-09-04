const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Увеличиваем лимиты для JSON и URL-encoded данных до 100MB (чтобы телефон мог отправлять видео)
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// Разрешаем кросс-доменные запросы (чтобы Mini App мог свободно стучаться на сервер)
app.use(cors());

// Временное хранилище в памяти (или подключите вашу базу данных/файлы)
let workoutData = {};

// Простой тестовый маршрут
app.get('/', (req, res) => {
    works = "WorkAut Server is running!";
    res.send(works);
});

// Эндпоинт для сохранения данных тренировок и медиа
app.post('/api/workout', (req, res) => {
    try {
        const data = req.body;
        workoutData = { ...workoutData, ...data };
        console.log("Данные тренировки успешно получены!");
        res.status(200).json({ success: true, message: "Saved successfully" });
    } catch (error) {
        console.error("Ошибка при сохранении:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Эндпоинт для получения данных тренировок
app.get('/api/workout', (req, res) => {
    res.status(200).json(workoutData);
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
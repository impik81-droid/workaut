async function uploadToYandexDisk(buffer, filename) {
    try {
        const folderName = 'app_workouts';
        const pathOnDisk = `${folderName}/${Date.now()}-${filename}`;
        
        // 0. Проверяем и создаем папку app_workouts, если она не существует
        try {
            await axios.put(
                `https://cloud-api.yandex.net/v1/disk/resources?path=${encodeURIComponent(folderName)}`,
                {},
                { headers: { 'Authorization': `OAuth ${YANDEX_OAUTH_TOKEN}` } }
            );
        } catch (folderError) {
            // Если папка уже существует, Яндекс вернет ошибку 409 — это нормально, игнорируем её
            if (folderError.response?.status !== 409) {
                console.log("Папка уже существует или создана успешно");
            }
        }

        // 1. Получаем ссылку для загрузки от Яндекс.Диска
        const uploadUrlRes = await axios.get(
            `https://cloud-api.yandex.net/v1/disk/resources/upload?path=${encodeURIComponent(pathOnDisk)}&overwrite=true`,
            { headers: { 'Authorization': `OAuth ${YANDEX_OAUTH_TOKEN}` } }
        );

        const downloadUploadUrl = uploadUrlRes.data.href;

        // 2. Загружаем сам файл по полученной ссылке
        await axios.put(downloadUploadUrl, buffer, {
            headers: { 'Content-Type': 'application/octet-stream' },
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });

        // 3. Публикуем файл, чтобы получить публичную ссылку
        await axios.put(
            `https://cloud-api.yandex.net/v1/disk/resources/publish?path=${encodeURIComponent(pathOnDisk)}`,
            {},
            { headers: { 'Authorization': `OAuth ${YANDEX_OAUTH_TOKEN}` } }
        );

        // 4. Запрашиваем информацию о файле для получения публичной ссылки
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

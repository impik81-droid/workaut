async function uploadToYandexDisk(buffer, filename) {
    try {
        // Сохраняем файл прямо в корень диска с уникальным префиксом
        const pathOnDisk = `${Date.now()}-${filename}`;
        
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

        // 3. Публикуем файл для получения публичной ссылки
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

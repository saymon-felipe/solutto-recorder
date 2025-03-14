chrome.storage.local.get(["videoUrl", "videoTimeout"], async (data) => {
    const videoUrl = data.videoUrl;
    const videoTimeout = data.videoTimeout || 0;

    if (videoUrl) {
        const videoElement = document.getElementById("video");
        videoElement.controls = true;

        videoElement.src = await transcode(data.videoUrl, "webm", videoTimeout);

        videoElement.load();

        videoElement.onerror = function () {
            console.error("Erro ao carregar o vídeo:", videoElement.error);
        };

        console.log("Baixando vídeo...");

        try {    
            const videoElement = document.getElementById("video");
            const rangeMin = document.getElementById("rangeMin");
            const rangeMax = document.getElementById("rangeMax");
            const range = document.getElementById("range");
            const startTimeInput = document.getElementById("start-time");
            const endTimeInput = document.getElementById("end-time");
    
            function formatTime(seconds) {
                let h = Math.floor(seconds / 3600);
                let m = Math.floor((seconds % 3600) / 60);
                let s = Math.floor(seconds % 60);
                return [h, m, s].map(v => v.toString().padStart(2, '0')).join(":");
            }
    
            function updateRange() {
                console.log("Atualizando faixas...");
                const videoDuration = videoElement.duration || 1; // Evita divisão por zero
    
                const minVal = parseFloat(rangeMin.value);
                const maxVal = parseFloat(rangeMax.value);
    
                const percentMin = (minVal / rangeMin.max) * 100;
                const percentMax = (maxVal / rangeMax.max) * 100;
    
                range.style.left = percentMin + "%";
                range.style.width = (percentMax - percentMin) + "%";
    
                const startTime = (minVal / 100) * videoDuration;
                const endTime = (maxVal / 100) * videoDuration;
    
                startTimeInput.value = formatTime(startTime);
                endTimeInput.value = formatTime(endTime);
            }
    
            rangeMin.addEventListener("input", updateRange);
            rangeMax.addEventListener("input", updateRange);
        } catch (error) {
            console.error("Erro ao converter vídeo:", error);
        }
    }
});
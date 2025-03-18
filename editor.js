chrome.storage.local.get(["videoUrl", "videoTimeout"], async (data) => {
    const videoUrl = data.videoUrl;
    const videoTimeout = data.videoTimeout || 0;

    if (videoUrl) {
        const videoElement = document.getElementById("video");     

        videoElement.controls = true;

        videoElement.src = await transcode(data.videoUrl, "mp4", videoTimeout);

        videoElement.load();

        videoElement.addEventListener("loadedmetadata", () => {
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

            updateRange();
            const cutVideoButton = document.getElementById("cut-video");

            cutVideoButton.addEventListener("click", () => {
                const startTime = document.getElementById("start-time").value;
                const endTime = document.getElementById("end-time").value;

                cutVideo("mp4", timeToSeconds(startTime), timeToSeconds(endTime)).then((videoUrl) => {
                    videoElement.src = videoUrl;
                    rangeMin.value = 0;
                    rangeMax.value = 100;
                });
            })

            document.getElementById("download-video").addEventListener("click", async () => {
                const exportType = document.getElementById("export-type").value;
                const link = document.createElement("a");

                link.href = exportType != "mp4" ? await transcode(videoBlob, "webm", 0) : videoElement.src;

                const now = new Date();
                const formattedDate = now.toLocaleDateString("pt-BR").replace(/\//g, "-"); // "18-03-2025"
                const formattedTime = now.toTimeString().slice(0, 5).replace(":", "-"); // "00-44"

                const fileName = `solutto-gravador-${formattedDate}_${formattedTime}.`;

                link.download = fileName + (exportType != "mp4" ? "webm" : "mp4");
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
            })
        });

        videoElement.onerror = function () {
            console.error("Erro ao carregar o vídeo:", videoElement.error);
        };

        console.log("Baixando vídeo...");
    }
});

function timeToSeconds(time) {
    const [hours, minutes, seconds] = time.split(":").map(Number);
    return hours * 3600 + minutes * 60 + seconds;
}
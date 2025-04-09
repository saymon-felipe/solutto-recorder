const pc = new RTCPeerConnection();
let remoteOfferSet = false;
const pendingCandidates = [];

pc.ontrack = (event) => {
  const stream = event.streams[0];
  const audio = new Audio();
  audio.srcObject = stream;
  audio.play();
};

chrome.runtime.sendMessage({ action: 'ready-to-receive' });

chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg.action === 'offer') {
    await pc.setRemoteDescription(new RTCSessionDescription(msg.offer));
    remoteOfferSet = true;

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    chrome.runtime.sendMessage({ action: 'answer', answer });

    // ✅ Agora que o offer foi setado, podemos aplicar os ICE pendentes
    for (const candidate of pendingCandidates) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
    pendingCandidates.length = 0;
  }

  if (msg.action === 'candidate') {
    if (remoteOfferSet) {
      await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
    } else {
      pendingCandidates.push(msg.candidate); // aguarda até o offer chegar
    }
  }
});

pc.onicecandidate = (event) => {
  if (event.candidate) {
    chrome.runtime.sendMessage({ action: 'candidate', candidate: event.candidate });
  }
};
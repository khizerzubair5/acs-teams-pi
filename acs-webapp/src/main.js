import {
  CallClient,
  LocalVideoStream,
  VideoStreamRenderer,
  Features
} from "@azure/communication-calling";

import { AzureCommunicationTokenCredential } from "@azure/communication-common";

// ✅ Put your Teams meeting link here:
const MEETING_LINK = "https://teams.microsoft.com/meet/26187222018199?p=nbgNsxjYdJz9q1MvIB";

let callAgent;
let callClient;
let call;
let localVideoStream;
let localVideoRenderer;
let localVideoView;

const joinBtn = document.getElementById("joinBtn");
const hangupBtn = document.getElementById("hangupBtn");
const statusEl = document.getElementById("status");
const localVideoContainer = document.getElementById("localVideo");

function setStatus(msg) {
  statusEl.textContent = ` ${msg}`;
}

async function fetchToken() {
  // This calls your backend endpoint: GET http://localhost:3000/token
  // But thanks to Vite proxy, we can just call /token.
  const res = await fetch("/token");
  if (!res.ok) throw new Error(`Token fetch failed: ${res.status}`);
  return await res.json(); // { userId, token, expiresOn }
}

// ── NEW: Pull the WHEP stream from MediaMTX ──────────────────────────────────
async function getWhepStream() {
  const pc = new RTCPeerConnection();
  const stream = new MediaStream();

  const trackPromise = new Promise((resolve) => {
    pc.ontrack = (event) => {
      console.log("✅ Track received:", event.track.kind);
      stream.addTrack(event.track);
      resolve();
    };
  });

  pc.addTransceiver('video', { direction: 'recvonly' });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const response = await fetch('http://localhost:8889/cam/whep', {
    method: 'POST',
    headers: { 'Content-Type': 'application/sdp' },
    body: offer.sdp
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`WHEP failed: ${response.status} — ${errorText}`);
  }

  const answer = await response.text();
  await pc.setRemoteDescription({ type: 'answer', sdp: answer });

  await trackPromise;
  return stream;
}

// ── UPDATED: Uses WHEP stream instead of physical camera ─────────────────────
async function startLocalVideo() {
  setStatus("Getting WHEP stream...");
  const whepStream = await getWhepStream();

  localVideoStream = new LocalVideoStream(whepStream);
  localVideoRenderer = new VideoStreamRenderer(localVideoStream);

  localVideoView = await localVideoRenderer.createView();
  localVideoContainer.innerHTML = "";
  localVideoContainer.appendChild(localVideoView.target);
}

async function joinCall() {
  try {
    if (joinBtn) joinBtn.disabled = true;
    setStatus("Fetching token...");

    const { token } = await fetchToken();

    setStatus("Creating call agent...");
    callClient = new CallClient();
    const tokenCredential = new AzureCommunicationTokenCredential(token);

    callAgent = await callClient.createCallAgent(tokenCredential, {
      displayName: "MedView"
    });

// ── deviceManager block removed ──────────────────────────────────────────
    setStatus("Starting local video...");
    await startLocalVideo();

    setStatus("Joining Teams meeting...");
    const locator = { meetingLink: MEETING_LINK };

    call = callAgent.join(locator, {
      videoOptions: {
        localVideoStreams: [localVideoStream],
        constraints: {
          send: {
            frameHeight: {}
          }
        }
      }
    });
    // ── Diagnostics ──────────────────────────────────────────────────────────────
    call.on('stateChanged', () => {
      console.log('📞 CALL STATE:', call.state);

      if (call.state === 'Disconnected') {
        console.log('❌ DISCONNECT REASON:', call.callEndReason);
        console.log('❌ DISCONNECT CODE:', call.callEndReason?.code);
        console.log('❌ DISCONNECT SUBCODE:', call.callEndReason?.subCode);
      }
    });

    const ufdFeature = call.feature(Features.UserFacingDiagnostics);

    ufdFeature.media.on('diagnosticChanged', (diagnostic) => {
      console.log('🔴 MEDIA DIAGNOSTIC:', diagnostic.diagnostic, '| Value:', diagnostic.value, '| Type:', diagnostic.valueType);
    });

    ufdFeature.network.on('diagnosticChanged', (diagnostic) => {
      console.log('🔴 NETWORK DIAGNOSTIC:', diagnostic.diagnostic, '| Value:', diagnostic.value, '| Type:', diagnostic.valueType);
    });
// ─────────────────────────────────────────────────────────────────────────────

    // Media quality statistics----------------------
    const mediaStatsFeature = call.feature(Features.MediaStats);

    // summaryReported interval = aggregationInterval * dataPointsPerAggregation (seconds)
    const mediaStatsCollectorOptions = {
      aggregationInterval: 15,
      dataPointsPerAggregation: 1
    };

    const mediaStatsCollector = mediaStatsFeature.createCollector(mediaStatsCollectorOptions);

    // Fires every second (too frequent for your test, but useful for UI)
    mediaStatsCollector.on("sampleReported", (sample) => {
      // console.log("sample (1s)", sample);
    });

    // Fires every 15 seconds with aggregated datapoints
    mediaStatsCollector.on("summaryReported", (summary) => {

      const videoSend = summary.video?.send?.[0];
      if (!videoSend) return;

      // Helper to safely extract aggregated values
      const aggAvg = (metric) => {
        const sum = metric?.aggregation?.sum?.[0];
        const count = metric?.aggregation?.count?.[0];
        return (sum != null && count > 0) ? sum / count : null;
      };
      const fpsFromRaw = (rawArray) => {
        if (!Array.isArray(rawArray) || rawArray.length < 2) return null;

        const totalFrames = rawArray[rawArray.length - 1] - rawArray[0];
        const totalSeconds = rawArray.length - 1;

        return totalFrames / totalSeconds;
      };

      const sendMetrics = {
        bitrateMbps: aggAvg(videoSend.bitrate) / 1000000,
        fps: fpsFromRaw(videoSend.framesSent.raw),
        packetsSentPerSecond: aggAvg(videoSend.packetsPerSecond),
        packetsLostPerSecond: aggAvg(videoSend.packetsLostPerSecond),
        rttMs: aggAvg(videoSend.rttInMs),
        resolution: {
          width: aggAvg(videoSend.frameWidthSent),
          height: aggAvg(videoSend.frameHeightSent)
        }
      };

      console.log("📤 SEND VIDEO (15s aggregated)");
      console.log(sendMetrics);
      console.log("────────────");

    });

    hangupBtn.disabled = false;
    setStatus("Joined (or joining). Check Teams participant list.");
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`);
    if (joinBtn) joinBtn.disabled = false;
  }
}

hangupBtn.onclick = async () => {
  try {
    hangupBtn.disabled = true;
    setStatus("Hanging up...");

    if (call) await call.hangUp({ forEveryone: false });
    call = undefined;

    if (localVideoView?.target?.parentNode) {
      localVideoView.target.parentNode.removeChild(localVideoView.target);
    }
    localVideoView = undefined;

    localVideoRenderer?.dispose();
    localVideoRenderer = undefined;

    setStatus("Hung up.");
    joinBtn.disabled = false;
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`);
    hangupBtn.disabled = false;
  }
};

window.addEventListener("load", async () => {
  try {
    const stream = await getWhepStream();
    console.log("✅ WHEP stream obtained");
    console.log("Tracks:", stream.getTracks());

    const testVideo = document.createElement('video');
    testVideo.srcObject = stream;
    testVideo.autoplay = true;
    testVideo.muted = true;
    testVideo.style.width = '320px';
    testVideo.style.border = '2px solid green';
    document.body.appendChild(testVideo);

    console.log("✅ Video element added");
  } catch (err) {
    console.error("❌ WHEP failed:", err.message);
  }
});

/*// REPLACE with this:
joinBtn.onclick = async () => {
  await joinCall();
};

window.addEventListener("load", async () => {
  // Simulate user interaction to satisfy autoplay policy
  document.body.click();
  await joinCall();
});*/


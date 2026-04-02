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

async function startLocalVideo(deviceManager) {
  const cameras = await deviceManager.getCameras();
  if (!cameras.length) throw new Error("No cameras found.");

  localVideoStream = new LocalVideoStream(cameras[0]);
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

    const deviceManager = await callClient.getDeviceManager();

    // Ask only for video permission (audio false)
    setStatus("Requesting camera permission...");
    await deviceManager.askDevicePermission({ video: true, audio: false });

    setStatus("Starting local video...");
    await startLocalVideo(deviceManager);

    // Join Teams meeting by link:
    // Docs: locator = { meetingLink: '<MEETING_LINK>' }; callAgent.join(locator);
    setStatus("Joining Teams meeting...");
    const locator = { meetingLink: MEETING_LINK };

    call = callAgent.join(locator, {
      videoOptions: {
        localVideoStreams: [localVideoStream],
        constraints: {
          send:{
            frameHeight: {}

          }
        }
      }
    });
    // Media quality statistics
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
  console.log("Page loaded — auto joining...");
  await joinCall();
});

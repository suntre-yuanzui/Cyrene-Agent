// 通话窗口渲染端 —— 粒子背景 + 麦克风采集 + VAD 静默检测 + 状态机 + TTS 播放。
//
// 状态：LISTENING（用户说话）→ THINKING（agent 思考）→ SPEAKING（昔涟说话）→ LISTENING
// 用户说话时：柱状胶囊波形跳动 + 头像外圈音量波形
// 昔涟说话时：电波环脉冲扩散 + 波形隐藏
import "../ui/theme";
import { createTurnSubmitter, type TurnSubmitter } from "./turn-submission";

// ── 粒子背景 ──
const canvas = document.getElementById("particles") as HTMLCanvasElement | null;
const ctx = canvas?.getContext("2d") ?? null;
let particlesW = 0, particlesH = 0;

interface Particle {
  x: number; y: number; size: number; vx: number; vy: number;
  hue: number; alpha: number; twinkle: number; twinkleSpeed: number;
}

const PARTICLE_COUNT = 45;
const particles: Particle[] = [];

function spawnParticle(): Particle {
  return {
    x: Math.random() * particlesW, y: Math.random() * particlesH,
    size: 0.6 + Math.random() * 2.4,
    vx: (Math.random() - 0.5) * 0.18,
    vy: -0.05 - Math.random() * 0.22,
    hue: 305 + Math.random() * 40,
    alpha: 0.25 + Math.random() * 0.5,
    twinkle: Math.random() * Math.PI * 2,
    twinkleSpeed: 0.005 + Math.random() * 0.012,
  };
}

function resizeParticles(): void {
  if (!canvas || !ctx) return;
  const dpr = window.devicePixelRatio || 1;
  // 直接用窗口尺寸，不依赖 clientWidth（可能被 body 层遮挡读到错误值）
  particlesW = window.innerWidth;
  particlesH = window.innerHeight;
  canvas.width = particlesW * dpr;
  canvas.height = particlesH * dpr;
  canvas.style.width = particlesW + "px";
  canvas.style.height = particlesH + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawParticles(): void {
  if (!ctx) return;
  ctx.clearRect(0, 0, particlesW, particlesH);
  for (const p of particles) {
    p.x += p.vx; p.y += p.vy; p.twinkle += p.twinkleSpeed;
    if (p.y < -10) p.y = particlesH + 10;
    if (p.x < -10) p.x = particlesW + 10;
    if (p.x > particlesW + 10) p.x = -10;
    const flicker = 0.65 + Math.sin(p.twinkle) * 0.35;
    const a = p.alpha * flicker;
    const r = p.size * 3;
    const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
    grad.addColorStop(0, `hsla(${p.hue}, 90%, 80%, ${a})`);
    grad.addColorStop(0.5, `hsla(${p.hue}, 90%, 70%, ${a * 0.4})`);
    grad.addColorStop(1, `hsla(${p.hue}, 90%, 70%, 0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  requestAnimationFrame(drawParticles);
}

// ── DOM 元素 ──
const statusEl = document.getElementById("call-status") as HTMLElement;
const deviceSelectEl = document.getElementById("device-select") as HTMLSelectElement | null;
const ringEl = document.getElementById("avatar-ring") as HTMLElement;
const waveformCanvas = document.getElementById("waveform-canvas") as HTMLCanvasElement | null;
const micWaveEl = document.getElementById("mic-wave") as HTMLButtonElement;
const micBars = micWaveEl ? Array.from(micWaveEl.querySelectorAll(".call__mic-wave-bar")) : [];
const transcriptEl = document.getElementById("transcript") as HTMLElement;
const hangupBtn = document.getElementById("hangup-btn") as HTMLButtonElement;
const closeBtn = document.getElementById("close-btn") as HTMLButtonElement;
const durationEl = document.getElementById("call-duration") as HTMLElement | null;

// ── 通话时长计时（首次进入活动状态时启动，END 时停止） ──
let callStartAt: number | null = null;
let callTimer: number | null = null;

/** 把毫秒数格式化为 MM:SS，超过 60 分钟进入 HH:MM:SS。 */
function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** 启动 / 重置 计时器。第一次传 true 时记录起点并启动 1s interval。 */
function startCallTimer(): void {
  if (callStartAt !== null) return; // 已经启动过了，避免 LISTENING<->SPEAKING 时重置
  callStartAt = performance.now();
  if (durationEl) {
    durationEl.textContent = "00:00";
    durationEl.hidden = false;
  }
  const tick = () => {
    if (callStartAt === null || !durationEl) return;
    durationEl.textContent = formatDuration(performance.now() - callStartAt);
  };
  callTimer = window.setInterval(tick, 1000);
  tick();
}

/** 停止计时并隐藏时长元素（用于 hangup / 通话已结束）。 */
function stopCallTimer(): void {
  if (callTimer !== null) {
    window.clearInterval(callTimer);
    callTimer = null;
  }
  callStartAt = null;
  if (durationEl) durationEl.hidden = true;
}

// ── 状态管理 ──
type CallState = "IDLE" | "LISTENING" | "THINKING" | "SPEAKING" | "ERROR" | "ENDED";
let currentState: CallState = "IDLE";
let showTranscript = false; // 从设置读取
let turnSubmitter: TurnSubmitter | null = null;

function setState(state: CallState): void {
  currentState = state;
  if (state === "LISTENING") turnSubmitter?.reset();
  else turnSubmitter?.syncAvailability();
  updateUI();
}

function updateUI(): void {
  const status = statusEl;
  const ring = ringEl;
  const wave = waveformCanvas;
  const mic = micWaveEl;

  if (currentState === "LISTENING") {
    status.textContent = "正在聆听...";
    status.className = "call__status";
    ring.classList.remove("is-active");
    wave?.classList.add("is-active");
    mic.classList.add("is-active");
    waveformMode = "listening";
    micMode = "listening";
  } else if (currentState === "THINKING") {
    status.textContent = "昔涟思考中...";
    status.className = "call__status call__status--thinking";
    ring.classList.remove("is-active");
    wave?.classList.add("is-active");
    mic.classList.add("is-active");
    waveformMode = "thinking";
    micMode = "thinking";
  } else if (currentState === "SPEAKING") {
    status.textContent = "昔涟说话中...";
    status.className = "call__status";
    ring.classList.add("is-active");
    wave?.classList.remove("is-active");
    mic.classList.remove("is-active");
    waveformMode = "idle";
    micMode = "idle";
  } else if (currentState === "ERROR") {
    status.textContent = "连接出错，请检查网络";
    status.className = "call__status call__status--error";
    ring.classList.remove("is-active");
    wave?.classList.remove("is-active");
    mic.classList.remove("is-active");
    waveformMode = "idle";
    micMode = "idle";
  } else if (currentState === "ENDED") {
    status.textContent = "通话已结束";
    status.className = "call__status";
    ring.classList.remove("is-active");
    wave?.classList.remove("is-active");
    mic.classList.remove("is-active");
    waveformMode = "idle";
    micMode = "idle";
  } else {
    status.textContent = "正在连接...";
    status.className = "call__status";
    ring.classList.remove("is-active");
    wave?.classList.remove("is-active");
    mic.classList.remove("is-active");
    waveformMode = "idle";
    micMode = "idle";
  }

  // 通话时长：进入活动状态时启动计时，END 时停止（IDLE/ERROR/ENDED 均停）。
  if (currentState === "LISTENING" || currentState === "THINKING" || currentState === "SPEAKING") {
    startCallTimer();
  } else if (currentState === "ENDED") {
    stopCallTimer();
  }
}

// ── 转写显示（只显示当前一轮） ──
function renderTranscript(userText: string, botText: string): void {
  if (!showTranscript) { transcriptEl.hidden = true; return; }
  transcriptEl.hidden = false;
  transcriptEl.innerHTML = "";
  if (userText) {
    const u = document.createElement("div");
    u.className = "call__transcript-user";
    u.textContent = userText;
    transcriptEl.appendChild(u);
  }
  if (botText) {
    const b = document.createElement("div");
    b.className = "call__transcript-bot";
    b.textContent = botText;
    transcriptEl.appendChild(b);
  }
}

let currentUserText = "";
let currentBotText = "";

// ── 音量波形（绕头像一圈） ──
let waveformMode = "idle"; // idle, listening, thinking
const NUM_WAVE_BARS = 32;
const waveBars: Array<{ angle: number }> = [];
const waveformCtx = waveformCanvas?.getContext("2d") ?? null;

function initWaveformCanvas(): void {
  if (!waveformCanvas || !waveformCtx) return;
  const dpr = window.devicePixelRatio || 1;
  const size = 200; // 比 avatar-zone(150px) 大一圈
  waveformCanvas.width = size * dpr;
  waveformCanvas.height = size * dpr;
  waveformCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (let i = 0; i < NUM_WAVE_BARS; i++) {
    waveBars.push({ angle: (i / NUM_WAVE_BARS) * Math.PI * 2 });
  }
}

let analyserData: Uint8Array | null = null;

function drawWaveform(): void {
  if (!waveformCtx || !waveformCanvas) { requestAnimationFrame(drawWaveform); return; }
  const cx = waveformCanvas.width / (window.devicePixelRatio || 1) / 2;
  const cy = waveformCanvas.height / (window.devicePixelRatio || 1) / 2;
  const innerRadius = 80; // 头像半径（150px / 2 ≈ 75，留一点边）
  waveformCtx.clearRect(0, 0, waveformCanvas.width, waveformCanvas.height);

  for (const b of waveBars) {
    let h: number;
    if (waveformMode === "listening") {
      // 从 AnalyserNode 取频域数据
      const dataIdx = Math.floor((b.angle / (Math.PI * 2)) * (analyserData?.length ?? 1));
      const vol = analyserData ? analyserData[dataIdx] / 255 : 0;
      h = 5 + vol * 85;
    } else if (waveformMode === "thinking") {
      h = 5 + Math.sin(Date.now() * 0.003 + b.angle) * 4 + 4;
    } else {
      h = 5;
    }
    const x1 = cx + Math.cos(b.angle) * innerRadius;
    const y1 = cy + Math.sin(b.angle) * innerRadius;
    const x2 = cx + Math.cos(b.angle) * (innerRadius + h);
    const y2 = cy + Math.sin(b.angle) * (innerRadius + h);
    waveformCtx.strokeStyle = "rgba(255, 110, 199, 0.7)";
    waveformCtx.lineWidth = 3;
    waveformCtx.lineCap = "round";
    waveformCtx.beginPath();
    waveformCtx.moveTo(x1, y1);
    waveformCtx.lineTo(x2, y2);
    waveformCtx.stroke();
  }
  requestAnimationFrame(drawWaveform);
}

// ── 柱状胶囊波形动画 ──
let micMode = "idle"; // idle, listening, thinking

function animateMicWave(): void {
  for (const bar of micBars) {
    let h: number;
    if (micMode === "listening") {
      // 从 AnalyserNode 取平均音量
      const avg = analyserData ? analyserData.reduce((a, b) => a + b, 0) / analyserData.length / 255 : 0;
      h = 10 + Math.random() * avg * 76 + avg * 20;
    } else if (micMode === "thinking") {
      h = 10 + Math.sin(Date.now() * 0.004) * 5 + 5;
    } else {
      h = 10;
    }
    (bar as HTMLElement).style.height = h + "px";
  }
  requestAnimationFrame(animateMicWave);
}

// ── 麦克风采集 + VAD ──
let audioContext: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let workletNode: AudioWorkletNode | null = null;
let micStream: MediaStream | null = null;
let vadSilenceTimer: ReturnType<typeof setTimeout> | null = null;
let vadInterval: ReturnType<typeof setInterval> | null = null;
let vadSilenceMs = 1000;
let vadThreshold = 0.01; // 绝对音量下限（设置项），自适应基线会在此之上叠加
let hasSpoken = false; // 用户是否已开始说话（VAD 只在说过话后检测静默）
let vadTimeData: Uint8Array | null = null; // 时域数据（RMS 计算）
let noiseFloor = 0; // 自适应噪声基线（RMS）
let noiseCalibFrames = 10; // 启动后先校准 10 帧（1s）取环境底噪
let speechStreak = 0; // 连续高于阈值的帧数
let totalSpeechMs = 0; // 本轮累计语音时长

/** 重置本轮语音判定状态（不重置噪声基线）。 */
function resetVadTurn(): void {
  hasSpoken = false;
  speechStreak = 0;
  totalSpeechMs = 0;
}

/** 确保 AudioContext 处于 running（自动播放策略下，无用户手势时可能 suspended）。 */
async function ensureAudioRunning(): Promise<void> {
  if (audioContext && audioContext.state === "suspended") {
    try {
      await audioContext.resume();
      console.log("[Call] AudioContext 已恢复:", audioContext.state);
    } catch (err) {
      console.warn("[Call] AudioContext resume 失败:", err);
    }
  }
}

async function startMicrophone(deviceId?: string): Promise<void> {
  try {
    const audioConstraints: MediaTrackConstraints = {
      sampleRate: 16000,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
    };
    if (deviceId) {
      audioConstraints.deviceId = { exact: deviceId };
    }

    micStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });

    audioContext = new AudioContext({ sampleRate: 16000 });
    await audioContext.audioWorklet.addModule(new URL("./pcm-processor.js", import.meta.url));
    // 尝试恢复；若因无用户手势失败，后续任意点击会再次恢复。
    void ensureAudioRunning();

    const source = audioContext.createMediaStreamSource(micStream);

    // AnalyserNode 用于 VAD + 波形显示
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyserData = new Uint8Array(analyser.frequencyBinCount);
    vadTimeData = new Uint8Array(analyser.fftSize);
    source.connect(analyser);

    // AudioWorkletNode 用于 PCM 采集
    workletNode = new AudioWorkletNode(audioContext, "pcm-processor");
    workletNode.port.onmessage = (e: MessageEvent) => {
      const frame = e.data as ArrayBuffer;
      window.call?.sendAudioFrame(frame);
    };
    source.connect(workletNode);
    // workletNode 不连 destination（不需要本地回放）

    console.log("[Call] 麦克风已启动", deviceId ? `deviceId=${deviceId.slice(0, 8)}…` : "(默认设备)");
    startVAD();
  } catch (err) {
    console.error("[Call] 麦克风启动失败:", err);
    statusEl.textContent = "无法访问麦克风，请检查权限";
    statusEl.className = "call__status call__status--error";
  }
}

/** VAD 静默检测：自适应噪声基线 + 最短语音时长，忽略环境噪音与短促杂音。 */
function startVAD(): void {
  const FRAME_MS = 100;
  const MIN_SPEECH_MS = 300;
  const MIN_SPEECH_FRAMES = Math.max(1, Math.round(MIN_SPEECH_MS / FRAME_MS));
  let logCounter = 0;

  vadInterval = setInterval(() => {
    if (!analyser || !vadTimeData) return;
    if (currentState !== "LISTENING") return;

    analyser.getByteTimeDomainData(vadTimeData);
    // RMS（时域能量，比频域均值更能反映真实响度）
    let sum = 0;
    for (let i = 0; i < vadTimeData.length; i++) {
      const v = (vadTimeData[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / vadTimeData.length);

    // 启动后先校准 1s：取环境底噪最大值作为初始基线，期间不判定
    if (noiseCalibFrames > 0) {
      noiseCalibFrames--;
      noiseFloor = Math.max(noiseFloor, rms);
      if (noiseCalibFrames === 0) {
        console.log("[Call VAD] 噪声基线校准完成 floor=", noiseFloor.toFixed(4));
      }
      return;
    }

    // 判定阈值：基线 ×2.5 + 绝对余量，且不低于设置里的绝对下限
    const threshold = Math.max(vadThreshold, noiseFloor * 2.5 + 0.003);
    const isVoice = rms >= threshold;

    // 噪声基线自适应：静默时平滑跟踪底噪；说话时极缓慢上浮（应对环境噪声渐增）
    if (!isVoice) {
      noiseFloor = noiseFloor * 0.98 + rms * 0.02;
    } else if (noiseFloor < 0.08) {
      noiseFloor += 0.0001;
    }

    logCounter++;
    if (logCounter % 10 === 0) {
      console.log(
        "[Call VAD] rms=", rms.toFixed(4),
        "floor=", noiseFloor.toFixed(4),
        "threshold=", threshold.toFixed(4),
        "streak=", speechStreak,
        "spoken=", hasSpoken,
      );
    }

    if (isVoice) {
      speechStreak++;
      totalSpeechMs += FRAME_MS;
      if (!hasSpoken && speechStreak >= MIN_SPEECH_FRAMES) {
        hasSpoken = true;
        console.log("[Call VAD] 检测到说话（持续", speechStreak * FRAME_MS, "ms）");
      }
      // 说话期间清掉静默计时
      if (vadSilenceTimer) { clearTimeout(vadSilenceTimer); vadSilenceTimer = null; }
    } else {
      speechStreak = 0;
      if (hasSpoken) {
        // 静默且之前说过话：开始静默计时
        if (!vadSilenceTimer) {
          console.log("[Call VAD] 静默开始，准备结束本轮");
          vadSilenceTimer = setTimeout(() => {
            console.log("[Call VAD] 静默", vadSilenceMs, "ms 触发结束，本轮语音", totalSpeechMs, "ms");
            vadSilenceTimer = null;
            resetVadTurn();
            turnSubmitter?.request();
          }, vadSilenceMs);
        }
      }
    }
  }, FRAME_MS);
}

function stopMicrophone(): void {
  if (vadInterval) { clearInterval(vadInterval); vadInterval = null; }
  if (vadSilenceTimer) { clearTimeout(vadSilenceTimer); vadSilenceTimer = null; }
  if (workletNode) { try { workletNode.disconnect(); } catch { /* ignore */ } workletNode = null; }
  if (analyser) { try { analyser.disconnect(); } catch { /* ignore */ } analyser = null; }
  if (audioContext) { try { audioContext.close(); } catch { /* ignore */ } audioContext = null; }
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  analyserData = null;
  vadTimeData = null;
  noiseFloor = 0;
  noiseCalibFrames = 10;
  resetVadTurn();
}

// ── 音频设备选择 ──
const DEVICE_STORAGE_KEY = "cyrene.call.micDeviceId";

function selectedDeviceId(): string {
  try { return localStorage.getItem(DEVICE_STORAGE_KEY) ?? ""; } catch { return ""; }
}

/** 枚举输入设备并刷新下拉框；未授权时 label 可能为空，用序号兜底。 */
async function refreshDeviceList(): Promise<void> {
  if (!deviceSelectEl) return;
  const saved = selectedDeviceId();
  let inputs: MediaDeviceInfo[] = [];
  try {
    inputs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "audioinput");
  } catch { /* 无权限时忽略，保留下拉框现状 */ }

  const current = inputs.some(d => d.deviceId === saved) ? saved : "";
  deviceSelectEl.innerHTML = "";
  const def = document.createElement("option");
  def.value = "";
  def.textContent = "默认设备";
  deviceSelectEl.appendChild(def);

  let fallbackIndex = 1;
  for (const d of inputs) {
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    opt.textContent = d.label && d.label.trim() ? d.label : `麦克风 ${fallbackIndex}`;
    deviceSelectEl.appendChild(opt);
    fallbackIndex += 1;
  }
  deviceSelectEl.value = current;
}

/** 切换麦克风设备：停止旧流，按新 deviceId 重启（仅聆听态自动重启）。 */
async function switchDevice(deviceId: string): Promise<void> {
  try { localStorage.setItem(DEVICE_STORAGE_KEY, deviceId); } catch { /* ignore */ }
  stopMicrophone();
  if (currentState === "LISTENING") {
    await startMicrophone(deviceId || undefined);
  }
}

deviceSelectEl?.addEventListener("change", () => {
  void ensureAudioRunning();
  void switchDevice(deviceSelectEl.value);
});

// 任意用户手势后恢复 AudioContext：自动播放策略可能让 context 初始 suspended
// （这正是“对着麦说话却无反应”的根因——VAD 读到恒 0 音量，永远不触发提交）。
document.addEventListener("click", () => { void ensureAudioRunning(); }, { passive: true });

// ── TTS 播放 + Live2D 嘴型联动 ──
// 复用聊天窗口的逻辑：音频播放时通过 live2dSpeech IPC 让宠物窗口小人嘴巴张合。
const AUDIO_MOUTH_DELAY_MS = 800;

let currentAudio: HTMLAudioElement | null = null;
let speechToken = 0;

function nextSpeechToken(): number {
  speechToken += 1;
  return speechToken;
}

/** 停止嘴型联动（挂断 / 新 TTS / 错误时调用）。 */
function stopLive2dMouth(): void {
  speechToken += 1;
  window.live2dSpeech?.stopMouth();
}

function waitForAudioMetadata(audio: HTMLAudioElement): Promise<number | null> {
  return new Promise((resolve) => {
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      resolve(audio.duration);
      return;
    }
    const timer = window.setTimeout(() => {
      cleanup();
      resolve(null);
    }, 3000);
    const cleanup = () => {
      window.clearTimeout(timer);
      audio.removeEventListener("loadedmetadata", onLoaded);
      audio.removeEventListener("error", onError);
    };
    const onLoaded = () => {
      cleanup();
      resolve(Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null);
    };
    const onError = () => {
      cleanup();
      resolve(null);
    };
    audio.addEventListener("loadedmetadata", onLoaded, { once: true });
    audio.addEventListener("error", onError, { once: true });
  });
}

function playTtsAudio(base64: string): void {
  // 停掉旧音频和嘴型
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  stopLive2dMouth();

  const token = nextSpeechToken();
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: "audio/mp3" });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.preload = "auto";
  audio.load();
  currentAudio = audio;

  // 重置表情，准备嘴型联动
  window.live2dSpeech?.prepare();

  audio.onended = () => {
    URL.revokeObjectURL(url);
    if (currentAudio === audio) currentAudio = null;
    if (speechToken === token) stopLive2dMouth();
    window.call?.ttsDone();
  };
  audio.onerror = () => {
    URL.revokeObjectURL(url);
    if (currentAudio === audio) currentAudio = null;
    if (speechToken === token) stopLive2dMouth();
    window.call?.ttsDone();
  };
  audio.play().catch(() => {
    if (speechToken === token) stopLive2dMouth();
    window.call?.ttsDone();
  });

  // 等音频 metadata 获取时长，延迟后驱动嘴型
  void (async () => {
    const durationSec = await waitForAudioMetadata(audio);
    if (speechToken !== token) return;
    const durationMs = durationSec === null ? 0 : Math.max(0, durationSec * 1000 - AUDIO_MOUTH_DELAY_MS);
    window.setTimeout(() => {
      if (speechToken !== token) return;
      if (durationMs > 0) window.live2dSpeech?.startMouth(durationMs);
    }, AUDIO_MOUTH_DELAY_MS);
  })();
}

function stopTts(): void {
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  stopLive2dMouth();
}

turnSubmitter = createTurnSubmitter({
  button: micWaveEl,
  isListening: () => currentState === "LISTENING",
  sendTurn: () => {
    if (vadSilenceTimer) {
      clearTimeout(vadSilenceTimer);
      vadSilenceTimer = null;
    }
    resetVadTurn();
    window.call?.turnEnd();
  },
});
turnSubmitter.syncAvailability();

// ── IPC 事件监听 ──
window.call?.onState((state: string) => {
  setState(state as CallState);
  if (state === "LISTENING" && !micStream) {
    void startMicrophone();
  }
});

window.call?.onAsrResult((data: { partial?: string; final?: string }) => {
  if (data.partial) {
    currentUserText = data.partial;
    renderTranscript(currentUserText, "");
  }
  if (data.final) {
    currentUserText = data.final;
    renderTranscript(currentUserText, "");
  }
});

window.call?.onTtsAudio((data: { base64: string }) => {
  renderTranscript(currentUserText, "（语音回复中）");
  playTtsAudio(data.base64);
});

window.call?.onError((data: { message: string }) => {
  statusEl.textContent = data.message;
  statusEl.className = "call__status call__status--error";
});

// ── 挂断 ──
function hangup(): void {
  window.call?.stop();
  stopMicrophone();
  stopTts();
  stopCallTimer();
  setState("ENDED");
  setTimeout(() => window.close(), 500);
}

hangupBtn.addEventListener("click", hangup);
closeBtn.addEventListener("click", hangup);

// ── 初始化 ──
async function init(): Promise<void> {
  // 读 ASR 设置（VAD 阈值 + 转写开关）
  try {
    const cfg = await window.tts?.loadSettings();
    if (cfg) {
      vadSilenceMs = typeof cfg.asrVadSilenceMs === "number" ? cfg.asrVadSilenceMs : 1000;
      vadThreshold = typeof cfg.asrVadThreshold === "number" ? cfg.asrVadThreshold : 0.01;
      showTranscript = Boolean(cfg.asrShowTranscript);
    }
    console.log("[Call] VAD config: threshold=", vadThreshold, "silenceMs=", vadSilenceMs);
  } catch { /* ignore */ }

  // 粒子背景
  if (canvas && ctx) {
    resizeParticles();
    for (let i = 0; i < PARTICLE_COUNT; i++) particles.push(spawnParticle());
    requestAnimationFrame(drawParticles);
    window.addEventListener("resize", resizeParticles);
  }

  // 波形 canvas
  initWaveformCanvas();
  requestAnimationFrame(drawWaveform);
  requestAnimationFrame(animateMicWave);

  // 音频设备：初始枚举 + 设备热插拔监听
  await refreshDeviceList();
  navigator.mediaDevices.addEventListener("devicechange", () => {
    void refreshDeviceList();
  });

  // 开始通话
  window.call?.start();
}

void init();

// 窗口类型声明
declare global {
  interface Window {
    call?: {
      start: () => void;
      sendAudioFrame: (frame: ArrayBuffer) => void;
      turnEnd: () => void;
      ttsDone: () => void;
      stop: () => void;
      onState: (callback: (state: string) => void) => () => void;
      onAsrResult: (callback: (data: { partial?: string; final?: string }) => void) => () => void;
      onTtsAudio: (callback: (data: { base64: string }) => void) => () => void;
      onError: (callback: (data: { message: string }) => void) => () => void;
    };
    tts?: {
      loadSettings: () => Promise<Record<string, unknown>>;
    };
    live2dSpeech?: {
      prepare: () => void;
      startMouth: (durationMs: number) => void;
      stopMouth: () => void;
    };
  }
}

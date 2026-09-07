// 本地 ASR 引擎（faster-whisper，经 GPT-SoVITS 的 asr_api.py 提供）
//
// 协议：POST {baseUrl}/asr
//   multipart/form-data：
//     file      —— 音频文件（WAV）
//     language  —— zh / en / auto
//   返回 JSON：{ "text": "...", "language": "...", "duration": 5.8 }
//
// 行为：缓存一轮 PCM，stop 时上传并返回完整文本（与 Mossland 相同的「轮次结束后转写」模式，
//       不提供实时中间结果）。
// 音频：通话采集的 PCM 16kHz/16bit/mono，复用 mossland-asr-engine 的 WAV 封装。

import { encodePcm16MonoWav } from "./mossland-asr-engine";

const LOG_PREFIX = "[LocalASR]";
const DEFAULT_BASE_URL = "http://127.0.0.1:9881";
const DEFAULT_TIMEOUT_MS = 60_000;

async function transcribeWav(baseUrl: string, wav: Buffer, language: string): Promise<string> {
  const form = new FormData();
  form.append("language", language && language !== "auto" ? language : "auto");
  form.append("file", new Blob([wav], { type: "audio/wav" }), "speech.wav");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const url = `${baseUrl.replace(/\/+$/, "")}/asr`;
    const response = await fetch(url, {
      method: "POST",
      body: form,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`本地转写失败：HTTP ${response.status}`);
    }
    const data = (await response.json()) as { text?: unknown };
    if (typeof data.text !== "string") {
      throw new Error("本地转写失败：服务端未返回 text");
    }
    return data.text.trim();
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`本地转写超时（${DEFAULT_TIMEOUT_MS}ms），请确认 ASR 服务已启动`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 本地批量转写会话：缓存一轮 PCM，stop 时上传 WAV 并返回完整文本。 */
export class LocalAsrStream {
  private readonly frames: Buffer[] = [];
  private stopPromise: Promise<string> | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly language: string,
    private readonly onFinal: (text: string) => void,
  ) {}

  async start(): Promise<void> {
    if (!this.baseUrl.trim()) {
      throw new Error("本地转写失败：缺少 ASR 服务地址");
    }
    console.log(LOG_PREFIX, `本地 ASR 服务地址: ${this.baseUrl || DEFAULT_BASE_URL}`);
  }

  sendAudio(pcmFrame: Buffer): void {
    if (this.stopPromise || pcmFrame.length === 0) return;
    this.frames.push(Buffer.from(pcmFrame));
  }

  stop(): Promise<string> {
    if (!this.stopPromise) {
      this.stopPromise = this.finish();
    }
    return this.stopPromise;
  }

  private async finish(): Promise<string> {
    if (this.frames.length === 0) return "";
    const text = await transcribeWav(
      this.baseUrl || DEFAULT_BASE_URL,
      encodePcm16MonoWav(Buffer.concat(this.frames)),
      this.language,
    );
    if (text) this.onFinal(text);
    return text;
  }
}

"use client";

// Adaptive, Shazam-style microphone capture. Each probe contains the complete
// MediaRecorder window from its first byte (never a headerless slice). Windows
// roll every 30 seconds so listening can continue indefinitely without
// exceeding the backend's 5 MB identification limit.

import { useCallback, useEffect, useRef, useState } from "react";
import { identifyRecording, type IdentifyResult } from "../lib/api";

export type RecorderState =
  | "idle"
  | "listening"
  | "identifying"
  | "identified"
  | "error";

const PROBE_SECONDS = [4, 8, 14, 22, 30];
const WINDOW_SECONDS = 30;
const MAX_PROBE_BYTES = 4_750_000; // safely below the backend's 5 MiB cap

function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const type of ["audio/webm", "audio/mp4", "audio/ogg"]) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      resolve(dataUrl.substring(dataUrl.indexOf(",") + 1));
    };
    reader.onerror = () => reject(new Error("Could not read recording"));
    reader.readAsDataURL(blob);
  });
}

export function useRecorder(onIdentified: (result: IdentifyResult) => void) {
  const [state, setState] = useState<RecorderState>("idle");
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const identifyAbortRef = useRef<AbortController | null>(null);
  const inFlightProbeRef = useRef<Promise<boolean> | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const windowStartedAtRef = useRef(0);
  const probeIndexRef = useRef(0);
  const probeScheduledRef = useRef(false);
  const stopReasonRef = useRef<"manual" | "rotate" | null>(null);
  const matchedRef = useRef(false);
  const mountedRef = useRef(true);
  const startingRef = useRef(false);

  const cleanup = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder?.state === "recording") {
      recorder.onstop = null;
      recorder.stop();
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    probeScheduledRef.current = false;
    startingRef.current = false;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      identifyAbortRef.current?.abort();
      identifyAbortRef.current = null;
      cleanup();
    };
  }, [cleanup]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state === "recording") {
      stopReasonRef.current = "manual";
      try { recorder.requestData(); } catch { /* stop() still flushes final data */ }
      recorder.stop();
    }
  }, []);

  const start = useCallback(async () => {
    if (startingRef.current || recorderRef.current?.state === "recording") return;
    startingRef.current = true;
    setError(null);
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      setError("Recording isn't supported in this browser.");
      setState("error");
      startingRef.current = false;
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      if (!mountedRef.current) return;
      setError("Microphone access was denied. Allow it in your browser settings and try again.");
      setState("error");
      startingRef.current = false;
      return;
    }
    if (!mountedRef.current) {
      stream.getTracks().forEach((track) => track.stop());
      startingRef.current = false;
      return;
    }

    const mimeType = pickMimeType();
    streamRef.current = stream;
    matchedRef.current = false;
    stopReasonRef.current = null;

    const finishWithError = (message: string) => {
      if (!mountedRef.current || matchedRef.current) return;
      setError(message);
      setState("error");
      cleanup();
    };

    const runProbe = async (finalAttempt: boolean): Promise<boolean> => {
      if (matchedRef.current || !mountedRef.current) return false;

      if (inFlightProbeRef.current) {
        if (!finalAttempt) return false;
        identifyAbortRef.current?.abort();
        try { await inFlightProbeRef.current; } catch { /* final probe follows */ }
      }

      const blob = new Blob(chunksRef.current.slice(), {
        type: mimeType || recorderRef.current?.mimeType || "audio/webm",
      });
      if (blob.size < 256) {
        if (finalAttempt) finishWithError("The recording was too short to identify.");
        return false;
      }
      if (blob.size > MAX_PROBE_BYTES) {
        if (finalAttempt) finishWithError("The recording became too large. Tap retry to start a fresh listening window.");
        return false;
      }

      const controller = new AbortController();
      identifyAbortRef.current = controller;
      if (finalAttempt) setState("identifying");

      const probe = (async () => {
        try {
          const base64 = await blobToBase64(blob);
          const result = await identifyRecording(base64, blob.type, controller.signal, true);
          if (result.identified && result.songInfo && mountedRef.current) {
            matchedRef.current = true;
            setState("identified");
            cleanup();
            onIdentified(result);
            return true;
          }
          if (finalAttempt) {
            finishWithError("We couldn't identify that song. Tap retry or keep the phone closer to the music.");
          }
        } catch (caught) {
          if (!mountedRef.current || (caught instanceof Error && caught.name === "AbortError")) return false;
          const message = caught instanceof Error ? caught.message : "Something went wrong while identifying.";
          if (finalAttempt || /daily limit|unsupported|too large/i.test(message)) {
            finishWithError(message);
          }
        } finally {
          if (identifyAbortRef.current === controller) identifyAbortRef.current = null;
        }
        return false;
      })();

      inFlightProbeRef.current = probe;
      try {
        return await probe;
      } finally {
        if (inFlightProbeRef.current === probe) inFlightProbeRef.current = null;
      }
    };

    const startWindow = () => {
      if (!mountedRef.current || matchedRef.current || !streamRef.current) return;
      let recorder: MediaRecorder;
      try {
        recorder = mimeType
          ? new MediaRecorder(streamRef.current, { mimeType, audioBitsPerSecond: 64_000 })
          : new MediaRecorder(streamRef.current, { audioBitsPerSecond: 64_000 });
      } catch {
        // Some Safari versions reject audioBitsPerSecond even when the MIME is
        // supported. Fall back without losing the adaptive recorder flow.
        recorder = mimeType
          ? new MediaRecorder(streamRef.current, { mimeType })
          : new MediaRecorder(streamRef.current);
      }
      const chunks: Blob[] = [];
      chunksRef.current = chunks;
      probeIndexRef.current = 0;
      probeScheduledRef.current = false;
      stopReasonRef.current = null;
      windowStartedAtRef.current = Date.now();

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = async () => {
        const reason = stopReasonRef.current;
        if (matchedRef.current || !mountedRef.current) return;
        if (reason === "rotate") {
          startWindow();
          return;
        }
        await runProbe(true);
      };
      recorder.onerror = () => finishWithError("The browser stopped recording unexpectedly.");
      recorderRef.current = recorder;
      recorder.start(1000);
    };

    const rotateWindow = () => {
      const recorder = recorderRef.current;
      if (!recorder || recorder.state !== "recording" || matchedRef.current) return;
      stopReasonRef.current = "rotate";
      try { recorder.requestData(); } catch { /* stop() performs the final flush */ }
      recorder.stop();
    };

    try {
      startWindow();
      setState("listening");
    } catch {
      finishWithError("The browser couldn't start recording. Check microphone permissions and try again.");
    } finally {
      startingRef.current = false;
    }

    timerRef.current = setInterval(() => {
      if (!mountedRef.current || matchedRef.current) return;
      const recorder = recorderRef.current;
      if (!recorder || recorder.state !== "recording") return;
      const elapsed = (Date.now() - windowStartedAtRef.current) / 1000;
      const nextProbe = PROBE_SECONDS[probeIndexRef.current];

      if (nextProbe && elapsed >= nextProbe && !probeScheduledRef.current && !inFlightProbeRef.current) {
        probeIndexRef.current += 1;
        probeScheduledRef.current = true;
        try { recorder.requestData(); } catch { probeScheduledRef.current = false; }
        setTimeout(async () => {
          if (!mountedRef.current || matchedRef.current || stopReasonRef.current === "manual") return;
          await runProbe(false);
          probeScheduledRef.current = false;
          if ((Date.now() - windowStartedAtRef.current) / 1000 >= WINDOW_SECONDS) rotateWindow();
        }, 180);
      } else if (
        elapsed >= WINDOW_SECONDS &&
        !probeScheduledRef.current &&
        !inFlightProbeRef.current
      ) {
        rotateWindow();
      }
    }, 500);
  }, [cleanup, onIdentified]);

  const reset = useCallback(() => {
    identifyAbortRef.current?.abort();
    identifyAbortRef.current = null;
    cleanup();
    setState("idle");
    setError(null);
  }, [cleanup]);

  return { state, error, start, stop, reset };
}

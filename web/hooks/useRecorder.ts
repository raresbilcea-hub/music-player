"use client";

// Microphone recording for song identification (Shazam-style).
// State machine mirrors the mobile app's record flow:
//   idle -> listening (10s auto-stop) -> identifying -> identified | error
//
// iOS Safari constraints handled here:
//   - getUserMedia + MediaRecorder must be created inside the user's tap
//     handler (a user gesture), never from an effect or timer.
//   - iOS Safari records audio/mp4 (AAC); Chrome/Android records audio/webm.
//     We send whichever mimeType was actually used to the server.

import { useCallback, useRef, useState } from "react";
import { identifyRecording, type IdentifyResult } from "../lib/api";

export type RecorderState =
  | "idle"
  | "listening"
  | "identifying"
  | "identified"
  | "error";

const RECORD_SECONDS = 10;

function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const t of ["audio/webm", "audio/mp4", "audio/ogg"]) {
    if (MediaRecorder.isTypeSupported(t)) return t;
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
  const [secondsLeft, setSecondsLeft] = useState(RECORD_SECONDS);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const cleanup = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
  }, []);

  const stop = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state === "recording") rec.stop();
  }, []);

  const start = useCallback(async () => {
    setError(null);
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      setError("Recording isn't supported in this browser.");
      setState("error");
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError("Microphone access was denied. Allow it in your browser settings and try again.");
      setState("error");
      return;
    }

    const mimeType = pickMimeType();
    const recorder = mimeType
      ? new MediaRecorder(stream, { mimeType })
      : new MediaRecorder(stream);

    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = async () => {
      cleanup();
      setState("identifying");
      try {
        const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" });
        const base64 = await blobToBase64(blob);
        const result = await identifyRecording(base64, blob.type);
        setState("identified");
        onIdentified(result);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Something went wrong while identifying.");
        setState("error");
      }
    };

    recorderRef.current = recorder;
    streamRef.current = stream;
    recorder.start();
    setState("listening");
    setSecondsLeft(RECORD_SECONDS);

    let remaining = RECORD_SECONDS;
    timerRef.current = setInterval(() => {
      remaining -= 1;
      setSecondsLeft(remaining);
      if (remaining <= 0) stop();
    }, 1000);
  }, [cleanup, onIdentified, stop]);

  const reset = useCallback(() => {
    cleanup();
    setState("idle");
    setError(null);
    setSecondsLeft(RECORD_SECONDS);
  }, [cleanup]);

  return { state, error, secondsLeft, start, stop, reset };
}
